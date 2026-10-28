import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  moveToTrash,
  planRemoval,
  scanLibrary,
  TRASH_DIR,
  TrashMoveError,
} from "../src/GameRemoval";

let library: string;
let steamapps: string;

beforeEach(() => {
  library = mkdtempSync(join(tmpdir(), "cg-game-removal-"));
  steamapps = join(library, "steamapps");
  mkdirSync(join(steamapps, "common"), { recursive: true });
});
afterEach(() => rmSync(library, { recursive: true, force: true }));

const write = (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(steamapps, path)), { recursive: true });
    writeFileSync(join(steamapps, path), content);
  }
};

/** `appmanifest_*.acf` в формате Steam (вложенный блок — как у настоящего). */
const acf = (fields: Record<string, string>) =>
  [
    '"AppState"',
    "{",
    ...Object.entries(fields).map(([key, value]) => `\t"${key}"\t\t"${value}"`),
    '\t"InstalledDepots"',
    "\t{",
    '\t\t"1"',
    "\t\t{",
    '\t\t\t"size"\t\t"999"',
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");

const balatro = acf({
  appid: "2379780",
  name: "Balatro",
  StateFlags: "4",
  installdir: "Balatro",
  SizeOnDisk: "67108864",
});

describe("scanLibrary", () => {
  it("читает манифесты библиотеки, битые пропускает", () => {
    write({
      "appmanifest_2379780.acf": balatro,
      // Без SizeOnDisk — размер 0.
      "appmanifest_1493710.acf": acf({
        appid: "1493710",
        name: "Proton Experimental",
        StateFlags: "4",
        installdir: "Proton - Experimental",
      }),
      "appmanifest_42.acf": "not a manifest {",
      "libraryfolders.vdf": '"libraryfolders" {}',
    });
    expect(scanLibrary(steamapps)).toEqual([
      { appId: 1493710, name: "Proton Experimental", sizeBytes: 0 },
      { appId: 2379780, name: "Balatro", sizeBytes: 67108864 },
    ]);
  });

  it("каталога нет — пустой список", () => {
    expect(scanLibrary(join(library, "nope"))).toEqual([]);
  });
});

describe("planRemoval", () => {
  it("манифест, common/<installdir> и shadercache/<appId>", () => {
    write({
      "appmanifest_2379780.acf": balatro,
      "common/Balatro/Balatro.exe": "game",
      "shadercache/2379780/cache": "x",
    });
    expect(planRemoval(steamapps, 2379780)).toEqual({
      manifest: join(steamapps, "appmanifest_2379780.acf"),
      dirs: [
        join(steamapps, "common", "Balatro"),
        join(steamapps, "shadercache", "2379780"),
      ],
    });
  });

  it("installdir вне common/ не трогается", () => {
    write({
      "appmanifest_2379780.acf": acf({ appid: "2379780", installdir: "../x" }),
      "shadercache/2379780/cache": "x",
    });
    mkdirSync(join(library, "x"));
    expect(planRemoval(steamapps, 2379780)).toEqual({
      manifest: join(steamapps, "appmanifest_2379780.acf"),
      dirs: [join(steamapps, "shadercache", "2379780")],
    });
  });

  it("каталогов нет — только манифест", () => {
    write({ "appmanifest_2379780.acf": balatro });
    expect(planRemoval(steamapps, 2379780)).toEqual({
      manifest: join(steamapps, "appmanifest_2379780.acf"),
      dirs: [],
    });
  });

  it("манифеста нет — undefined", () => {
    write({ "common/Balatro/Balatro.exe": "game" });
    expect(planRemoval(steamapps, 2379780)).toBeUndefined();
  });
});

describe("moveToTrash", () => {
  it("переносит манифест и каталоги в корзину", () => {
    write({
      "appmanifest_2379780.acf": balatro,
      "common/Balatro/Balatro.exe": "game",
      "shadercache/2379780/cache": "x",
    });
    const plan = planRemoval(steamapps, 2379780);
    if (plan === undefined) throw new Error("no plan");
    const moved = moveToTrash(plan, library, "1761600000000");
    const trash = join(library, TRASH_DIR);
    expect(TRASH_DIR).toBe(".trash");
    expect(moved).toHaveLength(3);
    for (const path of moved) {
      expect(dirname(path)).toBe(trash);
      expect(existsSync(path)).toBe(true);
    }
    expect(readdirSync(trash).sort()).toEqual([
      "2379780-1761600000000",
      "2379780-1761600000000-1",
      "2379780-1761600000000-2",
    ]);
    expect(existsSync(plan.manifest)).toBe(false);
    for (const dir of plan.dirs) expect(existsSync(dir)).toBe(false);
    // Прочее в steamapps не тронуто.
    expect(readdirSync(join(steamapps, "common"))).toEqual([]);
  });

  it("сбой переноса каталога — уже перенесённое возвращается, restored", () => {
    write({
      "appmanifest_2379780.acf": balatro,
      "common/Balatro/Balatro.exe": "game",
      "shadercache/2379780/cache": "x",
    });
    const plan = planRemoval(steamapps, 2379780);
    if (plan === undefined) throw new Error("no plan");
    const failing = (from: string, to: string) => {
      if (from.includes("shadercache")) throw new Error("EIO: shadercache");
      renameSync(from, to);
    };
    let error: unknown;
    try {
      moveToTrash(plan, library, "1", failing);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TrashMoveError);
    expect((error as TrashMoveError).restored).toBe(true);
    expect((error as TrashMoveError).message).toContain("EIO: shadercache");
    expect(existsSync(plan.manifest)).toBe(true);
    for (const dir of plan.dirs) expect(existsSync(dir)).toBe(true);
    expect(readdirSync(join(library, TRASH_DIR))).toEqual([]);
  });

  it("возврат не удался — манифест остаётся в корзине, не restored", () => {
    write({
      "appmanifest_2379780.acf": balatro,
      "common/Balatro/Balatro.exe": "game",
      "shadercache/2379780/cache": "x",
    });
    const plan = planRemoval(steamapps, 2379780);
    if (plan === undefined) throw new Error("no plan");
    const trash = join(library, TRASH_DIR);
    // Перенос shadercache падает; возврат каталога игры из корзины — тоже.
    const failing = (from: string, to: string) => {
      if (from.includes("shadercache")) throw new Error("EIO: shadercache");
      if (from.startsWith(trash) && to.includes("common"))
        throw new Error("EIO: restore");
      renameSync(from, to);
    };
    let error: unknown;
    try {
      moveToTrash(plan, library, "1", failing);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TrashMoveError);
    expect((error as TrashMoveError).restored).toBe(false);
    // Манифест не возвращён: Steam не увидит игру без её файлов.
    expect(existsSync(plan.manifest)).toBe(false);
    expect(readdirSync(trash).sort()).toEqual(["2379780-1", "2379780-1-1"]);
  });

  it("занятое имя в корзине не перезаписывается", () => {
    write({ "appmanifest_2379780.acf": balatro });
    const trash = join(library, TRASH_DIR);
    mkdirSync(join(trash, "2379780-1"), { recursive: true });
    const plan = planRemoval(steamapps, 2379780);
    if (plan === undefined) throw new Error("no plan");
    expect(moveToTrash(plan, library, "1")).toEqual([
      join(trash, "2379780-1-1"),
    ]);
    expect(readdirSync(trash).sort()).toEqual(["2379780-1", "2379780-1-1"]);
  });
});
