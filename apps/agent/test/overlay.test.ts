import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { AgentConfig } from "../src/config";
import { isValidId } from "../src/ids";
import {
  type ContainerSpec,
  DockerClient,
  type DockerClientShape,
  volumeBody,
} from "../src/DockerClient";
import {
  cleanup,
  INSTALL_CLIENT_DIR,
  installLayers,
  layers,
  prepare,
  sessionLayers,
  unmarkVolatile,
} from "../src/Overlay";
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
      labels: { "cg.session": "s1" },
      scratch: [{ root: scratch, dir: `${scratch}/s1` }],
      client: {
        volume: "cg-s-s1-client",
        lower: "/raid/cloud-gaming/steam-client",
        upper: `${scratch}/s1/client/upper`,
        work: `${scratch}/s1/client/work`,
        volatile: true,
      },
      apps: {
        volume: "cg-s-s1-apps",
        lower: "/raid/cloud-gaming/library/steamapps",
        upper: `${scratch}/s1/apps/upper`,
        work: `${scratch}/s1/apps/work`,
        volatile: true,
      },
    });
    // Обобщённо: другие корни слоёв и префикс.
    const custom = layers(config(), {
      roots: { client: "/x/client", apps: "/x/install" },
      prefix: "cg-x",
      id: "j1",
      labels: { "cg.x": "j1" },
      volatile: { client: true, apps: false },
    });
    expect(custom.client.volume).toBe("cg-x-j1-client");
    expect(custom.client.upper).toBe("/x/client/j1/client/upper");
    expect(custom.apps.upper).toBe("/x/install/j1/apps/upper");
    expect([custom.client.volatile, custom.apps.volatile]).toEqual([
      true,
      false,
    ]);
    expect(custom.scratch).toEqual([
      { root: "/x/client", dir: "/x/client/j1" },
      { root: "/x/install", dir: "/x/install/j1" },
    ]);
  });

  it("installLayers: client on SCRATCH_DIR/.install (NVMe), apps on INSTALL_SCRATCH_DIR (library FS)", () => {
    expect(INSTALL_CLIENT_DIR).toBe(".install");
    const install = join(scratch, "..", "install-scratch");
    const cfg = testConfig({
      scratchDir: scratch,
      installScratchDir: Option.some(install),
    });
    expect(installLayers(cfg, "j1")).toEqual({
      id: "j1",
      prefix: "cg-i",
      labels: { "cg.install": "j1" },
      scratch: [
        { root: `${scratch}/.install`, dir: `${scratch}/.install/j1` },
        { root: install, dir: `${install}/j1` },
      ],
      client: {
        volume: "cg-i-j1-client",
        lower: "/raid/cloud-gaming/steam-client",
        upper: `${scratch}/.install/j1/client/upper`,
        work: `${scratch}/.install/j1/client/work`,
        volatile: true,
      },
      apps: {
        volume: "cg-i-j1-apps",
        lower: "/raid/cloud-gaming/library/steamapps",
        upper: `${install}/j1/apps/upper`,
        work: `${install}/j1/apps/work`,
        volatile: false,
      },
    });
    // Каталог установщика под SCRATCH_DIR — не id сессии: уборка сессий его пропускает.
    expect(isValidId(INSTALL_CLIENT_DIR)).toBe(false);
    expect(() =>
      installLayers(testConfig({ scratchDir: scratch }), "j1"),
    ).toThrow("INSTALL_SCRATCH_DIR is not set");
  });

  it("installLayers: volatile client, durable apps", () => {
    // apps установщика переносится rename-ом в общую библиотеку: без fsync
    // после сбоя хоста там оказалась бы битая игра.
    const overlays = installLayers(
      testConfig({
        scratchDir: scratch,
        installScratchDir: Option.some("/raid/install-scratch"),
      }),
      "j1",
    );
    expect(overlays.client.volatile).toBe(true);
    expect(overlays.apps.volatile).toBe(false);
  });

  it("cleanup of install layers removes both scratch dirs with one root helper", async () => {
    const docker = makeDocker();
    const install = mkdtempSync(join(tmpdir(), "cg-overlay-install-"));
    try {
      const overlays = installLayers(
        testConfig({
          scratchDir: scratch,
          installScratchDir: Option.some(install),
        }),
        "j1",
      );
      mkdirSync(overlays.client.work, { recursive: true });
      mkdirSync(overlays.apps.work, { recursive: true });
      await run(cleanup(overlays), docker.shape);
      expect(docker.calls).toEqual([
        "removeVolume cg-i-j1-client",
        "removeVolume cg-i-j1-apps",
        "remove cg-i-j1-cleanup",
        "create cg-i-j1-cleanup",
        "start cg-i-j1-cleanup",
        "wait cg-i-j1-cleanup",
        "remove cg-i-j1-cleanup",
      ]);
      expect(docker.created[0]?.binds).toEqual([
        `${scratch}/.install:${scratch}/.install`,
        `${install}:${install}`,
      ]);
      expect(docker.created[0]?.entrypoint).toEqual([
        "rm",
        "-rf",
        `${scratch}/.install/j1`,
        `${install}/j1`,
      ]);
      // Только один из каталогов есть — удаляется только он.
      const only = makeDocker();
      rmSync(join(scratch, ".install", "j1"), { recursive: true });
      await run(cleanup(overlays), only.shape);
      expect(only.created[0]?.entrypoint).toEqual([
        "rm",
        "-rf",
        `${install}/j1`,
      ]);
      expect(only.created[0]?.binds).toEqual([`${install}:${install}`]);
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
  });

  it("layers rejects ids and prefixes that could escape the scratch root", () => {
    for (const id of ["../x", "", "a/b", ".", "..", "a b", "x".repeat(65)])
      expect(() => sessionLayers(config(), id)).toThrow("invalid overlay id");
    expect(() =>
      layers(config(), {
        roots: { client: scratch, apps: scratch },
        prefix: "cg/s",
        id: "j1",
        labels: {},
        volatile: { client: true, apps: true },
      }),
    ).toThrow("invalid overlay prefix");
  });

  it("cleanup refuses a hand-made layer set outside its root", async () => {
    const docker = makeDocker();
    const forged = {
      ...sessionLayers(config(), "s1"),
      scratch: [{ root: scratch, dir: "/" }],
    };
    const error = await Effect.runPromise(
      Effect.flip(cleanup(forged)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DockerClient, docker.shape),
            Layer.succeed(AgentConfig, config()),
          ),
        ),
      ),
    );
    expect(error._tag).toBe("OverlayError");
    expect(docker.calls).toEqual([]);
    // Подделан только второй каталог (установщик) — тоже отказ до любых вызовов.
    const install = installLayers(
      testConfig({
        scratchDir: scratch,
        installScratchDir: Option.some("/x/install"),
      }),
      "j1",
    );
    const forgedInstall = {
      ...install,
      scratch: [install.scratch[0], { root: "/x/install", dir: "/x" }],
    };
    const error2 = await Effect.runPromise(
      Effect.flip(cleanup(forgedInstall as typeof install)).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DockerClient, docker.shape),
            Layer.succeed(AgentConfig, config()),
          ),
        ),
      ),
    );
    expect(error2._tag).toBe("OverlayError");
    expect(docker.calls).toEqual([]);
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
          volatile: false,
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

  it("createVolume body adds volatile", () => {
    expect(
      volumeBody({
        name: "cg-s-s1-apps",
        labels: { "cg.session": "s1" },
        overlay: {
          lower: "/lib/steamapps",
          upper: "/scratch/s1/apps/upper",
          work: "/scratch/s1/apps/work",
          volatile: true,
        },
      }).DriverOpts.o,
    ).toBe(
      "lowerdir=/lib/steamapps,upperdir=/scratch/s1/apps/upper,workdir=/scratch/s1/apps/work,volatile",
    );
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
          volatile: true,
        },
      },
      {
        name: "cg-s-s1-apps",
        labels: { "cg.session": "s1" },
        overlay: {
          lower: "/raid/cloud-gaming/library/steamapps",
          upper: `${scratch}/s1/apps/upper`,
          work: `${scratch}/s1/apps/work`,
          volatile: true,
        },
      },
    ]);
  });

  it("unmarkVolatile syncs scratch and removes incompat markers with one root helper", async () => {
    const docker = makeDocker();
    mkdirSync(join(scratch, "s1", "client", "work"), { recursive: true });
    await run(unmarkVolatile(sessionLayers(config(), "s1")), docker.shape);
    expect(docker.calls).toEqual([
      "remove cg-s-s1-unmark",
      "create cg-s-s1-unmark",
      "start cg-s-s1-unmark",
      "wait cg-s-s1-unmark",
      "remove cg-s-s1-unmark",
    ]);
    expect(docker.created).toHaveLength(1);
    expect(docker.created[0]).toMatchObject({
      name: "cg-s-s1-unmark",
      labels: { "cg.helper": "unmark" },
      network: "none",
      // Метку `work/incompat` ядро создаёт от root с правами 000.
      user: "0",
      binds: [`${scratch}:${scratch}`],
      entrypoint: [
        "sh",
        "-c",
        'sync -f "$1" && shift && rm -rf -- "$@"',
        "unmark",
        `${scratch}/s1`,
        `${scratch}/s1/client/work/work/incompat`,
        `${scratch}/s1/apps/work/work/incompat`,
      ],
    });
  });

  it("unmarkVolatile skips non-volatile layers", async () => {
    const docker = makeDocker();
    const install = mkdtempSync(join(tmpdir(), "cg-overlay-install-"));
    try {
      mkdirSync(join(scratch, INSTALL_CLIENT_DIR, "j1"), { recursive: true });
      mkdirSync(join(install, "j1"), { recursive: true });
      await run(
        unmarkVolatile(
          installLayers(
            testConfig({
              scratchDir: scratch,
              installScratchDir: Option.some(install),
            }),
            "j1",
          ),
        ),
        docker.shape,
      );
      expect(docker.created[0]?.entrypoint).toEqual([
        "sh",
        "-c",
        'sync -f "$1" && shift && rm -rf -- "$@"',
        "unmark",
        `${scratch}/${INSTALL_CLIENT_DIR}/j1`,
        `${scratch}/${INSTALL_CLIENT_DIR}/j1/client/work/work/incompat`,
      ]);
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
  });

  it("unmarkVolatile without a scratch dir runs nothing", async () => {
    const docker = makeDocker();
    await run(unmarkVolatile(sessionLayers(config(), "s1")), docker.shape);
    expect(docker.calls).toEqual([]);
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
