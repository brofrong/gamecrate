// Заглушка без сети (offline/retry.js) и инварианты конфига приложения. Тесты Rust
// (src-tauri, nav.rs) — `bun run test:rust`: в CI GitLab нет cargo, поэтому `test` — только bun.
import { describe, expect, test } from "bun:test";
import { reachable, retryTarget } from "../offline/retry.js";

describe("retryTarget", () => {
  test("берёт адрес сайта из ?retry=", () => {
    expect(retryTarget("?retry=https%3A%2F%2Fgame.brofrong.ru%2Fapp")).toBe(
      "https://game.brofrong.ru/app",
    );
    expect(retryTarget("?retry=http%3A%2F%2Flocalhost%3A3000%2Fapp")).toBe(
      "http://localhost:3000/app",
    );
  });

  test("не ведёт никуда, кроме http(s)", () => {
    expect(retryTarget("")).toBeNull();
    expect(retryTarget("?retry=")).toBeNull();
    expect(retryTarget("?retry=javascript%3Aalert(1)")).toBeNull();
    expect(retryTarget("?retry=file%3A%2F%2F%2Fetc%2Fpasswd")).toBeNull();
    expect(retryTarget("?retry=not%20a%20url")).toBeNull();
  });
});

describe("reachable", () => {
  const ok = (() => Promise.resolve(new Response(null))) as unknown as typeof fetch;
  const down = (() => Promise.reject(new TypeError("Load failed"))) as unknown as typeof fetch;
  const hang = ((_: unknown, init?: RequestInit) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

  test("любой ответ — связь есть", async () => {
    expect(await reachable("https://game.brofrong.ru/app", ok)).toBe(true);
  });

  test("сетевая ошибка или таймаут — связи нет", async () => {
    expect(await reachable("https://game.brofrong.ru/app", down)).toBe(false);
    expect(await reachable("https://game.brofrong.ru/app", hang, 10)).toBe(false);
  });
});

describe("конфиг приложения", () => {
  const dir = new URL("../", import.meta.url);
  const read = (path: string) => Bun.file(new URL(path, dir)).text();

  test("удалённой странице не открыт глобальный Tauri, окно создаёт Rust", async () => {
    const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
    expect(conf.build.frontendDist).toBe("../offline");
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.windows).toEqual([]);
  });

  test("зависимости Cargo запинены точно", async () => {
    let section = "";
    const deps = (await read("src-tauri/Cargo.toml")).split("\n").filter((line) => {
      if (line.startsWith("[")) section = line;
      return section.endsWith("dependencies]") && /^[\w-]+ = /.test(line);
    });
    expect(deps.length).toBeGreaterThan(0);
    for (const line of deps) expect(line).toMatch(/"=\d+\.\d+\.\d+"/);
  });

  test("npm-зависимости без ^ и ~", async () => {
    const pkg = JSON.parse(await read("package.json"));
    for (const version of Object.values<string>(pkg.devDependencies ?? {})) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
