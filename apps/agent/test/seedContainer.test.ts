// Посев входа в контейнер (`seedSteamLogin`): нечитаемые файлы входа — предупреждение
// в лог (только ключ файла, без содержимого); `config.vdf` при этом не трогается,
// остальные три собираются с нуля. Стирание входа (`clearSteamLogin`) читает те
// же файлы: нечитаемые `local.vdf`/`loginusers.vdf`/`registry.vdf` всё равно
// пересобираются с нуля (в них может остаться токен, который наш парсер не
// распознал, а клиент Steam — распознает), `config.vdf` при этом не трогается.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Logger, References } from "effect";
import { DockerClient, DockerError } from "../src/DockerClient";
import { HOME_DIR } from "../src/profile/HomeProfile";
import { applyLoginSeed, LOGIN_FILES } from "../src/steam/loginSeed";
import {
  clearLaunchOptions,
  clearSteamLogin,
  seedSteamLogin,
  setLaunchOptions,
  unwrapLaunchOptions,
  wrapLaunchOptions,
} from "../src/steam/seedContainer";
import { getPath, parseVdf } from "../src/steam/vdf";
import { tarOfFile, testSteamLogin, unusedDocker } from "./fakes";
import { findTarEntry } from "./tar";

const GARBAGE = '"InstallConfigStore" { "broken';
const GARBAGE_LOCAL = '"MachineUserConfigStore" { "broken';

/**
 * Сеет вход в фейковый контейнер, где лежат `files` (ключ `LOGIN_FILES` → текст;
 * остальных файлов нет), и возвращает записанный архив и строки лога.
 */
const seedWith = (files: Partial<Record<keyof typeof LOGIN_FILES, string>>) => {
  const put: Array<Uint8Array> = [];
  const logged: Array<{ level: string; text: string }> = [];
  const byPath = new Map(
    Object.entries(files).map(([key, text]) => [
      `${HOME_DIR}/${LOGIN_FILES[key as keyof typeof LOGIN_FILES]}`,
      text,
    ]),
  );
  const docker = {
    ...unusedDocker,
    getArchive: (_container: string, path: string) => {
      const text = byPath.get(path);
      return text === undefined
        ? Effect.fail(
            new DockerError({
              operation: "getArchive",
              status: 404,
              message: "no such file",
            }),
          )
        : Effect.succeed(
            tarOfFile(
              path.slice(path.lastIndexOf("/") + 1),
              new TextEncoder().encode(text),
            ),
          );
    },
    putArchive: (_container: string, _path: string, tar: Uint8Array) =>
      Effect.sync(() => void put.push(tar)),
  };
  const capture = Logger.make(({ logLevel, message }) => {
    logged.push({ level: logLevel, text: Bun.inspect(message) });
  });
  return seedSteamLogin({ container: "c1", seed: testSteamLogin() }).pipe(
    Effect.provideService(DockerClient, docker),
    Effect.provide(Logger.layer([capture])),
    Effect.provideService(References.MinimumLogLevel, "All"),
    Effect.runPromise,
    (promise) =>
      promise.then(() => {
        const tar = put[0];
        if (put.length !== 1 || tar === undefined)
          throw new Error(`expected one archive, got ${put.length}`);
        return { tar, logged };
      }),
  );
};

const entry = (tar: Uint8Array, name: string) => {
  const data = findTarEntry(tar, name);
  return data === undefined ? undefined : new TextDecoder().decode(data);
};

/**
 * Выполняет `clearSteamLogin` на фейковом контейнере, где лежат `files`;
 * возвращает положенные архивы и строки лога.
 */
const clearWith = (files: Partial<Record<keyof typeof LOGIN_FILES, string>>) => {
  const put: Array<Uint8Array> = [];
  const logged: Array<{ level: string; text: string }> = [];
  const byPath = new Map(
    Object.entries(files).map(([key, text]) => [
      `${HOME_DIR}/${LOGIN_FILES[key as keyof typeof LOGIN_FILES]}`,
      text,
    ]),
  );
  const docker = {
    ...unusedDocker,
    getArchive: (_container: string, path: string) => {
      const text = byPath.get(path);
      return text === undefined
        ? Effect.fail(
            new DockerError({
              operation: "getArchive",
              status: 404,
              message: "no such file",
            }),
          )
        : Effect.succeed(
            tarOfFile(
              path.slice(path.lastIndexOf("/") + 1),
              new TextEncoder().encode(text),
            ),
          );
    },
    putArchive: (_container: string, _path: string, tar: Uint8Array) =>
      Effect.sync(() => void put.push(tar)),
  };
  const capture = Logger.make(({ logLevel, message }) => {
    logged.push({ level: logLevel, text: Bun.inspect(message) });
  });
  return clearSteamLogin({ container: "c1" }).pipe(
    Effect.provideService(DockerClient, docker),
    Effect.provide(Logger.layer([capture])),
    Effect.provideService(References.MinimumLogLevel, "All"),
    Effect.runPromise,
    (promise) => promise.then(() => ({ put, logged })),
  );
};

