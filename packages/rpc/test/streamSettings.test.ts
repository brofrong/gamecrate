import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  allowedDisplaySize,
  capResolution,
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

  it("старый клиент без fullscreenTutorialSeen проходит схему — обучение не пройдено", () => {
    const { fullscreenTutorialSeen: _, ...old } = defaultStreamSettings;
    expect(
      Schema.decodeUnknownSync(StreamSettings)({ ...old, menuTourSeen: true }),
    ).toEqual({ ...defaultStreamSettings, menuTourSeen: true });
  });

  it("старый клиент с menuSeen и без menuTourSeen проходит схему — обход не пройден", () => {
    const { menuTourSeen: _, ...old } = defaultStreamSettings;
    expect(
      Schema.decodeUnknownSync(StreamSettings)({
        ...old,
        menuSeen: true,
        fullscreenTutorialSeen: true,
      }),
    ).toEqual({ ...defaultStreamSettings, fullscreenTutorialSeen: true });
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
        menuTourSeen: true,
        menuSeen: true,
        localLayout: "yes",
        fullscreenTutorialSeen: 1,
        extra: 1,
      }),
    ).toEqual({
      ...defaultStreamSettings,
      debug: "detailed",
      menuTourSeen: true,
    });
    expect(decodeStreamSettings({ localLayout: true }).localLayout).toBe(true);
    expect(
      decodeStreamSettings({ fullscreenTutorialSeen: true })
        .fullscreenTutorialSeen,
    ).toBe(true);
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

describe("capResolution", () => {
  it("clamps down to the tariff ceiling", () => {
    expect(capResolution("1440p", "1080p")).toBe("1080p");
  });

  it("passes through a resolution within the ceiling", () => {
    expect(capResolution("720p", "1080p")).toBe("720p");
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
