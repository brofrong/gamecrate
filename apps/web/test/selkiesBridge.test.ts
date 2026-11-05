// Мост к Selkies (спека §5): какие сообщения уходят в iframe при настройках/их смене, что
// шлёт `attach`/переответ Selkies `serverSettings`, и что читает `readSelkiesStats` из глобалов
// окна стрима.
import { describe, expect, it, mock } from "bun:test";
import { defaultStreamSettings, type StreamSettings } from "@cg/rpc";
import {
  changedSettingsMessages,
  createSelkiesBridge,
  readSelkiesStats,
  settingsMessages,
} from "../src/lib/selkiesBridge";

/** Фейковое окно iframe: `postMessage`-мок и слушатели, которые можно дёргать руками. */
function fakeContentWindow() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    postMessage: mock((_message: unknown, _targetOrigin: string) => {}),
    addEventListener: mock((type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: mock((type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    }),
    fire: (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

/** Фейковый `<iframe>` с таким окном (вид ровно как в брифе задачи). */
function fakeFrame() {
  const contentWindow = fakeContentWindow();
  return {
    contentWindow,
    frame: { contentWindow } as unknown as HTMLIFrameElement,
  };
}

const PAGE_ORIGIN = "http://localhost:3000";

describe("settingsMessages", () => {
  it("auto sends the 20 Mbit ceiling", () => {
    expect(settingsMessages(defaultStreamSettings)).toEqual([
      { type: "settings", settings: { video_bitrate: 20_000 } },
    ]);
    expect(
      settingsMessages({
        ...defaultStreamSettings,
        quality: "manual",
        bitrateMbps: 8,
      }),
    ).toEqual([{ type: "settings", settings: { video_bitrate: 8_000 } }]);
  });

  it("bridge never sends resolution messages", () => {
    const resolutions: StreamSettings["resolution"][] = [
      "720p",
      "1080p",
      "1440p",
    ];
    for (const resolution of resolutions) {
      for (const quality of ["auto", "manual"] as const) {
        const settings: StreamSettings = {
          ...defaultStreamSettings,
          quality,
          resolution,
        };
        for (const message of settingsMessages(settings)) {
          expect(message.type).toBe("settings");
        }
      }
    }

    const prev: StreamSettings = { ...defaultStreamSettings, resolution: "720p" };
    const next: StreamSettings = { ...defaultStreamSettings, resolution: "1440p" };
    expect(changedSettingsMessages(prev, next)).toEqual([]);
  });
});

describe("changedSettingsMessages", () => {
  it("only changed values are sent", () => {
    const prevBitrate: StreamSettings = {
      ...defaultStreamSettings,
      quality: "manual",
      bitrateMbps: 10,
    };
    const nextBitrate: StreamSettings = { ...prevBitrate, bitrateMbps: 15 };
    expect(changedSettingsMessages(prevBitrate, nextBitrate)).toEqual([
      { type: "settings", settings: { video_bitrate: 15_000 } },
    ]);

    expect(
      changedSettingsMessages(defaultStreamSettings, {
        ...defaultStreamSettings,
        debug: "short",
      }),
    ).toEqual([]);

    expect(
      changedSettingsMessages(defaultStreamSettings, {
        ...defaultStreamSettings,
        menuTourSeen: true,
      }),
    ).toEqual([]);

    // defaultStreamSettings.bitrateMbps === autoBitrateMbps (20) — потолок не меняется.
    expect(
      changedSettingsMessages(defaultStreamSettings, {
        ...defaultStreamSettings,
        quality: "manual",
      }),
    ).toEqual([]);
  });
});

describe("createSelkiesBridge", () => {
  it("attach posts all settings with the page origin", () => {
    const bridge = createSelkiesBridge(() => defaultStreamSettings);
    const { frame, contentWindow } = fakeFrame();

    bridge.attach(frame);

    for (const message of settingsMessages(defaultStreamSettings)) {
      expect(contentWindow.postMessage).toHaveBeenCalledWith(
        message,
        PAGE_ORIGIN,
      );
    }
  });

  it("serverSettings re-applies the current settings", () => {
    let settings: StreamSettings = defaultStreamSettings;
    const bridge = createSelkiesBridge(() => settings);
    const { frame, contentWindow } = fakeFrame();

    bridge.attach(frame);
    const callsAfterAttach = contentWindow.postMessage.mock.calls.length;

    settings = { ...defaultStreamSettings, quality: "manual", bitrateMbps: 7 };
    contentWindow.fire("message", { data: { type: "serverSettings" } });

    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "settings", settings: { video_bitrate: 7_000 } },
      PAGE_ORIGIN,
    );
    expect(contentWindow.postMessage.mock.calls.length).toBeGreaterThan(
      callsAfterAttach,
    );

    const callsAfterServerSettings = contentWindow.postMessage.mock.calls.length;
    contentWindow.fire("message", { data: { type: "stats" } });
    expect(contentWindow.postMessage.mock.calls.length).toBe(
      callsAfterServerSettings,
    );
  });

  it("reattach drops the old listener", () => {
    const bridge = createSelkiesBridge(() => defaultStreamSettings);
    const first = fakeFrame();
    const second = fakeFrame();

    bridge.attach(first.frame);
    bridge.attach(second.frame);

    expect(first.contentWindow.removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.anything(),
    );

    second.contentWindow.postMessage.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => bridge.attach(second.frame)).not.toThrow();
    expect(() =>
      bridge.update(defaultStreamSettings, {
        ...defaultStreamSettings,
        quality: "manual",
        bitrateMbps: 5,
      }),
    ).not.toThrow();
  });

  it("stats open survives a reload", () => {
    const bridge = createSelkiesBridge(() => defaultStreamSettings);
    const first = fakeFrame();
    bridge.attach(first.frame);

    bridge.setStatsOpen(true);
    expect(first.contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "statsOpen", open: true },
      PAGE_ORIGIN,
    );

    const second = fakeFrame();
    bridge.attach(second.frame);
    expect(second.contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "statsOpen", open: true },
      PAGE_ORIGIN,
    );

    bridge.setStatsOpen(false);
    expect(second.contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "statsOpen", open: false },
      PAGE_ORIGIN,
    );

    const third = fakeFrame();
    bridge.attach(third.frame);
    const sentTypes = third.contentWindow.postMessage.mock.calls.map(
      ([message]) => (message as { type: string }).type,
    );
    expect(sentTypes).not.toContain("statsOpen");
  });
});

