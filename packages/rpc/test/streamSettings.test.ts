import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  allowedDisplaySize,
  decodeStreamSettings,
  defaultDisplaySize,
  defaultStreamSettings,
  displaySizeOf,
  StreamSettings,
} from "../src/streamSettings";

describe("StreamSettings schema", () => {
  it("decodes defaults", () => {
    expect(
      Schema.decodeUnknownSync(StreamSettings)(defaultStreamSettings),
    ).toEqual(defaultStreamSettings);
  });

  it("rejects bitrate 1, 41 and 2.5", () => {
    for (const bitrateMbps of [1, 41, 2.5]) {
      expect(() =>
        Schema.decodeUnknownSync(StreamSettings)({
          ...defaultStreamSettings,
          bitrateMbps,
        }),
      ).toThrow();
    }
  });
});

describe("decodeStreamSettings", () => {
  it("falls back per field, drops unknown keys", () => {
    expect(
      decodeStreamSettings({
        quality: "turbo",
        bitrateMbps: 99,
        debug: "detailed",
        menuSeen: true,
        localLayout: "yes",
        extra: 1,
      }),
    ).toEqual({
      ...defaultStreamSettings,
      debug: "detailed",
      menuSeen: true,
    });
    expect(decodeStreamSettings({ localLayout: true }).localLayout).toBe(true);
  });

  it("non-objects fall back to defaults entirely", () => {
    expect(decodeStreamSettings("garbage")).toEqual(defaultStreamSettings);
    expect(decodeStreamSettings(null)).toEqual(defaultStreamSettings);
    expect(decodeStreamSettings([])).toEqual(defaultStreamSettings);
  });

  it("old resolution value falls back to 1080p", () => {
    expect(
      decodeStreamSettings({ ...defaultStreamSettings, resolution: "window" }),
    ).toEqual({ ...defaultStreamSettings, resolution: "1080p" });
  });
});

describe("displaySizeOf", () => {
  it("manual resolution maps to its size", () => {
    expect(
      displaySizeOf({
        ...defaultStreamSettings,
        quality: "manual",
        resolution: "720p",
      }),
    ).toEqual({ width: 1280, height: 720 });
    expect(
      displaySizeOf({
        ...defaultStreamSettings,
        quality: "manual",
        resolution: "1440p",
      }),
    ).toEqual({ width: 2560, height: 1440 });
  });

  it("auto ignores the stored resolution", () => {
    expect(
      displaySizeOf({
        ...defaultStreamSettings,
        quality: "auto",
        resolution: "1440p",
      }),
    ).toEqual(defaultDisplaySize);
  });
});

describe("allowedDisplaySize", () => {
  it("passes through a whitelisted size", () => {
    expect(allowedDisplaySize({ width: 2560, height: 1440 })).toEqual({
      width: 2560,
      height: 1440,
    });
  });

  it("falls back to the default size for anything else", () => {
    expect(allowedDisplaySize({ width: 1000, height: 700 })).toEqual(
      defaultDisplaySize,
    );
    expect(allowedDisplaySize({ width: 1280, height: 1080 })).toEqual(
      defaultDisplaySize,
    );
    expect(allowedDisplaySize(undefined)).toEqual(defaultDisplaySize);
    expect(allowedDisplaySize("1080p")).toEqual(defaultDisplaySize);
  });
});
