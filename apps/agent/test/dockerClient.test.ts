import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  type ContainerSpec,
  DockerClient,
  type DockerClientShape,
} from "../src/DockerClient";

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** Кадр мультиплексированного потока Docker (stdout=1, stderr=2). */
const frame = (stream: 1 | 2, text: string) => {
  const payload = new TextEncoder().encode(text);
  const header = new Uint8Array(8);
  header[0] = stream;
  new DataView(header.buffer).setUint32(4, payload.length);
  return Buffer.concat([header, payload]);
};

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let docker: DockerClientShape;
let recorded: Array<Recorded> = [];
/** Ответ фейкового dockerd на запрос (`METHOD /path?query`). */
let respond: (key: string) => Response = () => new Response(null);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-agent-docker-"));
  const unix = join(dir, "docker.sock");
  server = Bun.serve({
    unix,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      recorded.push({
        method: request.method,
        path: url.pathname + url.search,
        body: text === "" ? undefined : JSON.parse(text),
      });
      return respond(`${request.method} ${url.pathname}${url.search}`);
    },
  });
  docker = DockerClient.make(unix);
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E>) => {
  recorded = [];
  return Effect.runPromise(effect);
};

const runError = <A, E>(effect: Effect.Effect<A, E>) =>
  run(Effect.flip(effect));

const spec: ContainerSpec = {
  name: "cg-session-s1",
  image: "cg-session:550.163.01",
  env: { CG_APP_ID: "1794680", SELKIES_WEBRTC_UDP_MUX_PORT: "59001" },
  labels: { "cg.session": "s1", "cg.slot": "1", "cg.app": "1794680" },
  network: "cg-sessions",
  udpPorts: [59001],
  binds: ["cg-home-u1:/home/ubuntu", "/lib/a.so:/usr/lib/b.so:ro"],
  runtime: "nvidia",
  gpus: true,
  shmSizeBytes: 2147483648,
};

describe("DockerClient", () => {
  it("createAndStart posts create then start", async () => {
    respond = (key) =>
      key.startsWith("POST /v1.47/containers/create")
        ? Response.json({ Id: "abc123", Warnings: [] }, { status: 201 })
        : new Response(null, { status: 204 });
    expect(await run(docker.createAndStart(spec))).toBe("abc123");
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1.47/containers/create?name=cg-session-s1",
      "POST /v1.47/containers/abc123/start",
    ]);
    expect(recorded[0]?.body).toEqual({
      Image: "cg-session:550.163.01",
      Env: ["CG_APP_ID=1794680", "SELKIES_WEBRTC_UDP_MUX_PORT=59001"],
      Labels: { "cg.session": "s1", "cg.slot": "1", "cg.app": "1794680" },
      ExposedPorts: { "59001/udp": {} },
      HostConfig: {
        Runtime: "nvidia",
        DeviceRequests: [{ Driver: "", Count: -1, Capabilities: [["gpu"]] }],
        ShmSize: 2147483648,
        Binds: ["cg-home-u1:/home/ubuntu", "/lib/a.so:/usr/lib/b.so:ro"],
        PortBindings: { "59001/udp": [{ HostIp: "", HostPort: "59001" }] },
        NetworkMode: "cg-sessions",
        RestartPolicy: { Name: "no" },
      },
      NetworkingConfig: { EndpointsConfig: { "cg-sessions": {} } },
    });
  });

  it("failed start removes the created container and fails with the docker message", async () => {
    respond = (key) => {
      if (key.startsWith("POST /v1.47/containers/create"))
        return Response.json({ Id: "abc123" }, { status: 201 });
      if (key.startsWith("POST /v1.47/containers/abc123/start"))
        return Response.json(
          { message: "port is already allocated" },
          { status: 500 },
        );
      return new Response(null, { status: 204 });
    };
    const error = await runError(docker.createAndStart(spec));
    expect(error._tag).toBe("DockerError");
    expect(error.status).toBe(500);
    expect(error.message).toContain("port is already allocated");
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1.47/containers/create?name=cg-session-s1",
      "POST /v1.47/containers/abc123/start",
      "DELETE /v1.47/containers/abc123?force=true",
    ]);
  });

  it("exec returns exit code and stdout", async () => {
    respond = (key) => {
      if (key === "POST /v1.47/containers/cg-session-s1/exec")
        return Response.json({ Id: "e1" }, { status: 201 });
      if (key === "POST /v1.47/exec/e1/start")
        return new Response(
          Buffer.concat([
            frame(1, "12"),
            frame(2, "warning\n"),
            frame(1, "34\n"),
          ]),
          {
            headers: {
              "content-type": "application/vnd.docker.multiplexed-stream",
            },
          },
        );
      if (key === "GET /v1.47/exec/e1/json")
        return Response.json({ ExitCode: 3, Running: false });
      return new Response(null, { status: 404 });
    };
    expect(
      await run(docker.exec("cg-session-s1", ["pgrep", "-f", "x"])),
    ).toEqual({ exitCode: 3, stdout: "1234\n" });
    expect(recorded[0]?.body).toEqual({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["pgrep", "-f", "x"],
    });
    expect(recorded[1]?.body).toEqual({ Detach: false, Tty: false });
  });

  it("exec on a stopped container fails with status 409", async () => {
    respond = () =>
      Response.json(
        { message: "container cg-session-s1 is not running" },
        { status: 409 },
      );
    const error = await runError(docker.exec("cg-session-s1", ["true"]));
    expect(error.status).toBe(409);
    expect(error.message).toContain("is not running");
  });

  it("logs demultiplexes stdout and stderr", async () => {
    respond = () =>
      new Response(
        Buffer.concat([frame(1, "a\n"), frame(2, "GPU: x\n"), frame(1, "b\n")]),
      );
    expect(await run(docker.logs("cg-session-s1"))).toBe("a\nGPU: x\nb\n");
    expect(recorded[0]?.path).toBe(
      "/v1.47/containers/cg-session-s1/logs?stdout=true&stderr=true",
    );
  });

  it("listByLabel lists all containers with that label", async () => {
    respond = () =>
      Response.json([
        {
          Id: "1",
          Names: ["/cg-session-a"],
          Labels: { "cg.session": "a" },
          State: "running",
        },
        {
          Id: "2",
          Names: ["/cg-session-b"],
          Labels: { "cg.session": "b" },
          State: "exited",
        },
      ]);
    expect(await run(docker.listByLabel("cg.session"))).toEqual([
      {
        name: "cg-session-a",
        labels: { "cg.session": "a" },
        running: true,
      },
      {
        name: "cg-session-b",
        labels: { "cg.session": "b" },
        running: false,
      },
    ]);
    const path = recorded[0]?.path ?? "";
    const url = new URL(`http://docker${path}`);
    expect(url.pathname).toBe("/v1.47/containers/json");
    expect(url.searchParams.get("all")).toBe("true");
    expect(JSON.parse(url.searchParams.get("filters") ?? "")).toEqual({
      label: ["cg.session"],
    });
  });

  it("stop and remove treat an already stopped or missing container as done", async () => {
    respond = (key) =>
      key.startsWith("POST")
        ? new Response(null, { status: 304 })
        : Response.json({ message: "No such container" }, { status: 404 });
    await run(docker.stop("cg-session-s1", 15));
    expect(recorded[0]?.path).toBe("/v1.47/containers/cg-session-s1/stop?t=15");
    await run(docker.remove("cg-session-s1"));
    expect(recorded[0]).toEqual({
      method: "DELETE",
      path: "/v1.47/containers/cg-session-s1?force=true",
      body: undefined,
    });
  });
});
