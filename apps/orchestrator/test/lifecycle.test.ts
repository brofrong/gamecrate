import { describe, expect, it } from "bun:test";
import type { SessionState } from "@cg/db";
import { type SessionSettings, defaultSessionSettings } from "@cg/rpc";
import {
  AGENT_TIMEOUT_MS,
  CLIENT_TIMEOUT_MS,
  type Decision,
  type LifecycleEvent,
  type Snapshot,
  decide,
} from "../src/lifecycle";

const T0 = new Date("2026-10-17T12:00:00.000Z");
const sec = (s: number): Date => new Date(T0.getTime() + s * 1000);
const min = (m: number): Date => sec(m * 60);

const settings: SessionSettings = defaultSessionSettings; // N=15, M=2, K=5, start=15

const tick: LifecycleEvent = { _tag: "Tick" };

/** Snapshot where everyone (client, input, agent) was seen at `seen`. */
const snap = (
  state: SessionState,
  overrides: Partial<Snapshot> = {},
  seen: Date = T0,
): Snapshot => ({
  state,
  stateSince: T0,
  clientSeenAt: seen,
  lastInputAt: seen,
  agentSeenAt: seen,
  openSegment:
    state === "playing" || state === "idle_warning"
      ? { startedAt: T0, billable: true }
      : state === "disconnected"
        ? { startedAt: T0, billable: false }
        : null,
  ...overrides,
});

const unchanged = (state: SessionState): Decision => ({
  state,
  ops: [],
  command: null,
  failReason: null,
});

describe("constants", () => {
  it("client and agent timeouts", () => {
    expect(CLIENT_TIMEOUT_MS).toBe(15_000);
    expect(AGENT_TIMEOUT_MS).toBe(90_000);
  });
});

