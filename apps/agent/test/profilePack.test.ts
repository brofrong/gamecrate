import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Скрипт образа сессии: в контейнере его зовёт агент (`docker exec`). */
const script = join(import.meta.dir, "../../../images/session/cg-profile-pack");

const steam = ".local/share/Steam";
const pfx = `${steam}/steamapps/compatdata/1966900/pfx`;

/** Дом пользователя после сессии: профиль, сохранения и то, что в профиль не входит. */
const files = [
  `${steam}/config/config.vdf`,
  `${steam}/config/htmlcache/Cache/data_0`,
  `${steam}/config/avatarcache/1.png`,
  `${steam}/local.vdf`,
  `${steam}/userdata/42/7/remote/save.dat`,
  `${steam}/core.1234`,
  `${steam}/logs/cloud_log.txt`,
  `${steam}/steamapps/appmanifest_1966900.acf`,
  `${steam}/steamapps/common/20 Minutes Till Dawn/game.x86_64`,
  `${steam}/steamapps/common/Steam Controller Configs/42/config/x.vdf`,
  `${pfx}/drive_c/users/steamuser/AppData/LocalLow/Company/save.json`,
  `${pfx}/drive_c/windows/system32/kernel32.dll`,
  `${pfx}/user.reg`,
  `${pfx}/system.reg`,
  ".steam/registry.vdf",
  ".steam/steam.pid",
  ".config/x",
  ".local/share/Company/save",
  ".cache/thumbnails/a.png",
];

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cg-profile-pack-"));
  for (const file of files) {
    mkdirSync(join(home, dirname(file)), { recursive: true });
    writeFileSync(join(home, file), "x");
  }
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** `cg-profile-pack --list` с HOME=`dir`: записи архива по порядку. */
const list = (dir: string) => {
  const result = Bun.spawnSync(["bash", script, "--list"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\n").filter(Boolean);
};

/** Каталоги-родители пути от верхнего (`.local`, `.steam`, `.config`) вниз. */
const parents = (path: string) => {
  const parts = path.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

describe("cg-profile-pack", () => {
  it("pack list covers saves and parents", () => {
    const entries = list(home);
    const wanted = [
      `${pfx}/drive_c/users/steamuser`,
      `${pfx}/drive_c/users/steamuser/AppData/LocalLow/Company/save.json`,
      `${pfx}/user.reg`,
      ".config/x",
      ".local/share/Company/save",
      `${steam}/steamapps/common/Steam Controller Configs`,
      `${steam}/steamapps/common/Steam Controller Configs/42/config/x.vdf`,
      `${steam}/config/config.vdf`,
      `${steam}/local.vdf`,
      `${steam}/userdata/42/7/remote/save.dat`,
      ".steam/registry.vdf",
    ];
    for (const path of wanted) {
      expect(entries).toContain(path);
      for (const parent of parents(path))
        expect(entries.indexOf(parent)).toBeGreaterThan(-1);
      for (const parent of parents(path))
        expect(entries.indexOf(parent)).toBeLessThan(entries.indexOf(path));
    }
    // Каждая запись — один раз.
    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry).not.toContain("htmlcache");
      expect(entry).not.toContain("avatarcache");
      expect(entry).not.toContain("core.");
      expect(entry).not.toContain("20 Minutes Till Dawn");
      expect(entry).not.toContain("drive_c/windows");
      expect(entry).not.toContain("system.reg");
      expect(entry).not.toContain("appmanifest");
      expect(entry).not.toContain("logs");
      expect(entry).not.toStartWith(".cache");
      expect(entry).not.toBe(".steam/steam.pid");
      expect(entry).not.toStartWith("/");
      expect(entry).not.toStartWith("./");
    }
  });

  it("junk under the Proton user dir is not packed, saves are", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-profile-pack-junk-"));
    const user = `${pfx}/drive_c/users/steamuser`;
    const saves = [
      `${user}/AppData/Local/Game/Saved/SaveGames/slot1.sav`,
      `${user}/AppData/Local/Game/Saved/Config/Windows/Game.ini`,
      `${user}/Documents/My Games/Game/save.sav`,
      `${user}/AppData/Roaming/Studio/Game/profile.dat`,
    ];
    const junk = [
      `${user}/AppData/Local/Game/Saved/Logs/Game.log`,
      `${user}/AppData/Local/Game/Saved/Crashes/UE-1/dump.dmp`,
      `${user}/AppData/Local/Game/webcache/index`,
      `${user}/AppData/Local/Game/Cache/data_0`,
      `${user}/AppData/Local/Game/GPUCache/data_1`,
      `${user}/AppData/Roaming/Studio/ShaderCache/a.bin`,
    ];
    try {
      for (const file of [...saves, ...junk]) {
        mkdirSync(join(dir, dirname(file)), { recursive: true });
        writeFileSync(join(dir, file), "x");
      }
      const entries = list(dir);
      for (const path of saves) expect(entries).toContain(path);
      for (const entry of entries) {
        expect(entry).not.toContain("/Saved/Logs");
        expect(entry).not.toContain("/Saved/Crashes");
        expect(entry).not.toContain("/webcache");
        expect(entry).not.toContain("/Cache");
        expect(entry).not.toContain("/GPUCache");
        expect(entry).not.toContain("/ShaderCache");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty home lists nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "cg-profile-pack-empty-"));
    try {
      expect(list(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("scripts are valid bash", () => {
    for (const name of ["cg-profile-pack", "cg-steam-shutdown"]) {
      const result = Bun.spawnSync([
        "bash",
        "-n",
        join(import.meta.dir, "../../../images/session", name),
      ]);
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });
});
