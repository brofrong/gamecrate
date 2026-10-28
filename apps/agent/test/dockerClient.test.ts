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
  readonly contentType: string | null;
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
      const contentType = request.headers.get("content-type");
      const bytes = new Uint8Array(await request.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      recorded.push({
        method: request.method,
        path: url.pathname + url.search,
        body:
          contentType === "application/x-tar"
            ? bytes
            : text === ""
              ? undefined
              : JSON.parse(text),
        contentType,
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
  binds: ["/lib/a.so:/usr/lib/b.so:ro"],
  mounts: [
    { volume: "cg-s-s1-client", target: "/home/ubuntu/.local/share/Steam" },
    {
      volume: "cg-home-u1",
      target: "/home/ubuntu",
      readOnly: true,
    },
  ],
  runtime: "nvidia",
  gpus: true,
  shmSizeBytes: 2147483648,
  securityOpt: ["no-new-privileges:true"],
  tmpfs: { "/dev/input": "mode=1777" },
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
        Binds: ["/lib/a.so:/usr/lib/b.so:ro"],
        Mounts: [
          // NoCopy: Docker не копирует содержимое образа в пустой том (старый
          // cg-home-* только читается, в overlay-тома образ не пишется).
          {
            Type: "volume",
            Source: "cg-s-s1-client",
            Target: "/home/ubuntu/.local/share/Steam",
            ReadOnly: false,
            VolumeOptions: { NoCopy: true },
          },
          {
            Type: "volume",
            Source: "cg-home-u1",
            Target: "/home/ubuntu",
            ReadOnly: true,
            VolumeOptions: { NoCopy: true },
          },
        ],
        PortBindings: { "59001/udp": [{ HostIp: "", HostPort: "59001" }] },
        NetworkMode: "cg-sessions",
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges:true"],
        Tmpfs: { "/dev/input": "mode=1777" },
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

  it("exec and getArchive take a longer timeout for slow steps", async () => {
    respond = (key) => {
      if (key === "POST /v1.47/containers/c/exec")
        return Response.json({ Id: "e2" }, { status: 201 });
      if (key === "GET /v1.47/exec/e2/json")
        return Response.json({ ExitCode: 0 });
      return new Response(new Uint8Array(), { status: 200 });
    };
    const slow = (key: string) =>
      key === "POST /v1.47/exec/e2/start" || key.startsWith("GET");
    const base = respond;
    respond = (key) =>
      slow(key)
        ? (Bun.sleep(150).then(() => base(key)) as unknown as Response)
        : base(key);
    const timedOut = await runError(
      docker.exec("c", ["true"], { timeout: "20 millis" }),
    );
    expect(timedOut.message).toBe("timeout");
    expect(
      await run(docker.exec("c", ["true"], { timeout: "5 seconds" })),
    ).toEqual({ exitCode: 0, stdout: "" });
    const archive = await runError(
      docker.getArchive("c", "/tmp/x", { timeout: "20 millis" }),
    );
    expect(archive.message).toBe("timeout");
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
      contentType: null,
    });
  });
  it("inspect returns labels, a missing container is undefined", async () => {
    respond = (key) =>
      key === "GET /v1.47/containers/cg-session-a/json"
        ? Response.json({
            Name: "/cg-session-a",
            Config: { Labels: { "cg.session": "a" } },
            State: { Running: true },
          })
        : Response.json({ message: "No such container" }, { status: 404 });
    expect(await run(docker.inspect("cg-session-a"))).toEqual({
      name: "cg-session-a",
      labels: { "cg.session": "a" },
      running: true,
    });
    expect(await run(docker.inspect("cg-session-b"))).toBeUndefined();
  });

  it("does not follow redirects from the socket", async () => {
    respond = (key) =>
      key.startsWith("DELETE")
        ? Response.redirect("http://docker/v1.47/elsewhere", 307)
        : new Response(null, { status: 204 });
    const error = await runError(docker.remove("cg-session-s1"));
    expect(error._tag).toBe("DockerError");
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /v1.47/containers/cg-session-s1?force=true",
    ]);
  });
  it("create does not start; entrypoint, cmd and user go into the body", async () => {
    respond = (key) =>
      key.startsWith("POST /v1.47/containers/create")
        ? Response.json({ Id: "h1" }, { status: 201 })
        : new Response(null, { status: 204 });
    const helper: ContainerSpec = {
      ...spec,
      name: "cg-import-s1",
      network: "none",
      udpPorts: [],
      gpus: false,
      entrypoint: ["/usr/local/bin/cg-profile-pack"],
      cmd: ["--list"],
      user: "1000",
    };
    expect(await run(docker.create(helper))).toBe("h1");
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1.47/containers/create?name=cg-import-s1",
    ]);
    const body = recorded[0]?.body as Record<string, unknown>;
    expect(body.Entrypoint).toEqual(["/usr/local/bin/cg-profile-pack"]);
    expect(body.Cmd).toEqual(["--list"]);
    expect(body.User).toBe("1000");
    expect(body.NetworkingConfig).toEqual({
      EndpointsConfig: { none: {} },
    });
    // Без entrypoint/cmd/user — ключей нет (остаются значения образа).
    await run(docker.create(spec));
    expect(Object.keys(recorded[0]?.body as object)).not.toContain(
      "Entrypoint",
    );
    expect(Object.keys(recorded[0]?.body as object)).not.toContain("User");
  });

  it("start and wait", async () => {
    respond = (key) =>
      key === "POST /v1.47/containers/cg-import-s1/wait"
        ? Response.json({ StatusCode: 3 })
        : new Response(null, { status: 204 });
    await run(docker.start("cg-import-s1"));
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1.47/containers/cg-import-s1/start",
    ]);
    expect(await run(docker.wait("cg-import-s1"))).toBe(3);
  });

  it("createVolume posts an overlay local volume", async () => {
    respond = () => Response.json({ Name: "cg-s-s1-apps" }, { status: 201 });
    await run(
      docker.createVolume({
        name: "cg-s-s1-apps",
        labels: { "cg.session": "s1" },
        overlay: {
          lower: "/l",
          upper: "/u",
          work: "/w",
          volatile: true,
          metacopy: true,
        },
      }),
    );
    expect(recorded).toEqual([
      {
        method: "POST",
        path: "/v1.47/volumes/create",
        body: {
          Name: "cg-s-s1-apps",
          Driver: "local",
          DriverOpts: {
            type: "overlay",
            device: "overlay",
            o: "lowerdir=/l,upperdir=/u,workdir=/w,volatile,metacopy=on",
          },
          Labels: { "cg.session": "s1" },
        },
        contentType: "application/json",
      },
    ]);
  });

  it("removeVolume treats a missing volume as done, a volume in use is an error", async () => {
    respond = (key) =>
      key === "DELETE /v1.47/volumes/gone"
        ? Response.json({ message: "no such volume" }, { status: 404 })
        : Response.json({ message: "volume is in use" }, { status: 409 });
    await run(docker.removeVolume("gone"));
    const error = await runError(docker.removeVolume("busy"));
    expect(error.status).toBe(409);
    expect(recorded[0]?.path).toBe("/v1.47/volumes/busy");
  });

  it("volumeExists and listVolumes", async () => {
    respond = (key) => {
      if (key === "GET /v1.47/volumes/cg-home-u1")
        return Response.json({ Name: "cg-home-u1" });
      if (key.startsWith("GET /v1.47/volumes?"))
        return Response.json({
          Volumes: [
            { Name: "cg-s-a-client", Labels: { "cg.session": "a" } },
            { Name: "cg-s-a-apps", Labels: null },
          ],
          Warnings: null,
        });
      return Response.json({ message: "no such volume" }, { status: 404 });
    };
    expect(await run(docker.volumeExists("cg-home-u1"))).toBe(true);
    expect(await run(docker.volumeExists("cg-home-u2"))).toBe(false);
    expect(await run(docker.listVolumes("cg.session"))).toEqual([
      { name: "cg-s-a-client", labels: { "cg.session": "a" } },
      { name: "cg-s-a-apps", labels: {} },
    ]);
    const url = new URL(`http://docker${recorded[0]?.path}`);
    expect(url.pathname).toBe("/v1.47/volumes");
    expect(JSON.parse(url.searchParams.get("filters") ?? "")).toEqual({
      label: ["cg.session"],
    });
  });

  it("putArchive uploads a tar, getArchive downloads one", async () => {
    const tar = new Uint8Array([1, 2, 3, 0, 255]);
    respond = (key) =>
      key.startsWith("GET")
        ? new Response(new Uint8Array([9, 8, 7]), {
            headers: { "content-type": "application/x-tar" },
          })
        : new Response(null, { status: 200 });
    await run(docker.putArchive("cg-session-s1", "/home/ubuntu", tar));
    expect(recorded).toEqual([
      {
        method: "PUT",
        path: "/v1.47/containers/cg-session-s1/archive?path=%2Fhome%2Fubuntu",
        body: tar,
        contentType: "application/x-tar",
      },
    ]);
    expect(
      await run(docker.getArchive("cg-import-s1", "/tmp/cg-profile.tar")),
    ).toEqual(new Uint8Array([9, 8, 7]));
    expect(recorded[0]?.path).toBe(
      "/v1.47/containers/cg-import-s1/archive?path=%2Ftmp%2Fcg-profile.tar",
    );
  });

  it("archiveSize reads the size from the path stat header (HEAD)", async () => {
    const stat = Buffer.from(
      JSON.stringify({
        name: "cg-profile.tar",
        size: 209715201,
        mode: 420,
        mtime: "2026-10-22T10:00:00Z",
        linkTarget: "",
      }),
    ).toString("base64");
    respond = () =>
      new Response(null, {
        headers: { "x-docker-container-path-stat": stat },
      });
    expect(
      await run(docker.archiveSize("cg-session-s1", "/tmp/cg-profile.tar")),
    ).toBe(209715201);
    expect(recorded).toEqual([
      {
        method: "HEAD",
        path: "/v1.47/containers/cg-session-s1/archive?path=%2Ftmp%2Fcg-profile.tar",
        body: undefined,
        contentType: null,
      },
    ]);

    respond = () => new Response(null);
    const missing = await runError(
      docker.archiveSize("cg-session-s1", "/tmp/cg-profile.tar"),
    );
    expect(missing.operation).toBe("archiveSize");

    respond = () => new Response(null, { status: 404 });
    const gone = await runError(
      docker.archiveSize("cg-session-s1", "/tmp/cg-profile.tar"),
    );
    expect(gone.status).toBe(404);
  });
});
