import { describe, expect, it } from "bun:test";
import type { SessionLimit, SessionState } from "@cg/db";
import {
  type SessionSettings,
  defaultSessionSettings,
  steamLoginRequiredReason,
} from "@cg/rpc";
import {
  AGENT_TIMEOUT_MS,
  CLIENT_TIMEOUT_MS,
  failReasons,
  QUEUE_CLIENT_TIMEOUT_MS,
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
      ? { startedAt: T0, endedAt: seen, billable: true }
      : state === "disconnected"
        ? { startedAt: T0, endedAt: seen, billable: false }
        : null,
  limit: null,
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
      openSegment: {
        startedAt: lastSeen,
        endedAt: sec(13 * 60),
        billable: false,
      },
      limit: null,
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
      openSegment: {
        startedAt: lastSeen,
        endedAt: sec(15 * 60),
        billable: false,
      },
      limit: null,
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
      openSegment: {
        startedAt: min(10),
        endedAt: sec(16 * 60),
        billable: false,
      },
      limit: null,
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
      openSegment: { startedAt: min(5), endedAt: min(6), billable: true },
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

  it('queued without client for 2 min → ended with "Вы вышли из очереди"', () => {
    expect(QUEUE_CLIENT_TIMEOUT_MS).toBe(120_000);
    const s = snap("queued", {
      clientSeenAt: T0,
      agentSeenAt: null,
      lastInputAt: null,
    });
    expect(decide(s, tick, min(2), settings)).toEqual(unchanged("queued"));
    expect(decide(s, tick, sec(2 * 60 + 1), settings)).toEqual({
      state: "ended",
      ops: [],
      command: null,
      failReason: "Вы вышли из очереди",
    });
    // heartbeat'а ещё не было — считаем от stateSince
    expect(
      decide({ ...s, clientSeenAt: null }, tick, sec(2 * 60 + 1), settings)
        .failReason,
    ).toBe("Вы вышли из очереди");
    // порог не зависит от disconnectGraceMinutes
    expect(
      decide(s, tick, sec(2 * 60 + 1), {
        ...settings,
        disconnectGraceMinutes: 30,
      }).state,
    ).toBe("ended");
  });

  it("queued client seen 90 s ago → keep", () => {
    const s = snap("queued", {
      clientSeenAt: min(10),
      agentSeenAt: null,
      lastInputAt: null,
    });
    expect(decide(s, tick, sec(10 * 60 + 90), settings)).toEqual(
      unchanged("queued"),
    );
  });

  it("queued after install: stale client heartbeat counts from return to queue", () => {
    // heartbeat очереди не шёл во время установки: clientSeenAt 20 мин назад,
    // в queued сессия вернулась 10 с назад
    const now = min(30);
    const s = snap("queued", {
      stateSince: sec(30 * 60 - 10),
      clientSeenAt: min(10),
      agentSeenAt: null,
      lastInputAt: null,
    });
    expect(decide(s, tick, now, settings)).toEqual(unchanged("queued"));
    // без heartbeat'а 2 мин после возврата — выпадает
    const later = sec(30 * 60 - 10 + 121);
    expect(decide(s, tick, later, settings).failReason).toBe(
      "Вы вышли из очереди",
    );
  });

  it("starting still uses disconnectGraceMinutes", () => {
    // клиента нет 3 мин (> порога очереди, < K = 5) — starting ждёт
    const now = min(3);
    const s = snap("starting", { clientSeenAt: T0, agentSeenAt: now });
    expect(decide(s, tick, now, settings)).toEqual(unchanged("starting"));
    const later = sec(5 * 60 + 1);
    expect(decide({ ...s, agentSeenAt: later }, tick, later, settings)).toEqual(
      {
        state: "stopping",
        ops: [],
        command: "StopContainer",
        failReason: "Игрок отключился",
      },
    );
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

  it("failed event closes the open segment at the last agent heartbeat", () => {
    const now = min(7);
    const reason = "Не удалось запустить контейнер";
    const failed = { _tag: "Failed", reason } as const;
    // worker crash: the user is not billed past the last heartbeat
    expect(
      decide(
        snap("playing", { agentSeenAt: sec(6 * 60 + 40), clientSeenAt: now }),
        failed,
        now,
        settings,
      ),
    ).toEqual({
      state: "failed",
      ops: [{ _tag: "Close", at: sec(6 * 60 + 40) }],
      command: null,
      failReason: reason,
    });
    // agent never seen → now
    expect(
      decide(snap("playing", { agentSeenAt: null }, now), failed, now, settings)
        .ops,
    ).toEqual([{ _tag: "Close", at: now }]);
    // heartbeat older than the segment start → clamped to the start
    expect(
      decide(
        snap("playing", {
          agentSeenAt: min(1),
          openSegment: { startedAt: min(5), endedAt: min(6), billable: true },
        }),
        failed,
        now,
        settings,
      ).ops,
    ).toEqual([{ _tag: "Close", at: min(5) }]);
    expect(decide(snap("starting", {}, now), failed, now, settings)).toEqual({
      state: "failed",
      ops: [],
      command: null,
      failReason: reason,
    });
  });

  it("stop finished outside stopping closes at the segment's stored end, not now", () => {
    // GameExited was missed: the cloud-save wait after the last heartbeat is not billed
    const now = min(9);
    const s = snap("playing", {
      openSegment: { startedAt: T0, endedAt: min(7), billable: true },
    });
    expect(decide(s, { _tag: "StopFinished" }, now, settings)).toEqual({
      state: "ended",
      ops: [{ _tag: "Close", at: min(7) }],
      command: null,
      failReason: null,
    });
    // stored end later than now → clamped to now
    const ahead = snap("playing", {
      openSegment: { startedAt: T0, endedAt: min(10), billable: true },
    });
    expect(decide(ahead, { _tag: "StopFinished" }, now, settings).ops).toEqual([
      { _tag: "Close", at: now },
    ]);
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
          openSegment: {
            startedAt: min(30),
            endedAt: min(31),
            billable: true,
          },
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
  it("idle is measured within game time: a long silent start does not count", () => {
    // starting lasted 20 min without any input, then the game started
    const startedAt = min(20);
    const starting = snap("starting", {
      stateSince: T0,
      lastInputAt: null,
      clientSeenAt: startedAt,
      agentSeenAt: startedAt,
    });
    // start timeout is 15 min by default; use 30 so the start is not cut short
    const slow = { ...settings, startTimeoutMinutes: 30 };
    expect(
      decide(starting, { _tag: "GameStarted" }, startedAt, slow).state,
    ).toBe("playing");
    const playing: Snapshot = {
      state: "playing",
      stateSince: startedAt,
      clientSeenAt: sec(20 * 60 + 5),
      lastInputAt: null,
      agentSeenAt: sec(20 * 60 + 5),
      openSegment: { startedAt, endedAt: startedAt, billable: true },
      limit: null,
    };
    expect(decide(playing, tick, sec(20 * 60 + 5), settings)).toEqual(
      unchanged("playing"),
    );
    // input from before the game started is ignored too
    const preGameInput = { ...playing, lastInputAt: min(2) };
    expect(decide(preGameInput, tick, sec(20 * 60 + 5), settings)).toEqual(
      unchanged("playing"),
    );
    // N after the game start → idle_warning
    const later = sec(35 * 60 + 1);
    const fresh = { clientSeenAt: later, agentSeenAt: later };
    expect(decide({ ...playing, ...fresh }, tick, later, settings)).toEqual(
      unchanged("idle_warning"),
    );
    expect(
      decide({ ...preGameInput, ...fresh }, tick, later, settings),
    ).toEqual(unchanged("idle_warning"));
  });

  it("playing with lastInputAt null counts idle from stateSince", () => {
    const s = snap("playing", {
      lastInputAt: null,
      clientSeenAt: sec(15 * 60 + 1),
      agentSeenAt: sec(15 * 60 + 1),
    });
    expect(decide(s, tick, min(15), settings)).toEqual(unchanged("playing"));
    expect(decide(s, tick, sec(15 * 60 + 1), settings)).toEqual(
      unchanged("idle_warning"),
    );
  });

  it("idle_warning: input after the warning but beyond M does not rescue", () => {
    // late Tick: input came 2 min 5 s after the warning (M = 2 min)
    const now = sec(2 * 60 + 10);
    const s = snap("idle_warning", {
      stateSince: T0,
      lastInputAt: sec(2 * 60 + 5),
      clientSeenAt: now,
      agentSeenAt: now,
    });
    expect(decide(s, tick, now, settings)).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: now }],
      command: "StopContainer",
      failReason: null,
    });
  });

  it("game start with a stray open segment closes it zero-length first", () => {
    const now = min(3);
    const s = snap(
      "starting",
      { openSegment: { startedAt: min(1), endedAt: min(2), billable: true } },
      now,
    );
    expect(decide(s, { _tag: "GameStarted" }, now, settings)).toEqual({
      state: "playing",
      ops: [
        { _tag: "Close", at: min(1) },
        { _tag: "Open", at: now, billable: true },
      ],
      command: null,
      failReason: null,
    });
  });

  it("user stop while disconnected leaves the gap unbilled", () => {
    const now = min(12);
    const s = snap("disconnected", { clientSeenAt: min(10), agentSeenAt: now });
    const d = decide(s, { _tag: "UserStop" }, now, settings);
    expect(d).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: now }],
      command: "StopContainer",
      failReason: null,
    });
    expect(d.ops.some((op) => op._tag === "MarkOpenBillable")).toBe(false);
  });

  it("installing never bills and times out with installTimeout reason", () => {
    const events: LifecycleEvent[] = [
      { _tag: "Scheduled" },
      { _tag: "StreamReady" },
      { _tag: "GameStarted" },
      { _tag: "GameExited" },
      { _tag: "InstallStarted" },
      tick,
    ];
    // Ни агента сессии, ни браузера: installing ждёт только установку.
    const s = snap("installing", { agentSeenAt: null, clientSeenAt: T0 });
    for (let m = 0; m <= 180; m += 5) {
      const now = min(m);
      for (const e of events)
        expect(decide(s, e, now, settings)).toEqual(unchanged("installing"));
    }
    const failed = (failReason: string): Decision => ({
      state: "failed",
      ops: [],
      command: null,
      failReason,
    });
    expect(decide(s, tick, sec(180 * 60 + 1), settings)).toEqual(
      failed("Установка не закончилась за отведённое время"),
    );
    // Таймаут из настроек применяется к уже идущей установке.
    const short = { ...settings, installTimeoutMinutes: 10 };
    expect(decide(s, tick, min(10), short)).toEqual(unchanged("installing"));
    expect(decide(s, tick, sec(10 * 60 + 1), short)).toEqual(
      failed("Установка не закончилась за отведённое время"),
    );
    // Установка упала: пользователю — общая причина, техническая — в задаче.
    expect(
      decide(
        s,
        { _tag: "InstallFailed", reason: "Загрузка остановилась" },
        min(1),
        settings,
      ),
    ).toEqual(failed("Не удалось установить игру"));
    // Причина для пользователя (нужен вход в Steam) — показывается как есть.
    expect(
      decide(
        s,
        {
          _tag: "InstallFailed",
          reason: steamLoginRequiredReason,
          userReason: steamLoginRequiredReason,
        },
        min(1),
        settings,
      ),
    ).toEqual(failed(steamLoginRequiredReason));
    // Остановка без контейнера, ожидание не оплачивается.
    expect(decide(s, { _tag: "UserStop" }, min(1), settings)).toEqual(
      unchanged("ended"),
    );
  });

  it("install finished returns session to queued", () => {
    const queued = snap("queued", { agentSeenAt: null });
    expect(
      decide(queued, { _tag: "InstallStarted" }, sec(1), settings),
    ).toEqual(unchanged("installing"));
    const installing = snap("installing", { agentSeenAt: null });
    expect(
      decide(installing, { _tag: "InstallFinished" }, min(30), settings),
    ).toEqual(unchanged("queued"));
    // Задачу отменили, пока сессия присоединялась, — ждать новую.
    expect(
      decide(installing, { _tag: "InstallCancelled" }, min(30), settings),
    ).toEqual(unchanged("queued"));
    // Итоги установки вне installing ничего не меняют.
    for (const state of ["queued", "starting", "playing"] as const) {
      const s = snap(state, {}, min(1));
      expect(decide(s, { _tag: "InstallFinished" }, min(1), settings)).toEqual(
        unchanged(state),
      );
      expect(
        decide(s, { _tag: "InstallFailed", reason: "x" }, min(1), settings),
      ).toEqual(unchanged(state));
    }
    expect(
      decide(snap("starting"), { _tag: "InstallStarted" }, sec(1), settings),
    ).toEqual(unchanged("starting"));
  });

  it('playing with an exhausted minutes limit stops with "Часы закончились"', () => {
    const now = min(5);
    const s = snap("playing", {}, now);
    const limit: SessionLimit = { remainingMs: 0, reason: "minutes" };
    expect(decide({ ...s, limit }, tick, now, settings)).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: now }],
      command: "StopContainer",
      failReason: failReasons.minutesOut,
    });
  });

  it('idle_warning with an exhausted session-length limit stops with "Достигнут лимит длины сессии"', () => {
    const now = min(5);
    const s = snap("idle_warning", {}, now);
    const limit: SessionLimit = { remainingMs: -1, reason: "session_length" };
    expect(decide({ ...s, limit }, tick, now, settings)).toEqual({
      state: "stopping",
      ops: [{ _tag: "Close", at: now }],
      command: "StopContainer",
      failReason: failReasons.sessionTooLong,
    });
  });

  it("disconnected client wins over an exhausted limit", () => {
    // Клиента не видно дольше CLIENT_TIMEOUT_MS: → disconnected, не stopping,
    // даже если лимит уже исчерпан.
    const now = sec(16);
    const s = snap("playing", { clientSeenAt: T0, agentSeenAt: now }, T0);
    const limit: SessionLimit = { remainingMs: 0, reason: "minutes" };
    expect(decide({ ...s, limit }, tick, now, settings).state).toBe(
      "disconnected",
    );
  });

  it("limit null never stops the session on its own", () => {
    const s = snap("playing", { lastInputAt: T0 }, min(1));
    expect(s.limit).toBeNull();
    expect(decide(s, tick, min(1), settings)).toEqual(unchanged("playing"));
  });
});
