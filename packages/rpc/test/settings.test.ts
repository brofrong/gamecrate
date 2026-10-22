import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SessionSettings, defaultSessionSettings } from "../src/settings";

describe("SessionSettings", () => {
  it("decodes defaults", () => {
    const decoded = Schema.decodeUnknownSync(SessionSettings)(
      defaultSessionSettings,
    );
    expect(decoded).toEqual(defaultSessionSettings);
  });

  it("rejects idleWarningMinutes 0 and 121", () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionSettings)({
        ...defaultSessionSettings,
        idleWarningMinutes: 0,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SessionSettings)({
        ...defaultSessionSettings,
        idleWarningMinutes: 121,
      }),
    ).toThrow();
  });

  it("installTimeoutMinutes defaults to 180 and rejects 9 and 721", () => {
    expect(defaultSessionSettings.installTimeoutMinutes).toBe(180);
    expect(() =>
      Schema.decodeUnknownSync(SessionSettings)({
        ...defaultSessionSettings,
        installTimeoutMinutes: 9,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SessionSettings)({
        ...defaultSessionSettings,
        installTimeoutMinutes: 721,
      }),
    ).toThrow();
  });
});
