import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  References,
} from "effect";
import { AgentConfig, type AgentConfigValues } from "../src/config";
import {
  type ContainerInfo,
  type ContainerSpec,
  DockerClient,
  type DockerClientShape,
} from "../src/DockerClient";
import { FreeSpace } from "../src/DiskSpace";
import { STEAM_DIR, STEAMAPPS_DIR } from "../src/Overlay";
import {
  hasWindowsExe,
  playerDataIn,
  PrefixTemplates,
  prefixTemplatesLayer,
  readProtonTool,
  TEMPLATE_MARKER,
  TEMPLATE_PROTON_DIR,
  type TemplateOutcome,
  templateBuildSpec,
  templateDir,
  templateState,
} from "../src/PrefixTemplate";
import { testConfig, unusedDocker } from "./fakes";

const BUILD = "1791989105 experimental-11.0-20261014";
const APP = 1966900;
const GiB = 1024 * 1024 * 1024;

const write = (base: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
};

/** `appmanifest_*.acf` установленного приложения (вложенный блок — как у Steam). */
const installed = (appId: number, installdir: string) =>
  [
    '"AppState"',
    "{",
    `\t"appid"\t\t"${appId}"`,
    '\t"StateFlags"\t\t"4"',
    `\t"installdir"\t\t"${installdir}"`,
    '\t"InstalledDepots"',
    "\t{",
    '\t\t"1"',
    "\t\t{",
    '\t\t\t"manifest"\t\t"42"',
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");

/** `toolmanifest.vdf` Proton Experimental (как в библиотеке brofrong). */
const toolManifest = [
  '"manifest"',
  "{",
  '  "version" "2"',
  '  "commandline" "/proton %verb%"',
  '  "require_tool_appid" "4183110"',
  '  "use_sessions" "1"',
  '  "compatmanager_layer_name" "proton"',
  "}",
  "",
].join("\n");

/** Библиотека с Proton, его Steam Linux Runtime и Windows-игрой 1966900. */
const library = (steamapps: string) =>
  write(steamapps, {
    "common/Proton - Experimental/version": `${BUILD}\n`,
    "common/Proton - Experimental/toolmanifest.vdf": toolManifest,
    "common/Proton - Experimental/proton": "#!/usr/bin/env python3\n",
    "appmanifest_4183110.acf": installed(4183110, "SteamLinuxRuntime_4"),
    "common/SteamLinuxRuntime_4/_v2-entry-point": "#!/bin/sh\n",
    [`appmanifest_${APP}.acf`]: installed(APP, "MinutesTillDawn"),
    "common/MinutesTillDawn/MinutesTillDawn.exe": "MZ",
  });

/** Фейковый dockerd: помощник сборки «играет Proton» в смонтированный каталог префикса. */
const makeFake = () => {
  const root = mkdtempSync(join(tmpdir(), "cg-pfx-"));
  const libraryDir = join(root, "library");
  const steamapps = join(libraryDir, "steamapps");
  const installScratch = join(root, "install");
  const scratch = join(root, "scratch");
  mkdirSync(installScratch, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  library(steamapps);
  const state = {
    root,
    libraryDir,
    steamapps,
    installScratch,
    scratch,
    calls: [] as string[],
    dockerCalls: 0,
    created: [] as ContainerSpec[],
    /** Контейнеры с меткой `cg.app`. */
    apps: [] as ContainerInfo[],
    /**
     * Код выхода помощника сборки: 3 — как у настоящего Proton без клиента
     * Steam (`steam.exe` падает на `steamclient_init`, префикс уже создан).
     */
    helperExit: 3,
    /** Что Proton кладёт в префикс (относительно `compatdata/<appId>`). */
    prefix: {
      version: "11.0-100\n",
      config_info: "11.0-100\n",
      "pfx/creation_sync_guard": "",
      "pfx/system.reg": "MachineGuid\n",
      "pfx/user.reg": "WINE REGISTRY\n",
      "pfx/drive_c/users/steamuser/Documents/.keep": "",
    } as Record<string, string>,
    /** `wait` помощника сборки ждёт этот Deferred. */
    gate: undefined as Deferred.Deferred<void> | undefined,
  };
  const record = (call: string) => {
    state.dockerCalls++;
    state.calls.push(call);
  };
  const specs = new Map<string, ContainerSpec>();
  const play = (spec: ContainerSpec) => {
    const target = `${STEAMAPPS_DIR}/compatdata/${APP}`;
    const bind = spec.binds.find((entry) => entry.endsWith(`:${target}`));
    if (bind === undefined) throw new Error("no prefix bind");
    write(bind.slice(0, -target.length - 1), state.prefix);
  };
  const docker: DockerClientShape = {
    ...unusedDocker,
    create: (spec) =>
      Effect.sync(() => {
        record(`create ${spec.name}`);
        state.created.push(spec);
        specs.set(spec.name, spec);
        return `id-${spec.name}`;
      }),
    start: (name) => Effect.sync(() => record(`start ${name}`)),
    wait: (name) =>
      Effect.gen(function* () {
        record(`wait ${name}`);
        const spec = specs.get(name);
        const entrypoint = spec?.entrypoint ?? [];
        // Помощник очистки: `rm -rf <путь>…` от root.
        if (entrypoint[0] === "rm") {
          for (const path of entrypoint.slice(2))
            rmSync(path, { recursive: true, force: true });
          return 0;
        }
        if (spec !== undefined && name === `cg-i-pfx-${APP}-build`) {
          if (state.gate !== undefined) yield* Deferred.await(state.gate);
          if (state.helperExit !== 1) play(spec);
          return state.helperExit;
        }
        return 0;
      }),
    remove: (name) => Effect.sync(() => record(`remove ${name}`)),
    createVolume: (volume) =>
      Effect.sync(() => record(`createVolume ${volume.name}`)),
    removeVolume: (name) => Effect.sync(() => record(`removeVolume ${name}`)),
    listByLabel: (label) =>
      Effect.sync(() => {
        record(`list ${label}`);
        return label === "cg.app" ? state.apps : [];
      }),
  };
  const disk = { freeBytes: 1024 * GiB, checked: [] as string[] };
  return { state, docker, disk };
};

type Fake = ReturnType<typeof makeFake>;

const configOf = (fake: Fake, patch: Partial<AgentConfigValues> = {}) =>
  testConfig({
    roles: ["worker", "gamestore"],
    libraryDir: fake.state.libraryDir,
    scratchDir: fake.state.scratch,
    installScratchDir: Option.some(fake.state.installScratch),
    ...patch,
  });

interface Harness {
  readonly fake: Fake;
  readonly ensure: (appId: number) => Effect.Effect<TemplateOutcome>;
}

const run = (
  body: (h: Harness) => Effect.Effect<void, unknown>,
  options: {
    readonly setup?: (fake: Fake) => void;
    readonly config?: Partial<AgentConfigValues>;
    readonly logs?: Array<string>;
  } = {},
) => {
  const fake = makeFake();
  options.setup?.(fake);
  const program = Effect.gen(function* () {
    const context = yield* Layer.build(
      prefixTemplatesLayer.pipe(
        Layer.provide(Layer.succeed(DockerClient, fake.docker)),
        Layer.provide(
          Layer.succeed(AgentConfig, configOf(fake, options.config)),
        ),
      ),
    );
    const templates = Context.get(context, PrefixTemplates);
    yield* body({ fake, ensure: templates.ensure });
  });
  const logs = options.logs;
  return Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provideService(FreeSpace, (dir) =>
        Effect.sync(() => {
          fake.disk.checked.push(dir);
          return fake.disk.freeBytes;
        }),
      ),
      (effect) =>
        logs === undefined
          ? Effect.provideService(effect, References.MinimumLogLevel, "None")
          : effect.pipe(
              Effect.provide(
                Logger.layer([
                  Logger.make(({ message }) => {
                    logs.push(JSON.stringify(message));
                  }),
                ]),
              ),
              Effect.provideService(References.MinimumLogLevel, "All"),
            ),
      Effect.ensuring(
        Effect.sync(() =>
          rmSync(fake.state.root, { recursive: true, force: true }),
        ),
      ),
    ),
  );
};

