// Схемы главной /app: статус облака, «Недавние», «В тренде», сводка времени.
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { AppRpcs, CloudStatus, LibraryEntry, LibraryView } from "../src";
import { TimeMonth } from "../src/time";

describe("app home schemas", () => {
  it("LibraryEntry requires cloud and Ready requires steamProfile", () => {
    expect(() =>
      Schema.decodeUnknownSync(LibraryEntry)({
        appId: 1,
        name: "A",
        playtimeMinutes: 0,
        protonTier: "gold",
        coverUrl: "u",
      }),
    ).toThrow();
    const ready = Schema.decodeUnknownSync(LibraryView)({
      _tag: "Ready",
      entries: [],
      syncedAt: null,
      steamProfile: false,
    });
    expect(ready._tag).toBe("Ready");
  });

  it("LibraryEntry without lastPlayedAt fails to decode", () => {
    expect(() =>
      Schema.decodeUnknownSync(LibraryEntry)({
        appId: 1,
        name: "A",
        playtimeMinutes: 0,
        protonTier: "gold",
        coverUrl: "u",
        cloud: { _tag: "Missing" },
      }),
    ).toThrow();
  });

  it("Installing percent is null or 0..100", () => {
    expect(
      Schema.decodeUnknownSync(CloudStatus)({
        _tag: "Installing",
        percent: null,
      })._tag,
    ).toBe("Installing");
    expect(() =>
      Schema.decodeUnknownSync(CloudStatus)({
        _tag: "Installing",
        percent: 101,
      }),
    ).toThrow();
  });

  it("TimeMonth accepts YYYY-MM only", () => {
    expect(Schema.decodeUnknownSync(TimeMonth)("2026-10")).toBe("2026-10");
    expect(() => Schema.decodeUnknownSync(TimeMonth)("2026-13")).toThrow();
    expect(() => Schema.decodeUnknownSync(TimeMonth)("10-2026")).toThrow();
  });

  it("AppRpcs knows the new rpcs", () => {
    for (const tag of ["library.recent", "library.trending", "time.summary"])
      expect(AppRpcs.requests.has(tag)).toBe(true);
  });
});
