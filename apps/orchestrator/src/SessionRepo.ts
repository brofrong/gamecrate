// Сессии в БД для оркестратора: настройки, снимок под блокировкой строки и
// применение решений автомата (`decide`) одной транзакцией.
import {
  Db,
  playSegments,
  type SessionState,
  sessions,
  settings,
} from "@cg/db";
import {
  defaultSessionSettings,
  SessionSettings,
  sessionSettingsKey,
} from "@cg/rpc";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import {
  type Decision,
  type LifecycleEvent,
  type Snapshot,
  decide,
} from "./lifecycle";

export type SessionRow = typeof sessions.$inferSelect;

const terminalStates: SessionState[] = ["ended", "failed"];

/** Условие «сессия активна» (не `ended`/`failed`). */
export const isActive = notInArray(sessions.state, terminalStates);

const isTerminal = (state: SessionState) => terminalStates.includes(state);

const decodeSettings = Schema.decodeUnknownEffect(SessionSettings);

/**
 * Настройки сессий из `settings["session"]`. Записи нет — значения по умолчанию;
 * значение не проходит схему (или БД недоступна) — тоже по умолчанию, с
 * предупреждением в логе.
 */
export const loadSettings = (): Effect.Effect<SessionSettings, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, sessionSettingsKey));
    if (row === undefined) {
      yield* Effect.logDebug("Session settings not set, using defaults");
      return defaultSessionSettings;
    }
    return yield* decodeSettings(row.value);
  }).pipe(
    Effect.catch((error) =>
      Effect.as(
        Effect.logWarning(
          "Session settings are invalid or unreadable, using defaults",
          String(error),
        ),
        defaultSessionSettings,
      ),
    ),
  );

/** Строка сессии под `FOR UPDATE` (вызывать внутри транзакции). */
const lockSession = (sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update");
    return row;
  });

/** Снимок для `decide`: строка сессии + её открытый отрезок. */
const snapshotOf = (row: SessionRow) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [segment] = yield* db
      .select({
        startedAt: playSegments.startedAt,
        endedAt: playSegments.endedAt,
        billable: playSegments.billable,
      })
      .from(playSegments)
      .where(
        and(eq(playSegments.sessionId, row.id), eq(playSegments.open, true)),
      );
    return {
      state: row.state,
      stateSince: row.stateSince,
      clientSeenAt: row.clientSeenAt,
      lastInputAt: row.lastInputAt,
      agentSeenAt: row.agentSeenAt,
      openSegment: segment ?? null,
    } satisfies Snapshot;
  });

/**
 * Применяет решение автомата одной транзакцией: `state` и `stateSince = now`
 * (только если состояние сменилось), `endedAt = now` при переходе в
 * `ended`/`failed`, `failReason` (если задан), затем `SegmentOp` строго по
 * порядку над единственным открытым отрезком сессии. Нет сессии — ничего.
 */
export const apply = (sessionId: string, decision: Decision, now: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.transaction(() =>
      Effect.gen(function* () {
        const row = yield* lockSession(sessionId);
        if (row === undefined) return;
        const changed = decision.state !== row.state;
        if (changed || decision.failReason !== null) {
          yield* db
            .update(sessions)
            .set({
              ...(changed && {
                state: decision.state,
                stateSince: now,
                ...(isTerminal(decision.state) && { endedAt: now }),
              }),
              ...(decision.failReason !== null && {
                failReason: decision.failReason,
              }),
            })
            .where(eq(sessions.id, sessionId));
        }
        const open = and(
          eq(playSegments.sessionId, sessionId),
          eq(playSegments.open, true),
        );
        for (const op of decision.ops) {
          switch (op._tag) {
            case "Close":
              // `at` может быть раньше продлённого heartbeat'ом конца — перезаписываем.
              yield* db
                .update(playSegments)
                .set({ endedAt: op.at, open: false })
                .where(open);
              break;
            case "Open":
              yield* db.insert(playSegments).values({
                sessionId,
                userId: row.userId,
                appId: row.appId,
                startedAt: op.at,
                endedAt: op.at,
                billable: op.billable,
                open: true,
              });
              break;
            case "MarkOpenBillable":
              yield* db
                .update(playSegments)
                .set({ billable: true })
                .where(open);
              break;
          }
        }
      }),
    );
  });

/** Результат `transition`: строка до решения и решение (`null` — событие не выбрано). */
export interface Transition {
  readonly row: SessionRow;
  readonly decision: Decision | null;
}

/**
 * Шаг автомата для одной сессии, сериализованный по сессии: в транзакции
 * строка блокируется `FOR UPDATE`, снимок перечитывается под блокировкой,
 * `pick` выбирает событие по актуальной строке (`null` — ничего не делать),
 * затем `decide` + `apply`. Нет сессии — `undefined`.
 */
export const transition = (
  sessionId: string,
  now: Date,
  sessionSettings: SessionSettings,
  pick: (row: SessionRow, snapshot: Snapshot) => LifecycleEvent | null,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const row = yield* lockSession(sessionId);
        if (row === undefined) return undefined;
        const snapshot = yield* snapshotOf(row);
        const event = pick(row, snapshot);
        if (event === null) return { row, decision: null } as Transition;
        const decision = decide(snapshot, event, now, sessionSettings);
        if (
          decision.state !== row.state ||
          decision.ops.length > 0 ||
          decision.failReason !== null
        )
          yield* apply(sessionId, decision, now);
        return { row, decision } as Transition;
      }),
    );
  });

/**
 * Heartbeat агента воркера: `agentSeenAt = now` у перечисленных активных сессий
 * этого воркера и продление `endedAt` их открытых отрезков до `now` (не назад).
 */
export const recordHeartbeat = (
  workerId: string,
  sessionIds: ReadonlyArray<string>,
  now: Date,
) =>
  Effect.gen(function* () {
    if (sessionIds.length === 0) return;
    const db = yield* Db;
    const seen = yield* db
      .update(sessions)
      .set({ agentSeenAt: now })
      .where(
        and(
          inArray(sessions.id, [...sessionIds]),
          eq(sessions.workerId, workerId),
          isActive,
        ),
      )
      .returning({ id: sessions.id });
    if (seen.length === 0) return;
    yield* db
      .update(playSegments)
      .set({ endedAt: sql`greatest(${playSegments.endedAt}, ${now})` })
      .where(
        and(
          inArray(
            playSegments.sessionId,
            seen.map((s) => s.id),
          ),
          eq(playSegments.open, true),
        ),
      );
  });

/** Внутренний адрес Selkies активной сессии этого воркера. */
export const setStreamUrl = (
  workerId: string,
  sessionId: string,
  streamUrl: string,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(sessions)
      .set({ streamUrl })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.workerId, workerId),
          isActive,
        ),
      );
  });

/** Активные сессии (включая `queued`) в порядке создания. */
export const activeSessions = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({
        id: sessions.id,
        state: sessions.state,
        workerId: sessions.workerId,
      })
      .from(sessions)
      .where(isActive)
      .orderBy(asc(sessions.createdAt));
  });

/** Активные сессии воркера. */
export const activeOnWorker = (workerId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({
        id: sessions.id,
        state: sessions.state,
        agentSeenAt: sessions.agentSeenAt,
      })
      .from(sessions)
      .where(and(eq(sessions.workerId, workerId), isActive));
  });