const target = (fake: Fake) =>
  join(fake.state.steamapps, "compatdata", "1966900");

/** Каталоги слоёв сборки: [клиент на SCRATCH_DIR, apps на INSTALL_SCRATCH_DIR]. */
const layerDirsExist = (fake: Fake) => [
  existsSync(join(fake.state.scratch, ".install", "pfx-1966900")),
  existsSync(join(fake.state.installScratch, "pfx-1966900")),
];

describe("readProtonTool", () => {
  it("reads the build and the runtime from the library", () => {
    const fake = makeFake();
    try {
      expect(readProtonTool(fake.state.steamapps)).toEqual({
        dirName: "Proton - Experimental",
        build: BUILD,
        runtimeDirName: "SteamLinuxRuntime_4",
      });
      expect(TEMPLATE_PROTON_DIR).toBe("Proton - Experimental");
    } finally {
      rmSync(fake.state.root, { recursive: true, force: true });
    }
  });

  it("readProtonTool without Proton or its runtime manifest is undefined", () => {
    const fake = makeFake();
    const steamapps = fake.state.steamapps;
    try {
      rmSync(join(steamapps, "appmanifest_4183110.acf"));
      expect(readProtonTool(steamapps)).toBeUndefined();
      write(steamapps, {
        "appmanifest_4183110.acf": installed(4183110, "SteamLinuxRuntime_4"),
      });
      rmSync(join(steamapps, "common/SteamLinuxRuntime_4"), {
        recursive: true,
      });
      expect(readProtonTool(steamapps)).toBeUndefined();
      rmSync(join(steamapps, "common/Proton - Experimental"), {
        recursive: true,
      });
      expect(readProtonTool(steamapps)).toBeUndefined();
      expect(readProtonTool(join(fake.state.root, "nowhere"))).toBeUndefined();
    } finally {
      rmSync(fake.state.root, { recursive: true, force: true });
    }
  });
});