/** Режим и владелец записи `name` в `tar` (системный `tar`, как в profileCodec.test.ts). */
const tarEntryInfo = (tar: Uint8Array, name: string) => {
  const dir = mkdtempSync(join(tmpdir(), "cg-clear-tar-"));
  try {
    const tarPath = join(dir, "one.tar");
    writeFileSync(tarPath, tar);
    const list = Bun.spawnSync(["tar", "-tvf", tarPath, "--numeric-owner"]);
    expect(new TextDecoder().decode(list.stderr)).toBe("");
    const line = new TextDecoder()
      .decode(list.stdout)
      .split("\n")
      .find((text) => text.endsWith(name));
    return line;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const SEED = {
  accountName: "test-account",
  steamId: "76561197960287930",
  token: "test-refresh-token",
};

describe("clearSteamLogin", () => {
  it("rewrites only present files", async () => {
    const seeded = applyLoginSeed({}, SEED, 1_760_000_000);
    const { put } = await clearWith({
      localVdf: seeded.localVdf,
      registry: seeded.registry,
    });

    expect(put).toHaveLength(1);
    const tar = put[0];
    if (tar === undefined) throw new Error("expected one archive");

    const local = entry(tar, "local.vdf");
    expect(local).toBeDefined();
    expect(local).not.toContain(SEED.accountName);
    const registry = entry(tar, "registry.vdf");
    expect(registry).toContain('"AutoLoginUser"\t\t""');
    expect(registry).toContain('"RememberPassword"\t\t"0"');
    expect(entry(tar, "loginusers.vdf")).toBeUndefined();
    expect(entry(tar, "config.vdf")).toBeUndefined();

    for (const name of ["local.vdf", "registry.vdf"]) {
      const line = tarEntryInfo(tar, name);
      expect(line).toStartWith("-rw-------");
      expect(line).toMatch(/\b1000\s+1000\b/);
    }
  });

  it("writes nothing when the home has no login files", async () => {
    const { put } = await clearWith({});
    expect(put).toEqual([]);
  });

  it("rewrites unreadable local.vdf from an empty tree, skips unreadable config.vdf, and warns for both", async () => {
    // Наш парсер строже клиента Steam: файл, который мы не смогли разобрать,
    // может всё равно хранить токен в ConnectCache — доверять, что он "как
    // был", нельзя. config.vdf не содержит токена — его трогать не надёжно,
    // не разобрав, поэтому он остаётся как был.
    const { put, logged } = await clearWith({
      localVdf: GARBAGE_LOCAL,
      config: GARBAGE,
    });

    expect(put).toHaveLength(1);
    const tar = put[0];
    if (tar === undefined) throw new Error("expected one archive");

    const local = entry(tar, "local.vdf");
    expect(local).toBeDefined();
    expect(local).not.toContain("broken");
    expect(
      getPath(parseVdf(local ?? ""), [
        "MachineUserConfigStore",
        "Software",
        "Valve",
        "Steam",
        "ConnectCache",
      ]),
    ).toEqual([]);
    expect(entry(tar, "config.vdf")).toBeUndefined();

    const warnings = logged.filter((line) => line.level === "Warn");
    expect(warnings).toHaveLength(2);
    const text = warnings.map((line) => line.text).join("\n");
    expect(text).toContain("localVdf");
    expect(text).toContain("config");
    // Только ключи файлов — ни содержимого, ни секретов входа.
    expect(text).not.toContain("broken");
  });
});

describe("seedSteamLogin", () => {
  it("unreadable config.vdf is left untouched and logged", async () => {
    const { tar, logged } = await seedWith({ config: GARBAGE });

    expect(entry(tar, "config.vdf")).toBeUndefined();
    expect(entry(tar, "local.vdf")).toContain("ConnectCache");
    expect(entry(tar, "loginusers.vdf")).toBeDefined();
    expect(entry(tar, "registry.vdf")).toBeDefined();

    const warnings = logged.filter((line) => line.level === "Warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("Steam login file unreadable");
    expect(warnings[0]?.text).toContain("config");
    // Только ключ файла — ни содержимого, ни секретов входа.
    const text = logged.map((line) => line.text).join("\n");
    expect(text).not.toContain("broken");
    expect(text).not.toContain("test-refresh-token");
    expect(text).not.toContain("test-account");
  });

  it("unreadable loginusers.vdf is rebuilt from scratch and logged", async () => {
    const { tar, logged } = await seedWith({ loginUsers: "garbage {" });

    const loginUsers = parseVdf(entry(tar, "loginusers.vdf") ?? "");
    expect(
      getPath(loginUsers, ["users", testSteamLogin().steamId, "AutoLogin"]),
    ).toBe("1");
    expect(entry(tar, "config.vdf")).toBeDefined();

    const warnings = logged.filter((line) => line.level === "Warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("Steam login file unreadable");
    expect(warnings[0]?.text).toContain("loginUsers");
    expect(warnings[0]?.text).not.toContain("garbage");
  });

  it("readable or missing files are written without warnings", async () => {
    const { tar, logged } = await seedWith({});

    for (const name of [
      "local.vdf",
      "loginusers.vdf",
      "config.vdf",
      "registry.vdf",
    ])
      expect(entry(tar, name)).toBeDefined();
    expect(logged.filter((line) => line.level === "Warn")).toEqual([]);
  });
});

const STEAM_ID = "76561197960287930";
/** `userdata/<accountId>`: SteamID64 минус 76561197960265728. */
const LOCALCONFIG = ".local/share/Steam/userdata/22202/config/localconfig.vdf";
const LOGIN_USERS_VDF = `"users"\n{\n\t"${STEAM_ID}"\n\t{\n\t\t"AccountName"\t\t"test-account"\n\t}\n}\n`;
const WRAPPED = "/usr/local/bin/cg-game-exit %command%";

/** localconfig.vdf с параметрами запуска по appid (`undefined` — блока игры нет). */
const localConfig = (apps: Record<string, string | undefined>) =>
  `"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n${Object.entries(
    apps,
  )
    .map(
      ([appId, options]) =>
        `\t\t\t\t\t"${appId}"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1760000000"\n${
          options === undefined
            ? ""
            : `\t\t\t\t\t\t"LaunchOptions"\t\t"${options.replace(/"/g, '\\"')}"\n`
        }\t\t\t\t\t}\n`,
    )
    .join("")}\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`;

/**
 * Фейковый контейнер: файлы по пути относительно дома; `putArchive` кладёт
 * записанные файлы обратно (последовательные вызовы видят результат).
 */
const homeContainer = (
  files: Record<string, string>,
  wrapperInImage = true,
) => {
  const home = new Map(
    Object.entries(files).map(([path, text]) => [`${HOME_DIR}/${path}`, text]),
  );
  const put: Array<Uint8Array> = [];
  const read: Array<string> = [];
  const logged: Array<{ level: string; text: string }> = [];
  const docker = {
    ...unusedDocker,
    getArchive: (_container: string, path: string) => {
      read.push(path);
      const text = home.get(path);
      return text === undefined
        ? Effect.fail(
            new DockerError({
              operation: "getArchive",
              status: 404,
              message: "no such file",
            }),
          )
        : Effect.succeed(
            tarOfFile(
              path.slice(path.lastIndexOf("/") + 1),
              new TextEncoder().encode(text),
            ),
          );
    },
    archiveSize: (_container: string, path: string) =>
      path === "/usr/local/bin/cg-game-exit" && wrapperInImage
        ? Effect.succeed(1024)
        : Effect.fail(
            new DockerError({
              operation: "archiveSize",
              status: 404,
              message: "no such file",
            }),
          ),
    putArchive: (_container: string, _path: string, tar: Uint8Array) =>
      Effect.sync(() => {
        put.push(tar);
        const text = entry(tar, "localconfig.vdf");
        if (text !== undefined) home.set(`${HOME_DIR}/${LOCALCONFIG}`, text);
      }),
  };
  const capture = Logger.make(({ logLevel, message }) => {
    logged.push({ level: logLevel, text: Bun.inspect(message) });
  });
  const runIn = <A, E>(effect: Effect.Effect<A, E, DockerClient>) =>
    effect.pipe(
      Effect.provideService(DockerClient, docker),
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "All"),
      Effect.runPromise,
    );
  const launchOptions = (appId: string) =>
    getPath(parseVdf(home.get(`${HOME_DIR}/${LOCALCONFIG}`) ?? ""), [
      "UserLocalConfigStore",
      "Software",
      "Valve",
      "Steam",
      "apps",
      appId,
      "LaunchOptions",
    ]);
  return { put, read, logged, runIn, launchOptions, home };
};

describe("launch options", () => {
  it("wrap and unwrap keep the player's options", () => {
    for (const original of [
      "",
      "-novid",
      "PROTON_LOG=1 %command% -windowed",
      "gamemoderun %command%",
    ]) {
      const wrapped = wrapLaunchOptions(original);
      expect(wrapped).toStartWith("/usr/local/bin/cg-game-exit ");
      expect(wrapped).toContain("%command%");
      expect(unwrapLaunchOptions(wrapped)).toBe(original);
      // Повторная обёртка (снять не удалось) — без второй обёртки.
      expect(wrapLaunchOptions(wrapped)).toBe(wrapped);
    }
    expect(wrapLaunchOptions(undefined)).toBe(WRAPPED);
    expect(unwrapLaunchOptions("-novid")).toBeUndefined();
  });

  it("setLaunchOptions wraps the game's options in localconfig.vdf, other games untouched", async () => {
    const c = homeContainer({
      [LOGIN_FILES.loginUsers]: LOGIN_USERS_VDF,
      [LOCALCONFIG]: localConfig({ "570": "-novid", "10": "-console" }),
    });
    await c.runIn(setLaunchOptions({ container: "c1", appId: 570 }));

    expect(c.put).toHaveLength(1);
    expect(c.launchOptions("570")).toBe(`${WRAPPED} -novid`);
    expect(c.launchOptions("10")).toBe("-console");
    const line = tarEntryInfo(c.put[0]!, "localconfig.vdf");
    expect(line).toStartWith("-rw-------");
    expect(line).toMatch(/\b1000\s+1000\b/);

    await c.runIn(clearLaunchOptions({ container: "c1", appId: 570 }));
    expect(c.put).toHaveLength(2);
    expect(c.launchOptions("570")).toBe("-novid");
    expect(c.launchOptions("10")).toBe("-console");
  });

  it("setLaunchOptions creates the game block and localconfig.vdf when missing", async () => {
    const c = homeContainer({ [LOGIN_FILES.loginUsers]: LOGIN_USERS_VDF });
    await c.runIn(setLaunchOptions({ container: "c1", appId: 570 }));
    expect(c.launchOptions("570")).toBe(WRAPPED);
    // Родители файла — в архиве, с владельцем ubuntu (иначе Docker создаст их от root).
    for (const dir of [
      ".local/share/Steam/userdata/",
      ".local/share/Steam/userdata/22202/",
      ".local/share/Steam/userdata/22202/config/",
    ])
      expect(tarEntryInfo(c.put[0]!, dir)).toMatch(/^drwx------.*\b1000\s+1000\b/);

    await c.runIn(clearLaunchOptions({ container: "c1", appId: 570 }));
    expect(c.launchOptions("570")).toBe("");
  });

  it("clearLaunchOptions leaves options without the wrapper alone", async () => {
    const c = homeContainer({
      [LOGIN_FILES.loginUsers]: LOGIN_USERS_VDF,
      [LOCALCONFIG]: localConfig({ "570": "-novid" }),
    });
    await c.runIn(clearLaunchOptions({ container: "c1", appId: 570 }));
    expect(c.put).toEqual([]);
  });

  it("without loginusers.vdf nothing is read or written", async () => {
    const c = homeContainer({});
    await c.runIn(setLaunchOptions({ container: "c1", appId: 570 }));
    await c.runIn(clearLaunchOptions({ container: "c1", appId: 570 }));
    expect(c.put).toEqual([]);
    expect(c.read).toEqual([
      `${HOME_DIR}/${LOGIN_FILES.loginUsers}`,
      `${HOME_DIR}/${LOGIN_FILES.loginUsers}`,
    ]);
  });

  it("an image without cg-game-exit keeps the options as they are", async () => {
    const c = homeContainer(
      {
        [LOGIN_FILES.loginUsers]: LOGIN_USERS_VDF,
        [LOCALCONFIG]: localConfig({ "570": "-novid" }),
      },
      false,
    );
    await c.runIn(setLaunchOptions({ container: "c1", appId: 570 }));
    expect(c.put).toEqual([]);
    expect(c.read).toEqual([]);
    expect(c.logged.map((line) => line.text).join("\n")).toContain(
      "Session image has no cg-game-exit",
    );
  });

  it("unreadable localconfig.vdf is not overwritten and is logged", async () => {
    const c = homeContainer({
      [LOGIN_FILES.loginUsers]: LOGIN_USERS_VDF,
      [LOCALCONFIG]: '"UserLocalConfigStore" { "broken',
    });
    await c.runIn(setLaunchOptions({ container: "c1", appId: 570 }));
    expect(c.put).toEqual([]);
    const warnings = c.logged.filter((line) => line.level === "Warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("localconfig.vdf unreadable");
    expect(warnings[0]?.text).not.toContain("broken");
  });
});
