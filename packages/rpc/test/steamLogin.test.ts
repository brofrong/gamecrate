import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SteamLoginView } from "../src/steamLogin";

describe("SteamLoginView", () => {
  it("rejects internal states", () => {
    expect(() =>
      Schema.decodeUnknownSync(SteamLoginView)({
        attemptId: "a1",
        status: "pending",
        qrUrl: null,
        reason: null,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SteamLoginView)({
        attemptId: "a1",
        status: "cancelled",
        qrUrl: null,
        reason: null,
      }),
    ).toThrow();

    const waiting = {
      attemptId: "a1",
      status: "waiting",
      qrUrl: null,
      reason: null,
    } as const;
    expect(Schema.decodeUnknownSync(SteamLoginView)(waiting)).toEqual(
      waiting,
    );
  });
});