describe("readSelkiesStats", () => {
  it("picks only known fields", () => {
    const win = {
      stream_stats: {
        latest: {
          fps: 59.8,
          mbps: 18.42,
          rtt_ms: 12.3,
          decode_ms: 2.1,
          jitter_buffer_ms: 4,
          packet_loss_percent: 0.2,
          frames_dropped: 12,
          account: "x",
        },
      },
      stream_client: { codec: "H264", resolution: "1920x1080" },
    } as unknown as Window;

    expect(readSelkiesStats(win)).toEqual({
      fps: 59.8,
      mbps: 18.42,
      rttMs: 12.3,
      decodeMs: 2.1,
      jitterMs: 4,
      lossPercent: 0.2,
      framesDropped: 12,
      codec: "H264",
      resolution: "1920x1080",
    });

    const noLatest = {
      stream_stats: { latest: null },
      stream_client: { codec: "H264", resolution: "1920x1080" },
    } as unknown as Window;
    expect(readSelkiesStats(noLatest)).toBeNull();

    const badFps = {
      stream_stats: {
        latest: {
          fps: "60",
          mbps: 18.42,
          rtt_ms: 12.3,
          decode_ms: 2.1,
          jitter_buffer_ms: 4,
          packet_loss_percent: 0.2,
          frames_dropped: 12,
        },
      },
      stream_client: { codec: "H264", resolution: "1920x1080" },
    } as unknown as Window;
    expect(readSelkiesStats(badFps)?.fps).toBeNull();

    const throwing = {} as Window;
    Object.defineProperty(throwing, "stream_stats", {
      get(): never {
        throw new Error("boom");
      },
    });
    expect(readSelkiesStats(throwing)).toBeNull();
  });
});
