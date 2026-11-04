import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { AgentCommand } from "../src/agent";
import {
  isOwnAppId,
  OwnGameManifest,
  OwnGamePackage,
  ownGameAssetUrl,
} from "../src/ownGames";

const baseManifest = {
  appId: 1900000001,
  slug: "soh",
  name: "Ship of Harkinian",
  version: "9.3.1-1",
  binary: "soh.elf",
  upstream: {
    repo: "https://github.com/HarbourMasters/Shipwright",
    ref: "9.3.1",
  },
  inputs: [{ name: "gamepad", label: "Геймпад" }],
  site: {
    description: "Фанатский ПК-порт Ocarina of Time.",
    controls: [{ action: "Прыжок", keyboard: "Пробел", gamepad: "A" }],
    source: {
      label: "Shipwright",
      url: "https://github.com/HarbourMasters/Shipwright",
    },
    screenshots: ["cover.jpg"],
  },
  requirements: { minVramBytes: 0, minRamBytes: 0, minCpuThreads: 0 },
} as const;

describe("ownGames", () => {
  it("isOwnAppId splits at OWN_APP_ID_MIN", () => {
    expect(isOwnAppId(1_899_999_999)).toBe(false);
    expect(isOwnAppId(1_900_000_001)).toBe(true);
  });

  it("package rejects path and bind characters", () => {
    for (const version of ["../x", "a:b", "a,b", "a b", ".hidden"])
      expect(Schema.is(OwnGamePackage)({ slug: "soh", version })).toBe(false);
    expect(Schema.is(OwnGamePackage)({ slug: "soh", version: "9.3.1-1" })).toBe(
      true,
    );
  });

  it("manifest rejects appId below the own range", () => {
    expect(() =>
      Schema.decodeUnknownSync(OwnGameManifest)({
        ...baseManifest,
        appId: 570,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OwnGameManifest)(baseManifest),
    ).not.toThrow();
  });

  it("StartSession without ownGame decodes as before", () => {
    const start = {
      _tag: "StartSession",
      sessionId: "s1",
      userId: "u1",
      appId: 1900000001,
      slot: 0,
      udpPort: 59000,
      profile: null,
      steamLogin: null,
    } as const;
    expect(Schema.decodeUnknownSync(AgentCommand)(start)).toEqual(start);
  });

  it("ownGameAssetUrl", () =>
    expect(ownGameAssetUrl(1900000001, "cover.jpg")).toBe(
      "/own-games/1900000001/cover.jpg",
    ));
});

// Манифесты в games/<slug>/game.json читают сборка (deploy/add-game.sh) и сайт — каждый
// должен декодироваться по OwnGameManifest, а картинки site/ — лежать рядом.
describe("games/soh/game.json", () => {
  const dir = join(import.meta.dir, "../../../games/soh");
  const manifest = Schema.decodeUnknownSync(OwnGameManifest)(
    JSON.parse(readFileSync(join(dir, "game.json"), "utf8")),
  );

  it("decodes as OwnGameManifest", () => {
    expect(manifest.appId).toBe(1900000001);
    expect(manifest.slug).toBe("soh");
    expect(manifest.inputs.map((i) => i.name)).toEqual(["rom"]);
  });

  it("has every site image", () => {
    for (const file of [
      "header.jpg",
      "hero.jpg",
      "cover.jpg",
      ...manifest.site.screenshots,
    ])
      expect(existsSync(join(dir, "site", file))).toBe(true);
  });
});
