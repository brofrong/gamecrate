import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { AgentConfig } from "../src/config";
import {
  type ContainerSpec,
  DockerClient,
  type DockerClientShape,
  volumeBody,
} from "../src/DockerClient";
import { cleanup, layers, prepare, sessionLayers } from "../src/Overlay";
import { testConfig, unusedDocker } from "./fakes";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cg-overlay-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const config = () => testConfig({ scratchDir: scratch });

/** Фейковый dockerd: журнал вызовов, созданные тома и контейнеры. */
const makeDocker = (helperExit = 0) => {
  const calls: Array<string> = [];
  const created: Array<ContainerSpec> = [];
  const volumes: Array<Parameters<DockerClientShape["createVolume"]>[0]> = [];
  const shape: DockerClientShape = {
    ...unusedDocker,
    createVolume: (volume) =>
      Effect.sync(() => {
        calls.push(`createVolume ${volume.name}`);
        volumes.push(volume);
      }),
    removeVolume: (name) =>
      Effect.sync(() => void calls.push(`removeVolume ${name}`)),
    create: (spec) =>
      Effect.sync(() => {
        calls.push(`create ${spec.name}`);
        created.push(spec);
        return `id-${spec.name}`;
      }),
    start: (name) => Effect.sync(() => void calls.push(`start ${name}`)),
    wait: (name) =>
      Effect.sync(() => {
        calls.push(`wait ${name}`);
        return helperExit;
      }),
    remove: (name) => Effect.sync(() => void calls.push(`remove ${name}`)),
  };
  return { calls, created, volumes, shape };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, DockerClient | AgentConfig>,
  docker: DockerClientShape,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DockerClient, docker),
          Layer.succeed(AgentConfig, config()),
        ),
      ),
    ),
  );

describe("Overlay", () => {
  it("sessionLayers puts upper/work under SCRATCH_DIR/<id>", () => {
    expect(sessionLayers(config(), "s1")).toEqual({
      id: "s1",
      prefix: "cg-s",
      root: scratch,
      dir: `${scratch}/s1`,
      labels: { "cg.session": "s1" },
      client: {
        volume: "cg-s-s1-client",
        lower: "/raid/cloud-gaming/steam-client",
        upper: `${scratch}/s1/client/upper`,
        work: `${scratch}/s1/client/work`,
      },
      apps: {
        volume: "cg-s-s1-apps",
        lower: "/raid/cloud-gaming/library/steamapps",
        upper: `${scratch}/s1/apps/upper`,
        work: `${scratch}/s1/apps/work`,
      },
    });
    // Обобщённо: другой корень и префикс (установщик, Task 4).
    const install = layers(config(), {
      root: "/x/install",
      prefix: "cg-i",
      id: "j1",
      labels: { "cg.install": "j1" },
    });
    expect(install.client.volume).toBe("cg-i-j1-client");
    expect(install.apps.upper).toBe("/x/install/j1/apps/upper");
  });

  it("createVolume body carries overlay options", () => {
    expect(
      volumeBody({
        name: "cg-s-s1-apps",
        labels: { "cg.session": "s1" },
        overlay: {
          lower: "/lib/steamapps",
          upper: "/scratch/s1/apps/upper",
          work: "/scratch/s1/apps/work",
        },
      }),
    ).toEqual({
      Name: "cg-s-s1-apps",
      Driver: "local",
      DriverOpts: {
        type: "overlay",
        device: "overlay",
        o: "lowerdir=/lib/steamapps,upperdir=/scratch/s1/apps/upper,workdir=/scratch/s1/apps/work",
      },
      Labels: { "cg.session": "s1" },
    });
  });

  it("prepare makes upper/work dirs and labelled overlay volumes", async () => {
    const docker = makeDocker();
    const target = sessionLayers(config(), "s1");
    await run(prepare(target), docker.shape);
    for (const layer of ["client", "apps"])
      for (const dir of ["upper", "work"])
        expect(existsSync(join(scratch, "s1", layer, dir))).toBe(true);
    expect(docker.volumes).toEqual([
      {
        name: "cg-s-s1-client",
        labels: { "cg.session": "s1" },
        overlay: {
          lower: "/raid/cloud-gaming/steam-client",
          upper: `${scratch}/s1/client/upper`,
          work: `${scratch}/s1/client/work`,
        },
      },
      {
        name: "cg-s-s1-apps",
        labels: { "cg.session": "s1" },
        overlay: {
          lower: "/raid/cloud-gaming/library/steamapps",
          upper: `${scratch}/s1/apps/upper`,
          work: `${scratch}/s1/apps/work`,
        },
      },
    ]);
  });

  it("cleanup removes volumes, then scratch via a root helper container", async () => {
    const docker = makeDocker();
    mkdirSync(join(scratch, "s1", "client", "work"), { recursive: true });
    await run(cleanup(sessionLayers(config(), "s1")), docker.shape);
    expect(docker.calls).toEqual([
      "removeVolume cg-s-s1-client",
      "removeVolume cg-s-s1-apps",
      "remove cg-s-s1-cleanup",
      "create cg-s-s1-cleanup",
      "start cg-s-s1-cleanup",
      "wait cg-s-s1-cleanup",
      "remove cg-s-s1-cleanup",
    ]);
    expect(docker.created).toEqual([
      {
        name: "cg-s-s1-cleanup",
        image: "cg-session:550.163.01",
        env: {},
        labels: { "cg.helper": "cleanup" },
        network: "none",
        udpPorts: [],
        binds: [`${scratch}:${scratch}`],
        mounts: [],
        runtime: "runc",
        gpus: false,
        shmSizeBytes: 64 * 1024 * 1024,
        securityOpt: ["no-new-privileges:true"],
        tmpfs: {},
        // work/work создаёт ядро от root с правами 000: агенту (uid 1000) не удалить.
        user: "0",
        entrypoint: ["rm", "-rf", `${scratch}/s1`],
      },
    ]);
  });

  it("cleanup without a scratch dir only removes volumes", async () => {
    const docker = makeDocker();
    await run(cleanup(sessionLayers(config(), "s1")), docker.shape);
    expect(docker.calls).toEqual([
      "removeVolume cg-s-s1-client",
      "removeVolume cg-s-s1-apps",
    ]);
  });

  it("failed scratch removal is an error", async () => {
    const docker = makeDocker(1);
    mkdirSync(join(scratch, "s1"), { recursive: true });
    const error = await Effect.runPromise(
      Effect.flip(cleanup(sessionLayers(config(), "s1"))).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DockerClient, docker.shape),
            Layer.succeed(AgentConfig, config()),
          ),
        ),
      ),
    );
    expect(error._tag).toBe("OverlayError");
    // Помощник всё равно убран.
    expect(docker.calls.at(-1)).toBe("remove cg-s-s1-cleanup");
  });
});
