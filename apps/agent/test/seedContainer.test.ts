// Посев входа в контейнер (`seedSteamLogin`): нечитаемые файлы входа — предупреждение
// в лог (только ключ файла, без содержимого); `config.vdf` при этом не трогается,
// остальные три собираются с нуля. Стирание входа (`clearSteamLogin`, Task 2
// admin-part3) читает те же файлы и переписывает только те, что есть.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Logger, References } from "effect";
import { DockerClient, DockerError } from "../src/DockerClient";
import { HOME_DIR } from "../src/profile/HomeProfile";
import { applyLoginSeed, LOGIN_FILES } from "../src/steam/loginSeed";
import { clearSteamLogin, seedSteamLogin } from "../src/steam/seedContainer";
import { getPath, parseVdf } from "../src/steam/vdf";
import { tarOfFile, testSteamLogin, unusedDocker } from "./fakes";
import { findTarEntry } from "./tar";

const GARBAGE = '"InstallConfigStore" { "broken';

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

/** Выполняет `clearSteamLogin` на фейковом контейнере, где лежат `files`; возвращает положенные архивы. */
const clearWith = (files: Partial<Record<keyof typeof LOGIN_FILES, string>>) => {
  const put: Array<Uint8Array> = [];
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
  return clearSteamLogin({ container: "c1" }).pipe(
    Effect.provideService(DockerClient, docker),
    Effect.runPromise,
    (promise) => promise.then(() => put),
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
    const put = await clearWith({
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
    const put = await clearWith({});
    expect(put).toEqual([]);
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
