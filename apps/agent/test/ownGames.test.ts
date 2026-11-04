// Тесты сканирования пакетов своих игр (`GAMES_DIR`, Task 5).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  OWN_GAME_LABEL,
  OWN_GAME_MOUNT,
  OWN_GAME_RUN,
  ownGameDir,
  scanOwnGames,
} from "../src/OwnGames";

/** Пакет `<gamesDir>/<slug>/<version>/run` с заданным режимом (по умолчанию исполняемый). */
const writePackage = (
  gamesDir: string,
  slug: string,
  version: string,
  mode = 0o755,
) => {
  const dir = join(gamesDir, slug, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run"), "#!/bin/sh\n");
  chmodSync(join(dir, "run"), mode);
};

describe("scanOwnGames", () => {
  it("lists slug/version dirs with executable run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-own-games-"));
    try {
      writePackage(dir, "soh", "9.3.1-1");
      expect(scanOwnGames(dir)).toEqual([{ slug: "soh", version: "9.3.1-1" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips build dirs, non-executable run and bad names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-own-games-"));
    try {
      // Недособранная версия — каталог с точкой, не проходит OwnGameVersion.
      mkdirSync(join(dir, "soh", ".build-9.3.2"), { recursive: true });
      writeFileSync(join(dir, "soh", ".build-9.3.2", "run"), "#!/bin/sh\n");
      chmodSync(join(dir, "soh", ".build-9.3.2", "run"), 0o755);
      // run не исполняемый.
      writePackage(dir, "soh", "x", 0o644);
      // Плохое имя слага (заглавные буквы).
      writePackage(dir, "Bad_Slug", "1");
      expect(scanOwnGames(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sorts by slug then version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-own-games-"));
    try {
      writePackage(dir, "zelda", "1.0.0");
      writePackage(dir, "soh", "2.0.0");
      writePackage(dir, "soh", "1.0.0");
      expect(scanOwnGames(dir)).toEqual([
        { slug: "soh", version: "1.0.0" },
        { slug: "soh", version: "2.0.0" },
        { slug: "zelda", version: "1.0.0" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("missing GAMES_DIR — empty list", async () => {
    expect(scanOwnGames("/nonexistent/path/for/own-games-test")).toEqual([]);
  });
});

describe("ownGameDir", () => {
  it("joins gamesDir, slug and version", () => {
    expect(ownGameDir("/raid/cloud-gaming/games", { slug: "soh", version: "9.3.1-1" })).toBe(
      "/raid/cloud-gaming/games/soh/9.3.1-1",
    );
  });
});

describe("constants", () => {
  it("mount, run and label", () => {
    expect(OWN_GAME_MOUNT).toBe("/opt/cg-game");
    expect(OWN_GAME_RUN).toBe("/opt/cg-game/run");
    expect(OWN_GAME_LABEL).toBe("cg.own-game");
  });
});
