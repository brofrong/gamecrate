// Посев входа в контейнер (`seedSteamLogin`): нечитаемые файлы входа — предупреждение
// в лог (только ключ файла, без содержимого); `config.vdf` при этом не трогается,
// остальные три собираются с нуля.
import { describe, expect, it } from "bun:test";
import { Effect, Logger, References } from "effect";
import { DockerClient, DockerError } from "../src/DockerClient";
import { HOME_DIR } from "../src/profile/HomeProfile";
import { LOGIN_FILES } from "../src/steam/loginSeed";
import { seedSteamLogin } from "../src/steam/seedContainer";
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