describe("templateState", () => {
  it("templateState: missing without the dir or marker, stale for another build, fresh for this build", () => {
    const root = mkdtempSync(join(tmpdir(), "cg-pfx-state-"));
    const tool = {
      dirName: "Proton - Experimental",
      build: BUILD,
      runtimeDirName: "SteamLinuxRuntime_4",
    };
    try {
      const dir = join(root, "1966900");
      expect(templateState(dir, tool)).toBe("missing");
      write(dir, { version: "11.0-100\n" });
      expect(templateState(dir, tool)).toBe("missing");
      write(dir, { [TEMPLATE_MARKER]: "old-build\n" });
      expect(templateState(dir, tool)).toBe("stale");
      write(dir, { [TEMPLATE_MARKER]: `${BUILD}\n` });
      expect(templateState(dir, tool)).toBe("fresh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hasWindowsExe / playerDataIn", () => {
  it("finds .exe up to depth 4 without following links", () => {
    const root = mkdtempSync(join(tmpdir(), "cg-pfx-exe-"));
    try {
      const game = join(root, "game");
      write(game, { "a/b/c/run.sh": "" });
      expect(hasWindowsExe(game)).toBe(false);
      write(game, { "a/b/c/d/Deep.exe": "" });
      expect(hasWindowsExe(game)).toBe(false);
      write(game, { "a/b/c/Game.EXE": "" });
      expect(hasWindowsExe(game)).toBe(true);
      const linked = join(root, "linked");
      mkdirSync(linked);
      symlinkSync(game, join(linked, "to-game"));
      expect(hasWindowsExe(linked)).toBe(false);
      expect(hasWindowsExe(join(root, "nowhere"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists steam_autocloud.vdf paths only", () => {
    const root = mkdtempSync(join(tmpdir(), "cg-pfx-player-"));
    try {
      write(root, {
        "pfx/user.reg": "",
        "pfx/drive_c/users/steamuser/AppData/LocalLow/Flanne/MinutesTillDawn/steam_autocloud.vdf":
          '"1"',
      });
      expect(playerDataIn(root)).toEqual([
        "pfx/drive_c/users/steamuser/AppData/LocalLow/Flanne/MinutesTillDawn/steam_autocloud.vdf",
      ]);
      expect(playerDataIn(join(root, "nowhere"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("templateBuildSpec", () => {
  it("build spec mounts the template layers at the session paths and runs Proton through the runtime offline", () => {
    const config = testConfig({
      roles: ["worker", "gamestore"],
      installScratchDir: Option.some("/raid/cloud-gaming/install-scratch"),
    });
    const tool = {
      dirName: "Proton - Experimental",
      build: BUILD,
      runtimeDirName: "SteamLinuxRuntime_4",
    };
    expect(templateDir(config, 1966900)).toBe(
      "/raid/cloud-gaming/library/steamapps/compatdata/1966900",
    );
    expect(templateBuildSpec(config, 1966900, "MinutesTillDawn", tool)).toEqual(
      {
        name: "cg-i-pfx-1966900-build",
        image: "cg-session:550.163.01",
        env: {
          HOME: "/home/ubuntu",
          SteamAppId: "1966900",
          SteamGameId: "1966900",
          STEAM_COMPAT_APP_ID: "1966900",
          STEAM_COMPAT_DATA_PATH: `${STEAMAPPS_DIR}/compatdata/1966900`,
          STEAM_COMPAT_CLIENT_INSTALL_PATH: STEAM_DIR,
          STEAM_COMPAT_INSTALL_PATH: `${STEAMAPPS_DIR}/common/MinutesTillDawn`,
          STEAM_COMPAT_LIBRARY_PATHS: STEAMAPPS_DIR,
          STEAM_COMPAT_TOOL_PATHS: `${STEAMAPPS_DIR}/common/Proton - Experimental:${STEAMAPPS_DIR}/common/SteamLinuxRuntime_4`,
          PRESSURE_VESSEL_VARIABLE_DIR: "/tmp/cg-pv",
          BWRAP: "/usr/local/bin/proot-bwrap",
          DBUS_SYSTEM_BUS_ADDRESS: "",
        },
        labels: { "cg.helper": "prefix-template" },
        network: "none",
        udpPorts: [],
        // Префикс пишется мимо overlay: в слое apps может лежать старый шаблон.
        binds: [
          `/raid/cloud-gaming/install-scratch/pfx-1966900/build:${STEAMAPPS_DIR}/compatdata/1966900`,
        ],
        mounts: [
          { volume: "cg-i-pfx-1966900-client", target: STEAM_DIR },
          { volume: "cg-i-pfx-1966900-apps", target: STEAMAPPS_DIR },
        ],
        runtime: "runc",
        gpus: false,
        shmSizeBytes: 64 * 1024 * 1024,
        securityOpt: ["no-new-privileges:true"],
        tmpfs: { "/tmp/cg-pv": "exec,size=1g" },
        user: "1000",
        entrypoint: [
          `${STEAMAPPS_DIR}/common/SteamLinuxRuntime_4/_v2-entry-point`,
          "--verb=waitforexitandrun",
          "--",
          `${STEAMAPPS_DIR}/common/Proton - Experimental/proton`,
          "waitforexitandrun",
          "C:\\windows\\system32\\cmd.exe",
          "/c",
          "exit",
          "0",
        ],
      },
    );
  });
});

describe("PrefixTemplates.ensure", () => {
  it("ensure builds in the install scratch and renames the template into the library", () => {
    const logs: Array<string> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("built");
          const dir = target(h.fake);
          expect(readFileSync(join(dir, TEMPLATE_MARKER), "utf8")).toBe(
            `${BUILD}\n`,
          );
          // Умолчания Proton остаются в шаблоне.
          for (const path of [
            "version",
            "pfx/creation_sync_guard",
            "pfx/user.reg",
            "pfx/drive_c/users/steamuser",
          ])
            expect(existsSync(join(dir, path))).toBe(true);
          expect(layerDirsExist(h.fake)).toEqual([false, false]);
          const calls = h.fake.state.calls;
          expect(calls.indexOf("list cg.app")).toBeGreaterThan(
            calls.indexOf(`wait cg-i-pfx-${APP}-build`),
          );
          expect(calls).toEqual([
            // Остатки прошлой попытки: тома (каталогов нет — без помощника).
            "removeVolume cg-i-pfx-1966900-client",
            "removeVolume cg-i-pfx-1966900-apps",
            "createVolume cg-i-pfx-1966900-client",
            "createVolume cg-i-pfx-1966900-apps",
            "remove cg-i-pfx-1966900-build",
            "create cg-i-pfx-1966900-build",
            "start cg-i-pfx-1966900-build",
            "wait cg-i-pfx-1966900-build",
            "remove cg-i-pfx-1966900-build",
            "removeVolume cg-i-pfx-1966900-client",
            "removeVolume cg-i-pfx-1966900-apps",
            "list cg.app",
            "removeVolume cg-i-pfx-1966900-client",
            "removeVolume cg-i-pfx-1966900-apps",
            "remove cg-i-pfx-1966900-cleanup",
            "create cg-i-pfx-1966900-cleanup",
            "start cg-i-pfx-1966900-cleanup",
            "wait cg-i-pfx-1966900-cleanup",
            "remove cg-i-pfx-1966900-cleanup",
          ]);
          expect(h.fake.disk.checked).toEqual([h.fake.state.installScratch]);
          expect(
            logs.some(
              (line) =>
                line.includes("Prefix template built") && line.includes(BUILD),
            ),
          ).toBe(true);
        }),
      { logs },
    );
  });

  it("ensure replaces a stale template and keeps nothing of the old one", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("built");
          const dir = target(h.fake);
          expect(readFileSync(join(dir, TEMPLATE_MARKER), "utf8")).toBe(
            `${BUILD}\n`,
          );
          expect(existsSync(join(dir, "pfx/old-only"))).toBe(false);
          expect(existsSync(join(dir, "pfx/creation_sync_guard"))).toBe(true);
          expect(layerDirsExist(h.fake)).toEqual([false, false]);
        }),
      {
        setup: (fake) =>
          write(target(fake), {
            [TEMPLATE_MARKER]: "old-build\n",
            "pfx/old-only": "old",
          }),
      },
    ));

  it("ensure is single-flight per app", () =>
    run((h) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        h.fake.state.gate = gate;
        const first = yield* Effect.forkChild(h.ensure(APP));
        const second = yield* Effect.forkChild(h.ensure(APP));
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        expect(yield* Fiber.join(first)).toBe("built");
        expect(yield* Fiber.join(second)).toBe("built");
        expect(
          h.fake.state.calls.filter(
            (call) => call === `create cg-i-pfx-${APP}-build`,
          ),
        ).toHaveLength(1);
      }),
    ));

  it("ensure defers the swap while a container of the app exists", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("deferred");
          expect(existsSync(target(h.fake))).toBe(false);
          expect(layerDirsExist(h.fake)).toEqual([false, false]);
        }),
      {
        setup: (fake) => {
          fake.state.apps = [
            {
              name: "cg-session-s1",
              labels: { "cg.session": "s1", "cg.app": "1966900" },
              running: true,
            },
          ];
        },
      },
    ));

  it("a container of another app does not defer the swap", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("built");
          expect(existsSync(join(target(h.fake), TEMPLATE_MARKER))).toBe(true);
        }),
      {
        setup: (fake) => {
          fake.state.apps = [
            {
              name: "cg-session-s1",
              labels: { "cg.session": "s1", "cg.app": "1295320" },
              running: true,
            },
          ];
        },
      },
    ));

  it("template with steam_autocloud.vdf is not promoted", () => {
    const logs: Array<string> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("failed");
          expect(existsSync(join(h.fake.state.steamapps, "compatdata"))).toBe(
            false,
          );
          expect(layerDirsExist(h.fake)).toEqual([false, false]);
          expect(
            logs.some(
              (line) =>
                line.includes("Prefix template has player data") &&
                line.includes("MinutesTillDawn/steam_autocloud.vdf"),
            ),
          ).toBe(true);
        }),
      {
        logs,
        setup: (fake) => {
          fake.state.prefix[
            "pfx/drive_c/users/steamuser/AppData/LocalLow/Flanne/MinutesTillDawn/steam_autocloud.vdf"
          ] = '"accountid"\t\t"1"\n';
        },
      },
    );
  });

  it("prefix without creation_sync_guard is not promoted", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("failed");
          expect(existsSync(join(h.fake.state.steamapps, "compatdata"))).toBe(
            false,
          );
          expect(layerDirsExist(h.fake)).toEqual([false, false]);
        }),
      {
        setup: (fake) => {
          delete fake.state.prefix["pfx/creation_sync_guard"];
        },
      },
    ));

  it("failed helper leaves the library untouched", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("failed");
          expect(existsSync(join(h.fake.state.steamapps, "compatdata"))).toBe(
            false,
          );
          expect(layerDirsExist(h.fake)).toEqual([false, false]);
          expect(h.fake.state.calls).not.toContain("list cg.app");
          expect(h.fake.state.calls.slice(-7)).toEqual([
            "removeVolume cg-i-pfx-1966900-client",
            "removeVolume cg-i-pfx-1966900-apps",
            "remove cg-i-pfx-1966900-cleanup",
            "create cg-i-pfx-1966900-cleanup",
            "start cg-i-pfx-1966900-cleanup",
            "wait cg-i-pfx-1966900-cleanup",
            "remove cg-i-pfx-1966900-cleanup",
          ]);
        }),
      {
        setup: (fake) => {
          fake.state.helperExit = 1;
        },
      },
    ));

  it("helper exit 0 is accepted too", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(yield* h.ensure(APP)).toBe("built");
        }),
      {
        setup: (fake) => {
          fake.state.helperExit = 0;
        },
      },
    ));

  it("fresh template, native game, no Proton or no INSTALL_SCRATCH_DIR: no Docker calls", async () => {
    const cases: Array<{
      readonly expected: TemplateOutcome;
      readonly setup: (fake: Fake) => void;
      readonly config?: Partial<AgentConfigValues>;
    }> = [
      {
        expected: "fresh",
        setup: (fake) =>
          write(target(fake), {
            [TEMPLATE_MARKER]: `${BUILD}\n`,
            "pfx/creation_sync_guard": "",
          }),
      },
      {
        expected: "skipped",
        setup: (fake) => {
          rmSync(
            join(
              fake.state.steamapps,
              "common/MinutesTillDawn/MinutesTillDawn.exe",
            ),
          );
          write(fake.state.steamapps, {
            "common/MinutesTillDawn/MinutesTillDawn.x86_64": "ELF",
          });
        },
      },
      {
        expected: "skipped",
        setup: (fake) =>
          rmSync(join(fake.state.steamapps, "common/Proton - Experimental"), {
            recursive: true,
          }),
      },
      {
        expected: "skipped",
        setup: () => {},
        config: { installScratchDir: Option.none() },
      },
      {
        expected: "skipped",
        setup: (fake) =>
          rmSync(join(fake.state.steamapps, `appmanifest_${APP}.acf`)),
      },
    ];
    for (const item of cases)
      await run(
        (h) =>
          Effect.gen(function* () {
            expect(yield* h.ensure(APP)).toBe(item.expected);
            expect(h.fake.state.dockerCalls).toBe(0);
          }),
        item.config === undefined
          ? { setup: item.setup }
          : { setup: item.setup, config: item.config },
      );
  });

  it("not enough free space on the install scratch FS skips the build", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          h.fake.disk.freeBytes = 1 * GiB;
          expect(yield* h.ensure(APP)).toBe("skipped");
          expect(h.fake.state.dockerCalls).toBe(0);
          expect(h.fake.disk.checked).toEqual([h.fake.state.installScratch]);
        }),
      { config: { minFreeGb: 20 } },
    ));

  it("invalid appId fails without Docker", () =>
    run((h) =>
      Effect.gen(function* () {
        expect(yield* h.ensure(0)).toBe("failed");
        expect(yield* h.ensure(1.5)).toBe("failed");
        expect(h.fake.state.dockerCalls).toBe(0);
      }),
    ));
});