describe("decide", () => {
  it("game start opens billable segment", () => {
    const now = min(3);
    const d = decide(
      snap("starting", {}, sec(170)),
      { _tag: "GameStarted" },
      now,
      settings,
    );
    expect(d).toEqual({
      state: "playing",
      ops: [{ _tag: "Open", at: now, billable: true }],
      command: null,
      failReason: null,
    });
  });

  it("idle counts: playing → idle_warning after N, segment stays open billable", () => {
    // client and agent fresh, last input 15 min 1 s ago
    const s = snap("playing", {
      lastInputAt: T0,
      clientSeenAt: min(15),
      agentSeenAt: min(15),
    });
    expect(decide(s, tick, min(15), settings)).toEqual(unchanged("playing"));
    const d = decide(s, tick, sec(15 * 60 + 1), settings);
    expect(d).toEqual(unchanged("idle_warning"));
  });

  it("idle_warning answered returns to playing", () => {
    const s = snap("idle_warning", {
      stateSince: T0,
      lastInputAt: sec(30),
      clientSeenAt: sec(40),
      agentSeenAt: sec(40),
    });
    expect(decide(s, tick, sec(45), settings)).toEqual(unchanged("playing"));
    // no input since the warning → still waiting
    const waiting = { ...s, lastInputAt: sec(-10) };
    expect(decide(waiting, tick, sec(45), settings)).toEqual(
      unchanged("idle_warning"),
    );
  });

  it("idle_warning unanswered for M stops and closes segment", () => {
    const now = sec(2 * 60 + 1);
    const s = snap("idle_warning", {
      lastInputAt: sec(-15 * 60),
      clientSeenAt: sec(120),
      agentSeenAt: sec(120),
    });
    expect(decide(s, tick, min(2), settings)).toEqual(
      unchanged("idle_warning"),
    );
    expect(decide(s, tick, now, settings)).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: now }],
      command: "StopContainer",
      failReason: null,
    });
  });

  it("disconnect then return within K bills the gap", () => {
    // playing since T0, browser last seen at 10 min, detected 16 s later
    const lastSeen = min(10);
    const detectedAt = sec(10 * 60 + 16);
    const playing = snap("playing", {
      clientSeenAt: lastSeen,
      lastInputAt: lastSeen,
      agentSeenAt: detectedAt,
    });
    const d1 = decide(playing, tick, detectedAt, settings);
    expect(d1).toEqual({
      state: "disconnected",
      ops: [
        { _tag: "Close", at: lastSeen },
        { _tag: "Open", at: lastSeen, billable: false },
      ],
      command: null,
      failReason: null,
    });

    // 3 minutes later the tab is back
    const returnedAt = sec(13 * 60 + 16);
    const disconnected: Snapshot = {
      state: "disconnected",
      stateSince: detectedAt,
      clientSeenAt: sec(13 * 60 + 10),
      lastInputAt: lastSeen,
      agentSeenAt: sec(13 * 60),
      openSegment: { startedAt: lastSeen, billable: false },
    };
    const d2 = decide(disconnected, tick, returnedAt, settings);
    expect(d2).toEqual({
      state: "playing",
      ops: [
        { _tag: "MarkOpenBillable" },
        { _tag: "Close", at: returnedAt },
        { _tag: "Open", at: returnedAt, billable: true },
      ],
      command: null,
      failReason: null,
    });

    // still gone within K → nothing happens
    const stillGone = { ...disconnected, clientSeenAt: lastSeen };
    expect(decide(stillGone, tick, returnedAt, settings)).toEqual(
      unchanged("disconnected"),
    );
  });

  it("disconnect without return closes unbilled", () => {
    const lastSeen = min(10);
    const detectedAt = sec(10 * 60 + 16);
    const s: Snapshot = {
      state: "disconnected",
      stateSince: detectedAt,
      clientSeenAt: lastSeen,
      lastInputAt: lastSeen,
      agentSeenAt: sec(15 * 60 + 10),
      openSegment: { startedAt: lastSeen, billable: false },
    };
    expect(decide(s, tick, sec(15 * 60 + 16), settings)).toEqual(
      unchanged("disconnected"),
    );
    const d = decide(s, tick, sec(15 * 60 + 17), settings);
    expect(d).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: detectedAt }],
      command: "StopContainer",
      failReason: null,
    });
    // the open segment is never marked billable
    expect(d.ops.some((op) => op._tag === "MarkOpenBillable")).toBe(false);
  });

  it("disconnected: client seen again only after K does not bill the gap", () => {
    // late Tick: the tab came back 6 min after detection (> K) → stop, unbilled
    const detectedAt = sec(10 * 60 + 16);
    const s: Snapshot = {
      state: "disconnected",
      stateSince: detectedAt,
      clientSeenAt: sec(16 * 60 + 16),
      lastInputAt: min(10),
      agentSeenAt: sec(16 * 60 + 16),
      openSegment: { startedAt: min(10), billable: false },
    };
    expect(decide(s, tick, sec(16 * 60 + 20), settings)).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: detectedAt }],
      command: "StopContainer",
      failReason: null,
    });
  });

  it("starting never bills and times out", () => {
    const events: LifecycleEvent[] = [
      { _tag: "Scheduled" },
      { _tag: "StreamReady" },
      tick,
    ];
    for (let m = 0; m <= 15; m++) {
      const now = min(m);
      const s = snap("starting", {}, now);
      for (const e of events) {
        const d = decide(s, e, now, settings);
        expect(d.state).toBe("starting");
        expect(d.ops).toEqual([]);
      }
    }
    const now = sec(15 * 60 + 1);
    expect(decide(snap("starting", {}, now), tick, now, settings)).toEqual({
      state: "stopping",
      ops: [],
      command: "StopContainer",
      failReason: "Игра не запустилась за отведённое время",
    });
  });

  it("starting: client gone for K stops without segments", () => {
    const now = sec(5 * 60 + 1);
    const s = snap("starting", { clientSeenAt: T0, agentSeenAt: now });
    expect(decide(s, tick, min(5), settings)).toEqual(unchanged("starting"));
    expect(decide(s, tick, now, settings)).toEqual({
      state: "stopping",
      ops: [],
      command: "StopContainer",
      failReason: "Игрок отключился",
    });
    // never seen at all → counted from stateSince
    expect(
      decide({ ...s, clientSeenAt: null }, tick, now, settings).state,
    ).toBe("stopping");
  });

  it("lost agent fails from any active state", () => {
    const agentSeenAt = min(1);
    const now = sec(60 + 91);
    const states: SessionState[] = [
      "starting",
      "playing",
      "idle_warning",
      "disconnected",
      "stopping",
    ];
    for (const state of states) {
      const s = snap(state, {
        agentSeenAt,
        stateSince: sec(30),
        // disconnected: keep the client gone so the return rule does not fire
        clientSeenAt: state === "disconnected" ? sec(29) : now,
        lastInputAt: now,
      });
      // exactly 90 s of silence is still fine
      expect(decide(s, tick, sec(60 + 90), settings).state).toBe(state);
      const d = decide(s, tick, now, settings);
      expect(d.state).toBe("failed");
      expect(d.failReason).toBe("Сервер с игрой перестал отвечать");
      expect(d.command).toBeNull();
      expect(d.ops).toEqual(
        s.openSegment ? [{ _tag: "Close", at: agentSeenAt }] : [],
      );
    }
    // queued has no agent yet
    const queued = snap("queued", { agentSeenAt: null, clientSeenAt: now });
    expect(decide(queued, tick, now, settings)).toEqual(unchanged("queued"));
  });

  it("lost agent: segment is never closed before it started", () => {
    // agent last seen before the current segment was opened (return at 5 min)
    const s = snap("playing", {
      agentSeenAt: min(4),
      clientSeenAt: sec(6 * 60),
      lastInputAt: sec(6 * 60),
      openSegment: { startedAt: min(5), billable: true },
    });
    expect(decide(s, tick, sec(6 * 60 + 1), settings).ops).toEqual([
      { _tag: "Close", at: min(5) },
    ]);
  });

  it("settings change applies to running timers", () => {
    const s = snap("playing", {
      lastInputAt: T0,
      clientSeenAt: min(2),
      agentSeenAt: min(2),
    });
    const now = min(2);
    expect(
      decide(s, tick, now, { ...settings, idleWarningMinutes: 15 }).state,
    ).toBe("playing");
    expect(
      decide(s, tick, now, { ...settings, idleWarningMinutes: 1 }).state,
    ).toBe("idle_warning");
    // the other timers too
    const warn = snap("idle_warning", {
      lastInputAt: sec(-1),
      clientSeenAt: now,
      agentSeenAt: now,
    });
    expect(
      decide(warn, tick, now, { ...settings, idleGraceMinutes: 1 }).state,
    ).toBe("stopping");
    expect(
      decide(warn, tick, now, { ...settings, idleGraceMinutes: 3 }).state,
    ).toBe("idle_warning");
    const disc = snap("disconnected", {
      clientSeenAt: sec(-16),
      agentSeenAt: now,
    });
    expect(
      decide(disc, tick, now, { ...settings, disconnectGraceMinutes: 1 }).state,
    ).toBe("stopping");
    expect(
      decide(disc, tick, now, { ...settings, disconnectGraceMinutes: 5 }).state,
    ).toBe("disconnected");
    const starting = snap("starting", {}, now);
    expect(
      decide(starting, tick, now, { ...settings, startTimeoutMinutes: 5 })
        .state,
    ).toBe("starting");
    const later = sec(5 * 60 + 1);
    expect(
      decide(snap("starting", {}, later), tick, later, {
        ...settings,
        startTimeoutMinutes: 5,
      }).failReason,
    ).toBe("Игра не запустилась за отведённое время");
  });

  it("user stop and game exit close the segment", () => {
    const now = min(20);
    for (const state of ["playing", "idle_warning"] as const) {
      const s = snap(state, {}, now);
      expect(decide(s, { _tag: "UserStop" }, now, settings)).toEqual({
        state: "stopping",
        ops: [{ _tag: "Close", at: now }],
        command: "StopContainer",
        failReason: null,
      });
      expect(decide(s, { _tag: "GameExited" }, now, settings)).toEqual({
        state: "stopping",
        ops: [{ _tag: "Close", at: now }],
        command: null,
        failReason: null,
      });
    }
    // starting: nothing to close
    expect(
      decide(snap("starting", {}, now), { _tag: "UserStop" }, now, settings),
    ).toEqual({
      state: "stopping",
      ops: [],
      command: "StopContainer",
      failReason: null,
    });
    // stopping → ended on StopFinished
    expect(
      decide(
        snap("stopping", {}, now),
        { _tag: "StopFinished" },
        now,
        settings,
      ),
    ).toEqual(unchanged("ended"));
  });

  it("game exit while disconnected closes the unbilled segment", () => {
    const now = min(12);
    const s = snap("disconnected", { clientSeenAt: min(10), agentSeenAt: now });
    const d = decide(s, { _tag: "GameExited" }, now, settings);
    expect(d).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: now }],
      command: null,
      failReason: null,
    });
  });

  it("queued session of a vanished client ends after K", () => {
    const s = snap("queued", {
      clientSeenAt: T0,
      agentSeenAt: null,
      lastInputAt: null,
    });
    expect(decide(s, tick, min(5), settings)).toEqual(unchanged("queued"));
    expect(decide(s, tick, sec(5 * 60 + 1), settings)).toEqual({
      state: "ended",
      ops: [],
      command: null,
      failReason: "Игрок отключился",
    });
  });

  it("queued: scheduled → starting; user stop ends without a container", () => {
    const s = snap("queued", { agentSeenAt: null });
    expect(decide(s, { _tag: "Scheduled" }, sec(1), settings)).toEqual(
      unchanged("starting"),
    );
    expect(decide(s, { _tag: "UserStop" }, sec(1), settings)).toEqual(
      unchanged("ended"),
    );
    expect(decide(s, { _tag: "GameExited" }, sec(1), settings)).toEqual(
      unchanged("queued"),
    );
  });

  it("failed event closes the open segment at now", () => {
    const now = min(7);
    const reason = "Не удалось запустить контейнер";
    expect(
      decide(
        snap("playing", {}, now),
        { _tag: "Failed", reason },
        now,
        settings,
      ),
    ).toEqual({
      state: "failed",
      ops: [{ _tag: "Close", at: now }],
      command: null,
      failReason: reason,
    });
    expect(
      decide(
        snap("starting", {}, now),
        { _tag: "Failed", reason },
        now,
        settings,
      ),
    ).toEqual({ state: "failed", ops: [], command: null, failReason: reason });
  });

  it("stop finished outside stopping still ends with the segment closed", () => {
    const now = min(7);
    expect(
      decide(snap("playing", {}, now), { _tag: "StopFinished" }, now, settings),
    ).toEqual({
      state: "ended",
      ops: [{ _tag: "Close", at: now }],
      command: null,
      failReason: null,
    });
  });

  it("terminal states ignore every event and repair a stray open segment", () => {
    const events: LifecycleEvent[] = [
      { _tag: "Scheduled" },
      { _tag: "StreamReady" },
      { _tag: "GameStarted" },
      { _tag: "GameExited" },
      { _tag: "UserStop" },
      { _tag: "StopFinished" },
      { _tag: "Failed", reason: "x" },
      tick,
    ];
    const now = min(60);
    for (const state of ["ended", "failed"] as const) {
      for (const e of events) {
        expect(
          decide(
            snap(state, { agentSeenAt: null, clientSeenAt: null }),
            e,
            now,
            settings,
          ),
        ).toEqual(unchanged(state));
        // an inconsistent snapshot: open segment in a terminal state → zero-length close
        const stray = snap(state, {
          openSegment: { startedAt: min(30), billable: true },
        });
        expect(decide(stray, e, now, settings)).toEqual({
          state,
          ops: [{ _tag: "Close", at: min(30) }],
          command: null,
          failReason: null,
        });
      }
    }
  });

  it("irrelevant events leave the state alone", () => {
    const now = min(1);
    expect(
      decide(snap("playing", {}, now), { _tag: "GameStarted" }, now, settings),
    ).toEqual(unchanged("playing"));
    expect(
      decide(snap("playing", {}, now), { _tag: "Scheduled" }, now, settings),
    ).toEqual(unchanged("playing"));
    expect(
      decide(snap("stopping", {}, now), { _tag: "UserStop" }, now, settings),
    ).toEqual(unchanged("stopping"));
    expect(
      decide(snap("stopping", {}, now), { _tag: "GameExited" }, now, settings),
    ).toEqual(unchanged("stopping"));
  });
});
