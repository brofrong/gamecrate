// Планировщик: раз в 2 с раздаёт сессии из очереди по свободным слотам
// подключённых воркеров и отправляет агенту StartSession.
import { Db, sessions, workers } from "@cg/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Cause, DateTime, Effect, Layer, Schedule } from "effect";
import { AgentHub } from "./AgentHub";
import { isActive } from "./SessionRepo";

/** Период планировщика. */
export const SCHEDULER_INTERVAL = "2 seconds";

/** Наименьший свободный слот `0..slots-1` или `undefined`. */
const lowestFreeSlot = (slots: number, busy: ReadonlySet<number>) => {
  for (let slot = 0; slot < slots; slot++) if (!busy.has(slot)) return slot;
  return undefined;
};

/** Не больше стольких назначений за проход (остальные — на следующем). */
export const SCHEDULE_BATCH = 20;

/** Назначение одной сессии, уже записанное в БД. */
interface Placement {
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly appId: number;
    readonly stateSince: Date;
    readonly agentSeenAt: Date | null;
  };
  readonly workerId: string;
  readonly slot: number;
  readonly udpPort: number;
}

/**
 * Одна транзакция на одну сессию: самая старая `queued`-сессия без запроса
 * остановки (`FOR UPDATE SKIP LOCKED`, `LIMIT 1`); первый по `id` воркер из
 * `candidates` со строкой в `workers` и свободным слотом, слот — наименьший
 * свободный. Запись `workerId`, `slot`, `state = 'starting'`,
 * `stateSince = agentSeenAt = now` и коммит. `undefined` — очередь пуста или
 * свободных слотов нет.
 */
const placeOne = (now: Date, candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [session] = yield* db
          .select({
            id: sessions.id,
            userId: sessions.userId,
            appId: sessions.appId,
            stateSince: sessions.stateSince,
            agentSeenAt: sessions.agentSeenAt,
          })
          .from(sessions)
          .where(
            and(eq(sessions.state, "queued"), isNull(sessions.stopRequestedAt)),
          )
          .orderBy(asc(sessions.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (session === undefined) return undefined;

        // Только воркеры, чья строка уже записана хабом (на неё ссылается FK).
        const known = yield* db
          .select({ id: workers.id })
          .from(workers)
          .where(inArray(workers.id, [...candidates]))
          .orderBy(asc(workers.id));
        const taken = yield* db
          .select({ workerId: sessions.workerId, slot: sessions.slot })
          .from(sessions)
          .where(and(inArray(sessions.workerId, [...candidates]), isActive));

        for (const { id: workerId } of known) {
          const info = hub.info(workerId);
          if (info === undefined) continue;
          const busy = new Set(
            taken.flatMap((t) =>
              t.workerId === workerId && t.slot !== null ? [t.slot] : [],
            ),
          );
          const slot = lowestFreeSlot(info.slots, busy);
          if (slot === undefined) continue;
          yield* db
            .update(sessions)
            .set({
              state: "starting",
              stateSince: now,
              workerId,
              slot,
              agentSeenAt: now,
            })
            .where(eq(sessions.id, session.id));
          return {
            session,
            workerId,
            slot,
            udpPort: info.udpPortBase + slot,
          } satisfies Placement;
        }
        return undefined;
      }),
    );
  });

/**
 * Агент не принял StartSession: вернуть сессию в очередь (прежние `stateSince`
 * и `agentSeenAt`), если её за это время никто не трогал.
 */
const unplace = (placement: Placement) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(sessions)
      .set({
        state: "queued",
        stateSince: placement.session.stateSince,
        agentSeenAt: placement.session.agentSeenAt,
        workerId: null,
        slot: null,
      })
      .where(
        and(
          eq(sessions.id, placement.session.id),
          eq(sessions.state, "starting"),
          eq(sessions.workerId, placement.workerId),
        ),
      );
  });

/**
 * Один проход планировщика: по одной сессии за транзакцию (`placeOne`), не
 * больше `SCHEDULE_BATCH` за проход. StartSession (`udpPort = udpPortBase + slot`)
 * уходит после коммита, поэтому сбой не откатит уже отправленные команды.
 * `send` вернул `false` — сессия возвращается в `queued` (`unplace`), а воркер
 * до конца прохода не используется. Если процесс упадёт между коммитом и
 * отправкой, сессия останется `starting` без агента и её завершит таймаут
 * агента (90 с от `agentSeenAt = now`).
 */
export const tick = (now: Date) =>
  Effect.gen(function* () {
    const hub = yield* AgentHub;
    let candidates = [...hub.connected()];
    let placed = 0;
    while (candidates.length > 0 && placed < SCHEDULE_BATCH) {
      const placement = yield* placeOne(now, candidates);
      if (placement === undefined) return;
      const { session, workerId, slot, udpPort } = placement;
      const sent = yield* hub.send(workerId, {
        _tag: "StartSession",
        sessionId: session.id,
        userId: session.userId,
        appId: session.appId,
        slot,
        udpPort,
      });
      if (sent) {
        placed++;
        yield* Effect.logInfo("Session scheduled", {
          sessionId: session.id,
          workerId,
          slot,
          udpPort,
        });
      } else {
        yield* unplace(placement);
        // Агент отключился между проверкой и отправкой — в этом проходе не трогаем.
        candidates = candidates.filter((id) => id !== workerId);
        yield* Effect.logWarning(
          "StartSession not delivered, session stays queued",
          { sessionId: session.id, workerId },
        );
      }
    }
  });

/** Фоновый цикл планировщика (каждые 2 с); сбои прохода логируются. */
export const layer: Layer.Layer<never, never, Db | AgentHub> =
  Layer.effectDiscard(
    DateTime.nowAsDate.pipe(
      Effect.flatMap(tick),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("Scheduler tick failed", Cause.pretty(cause)),
      ),
      Effect.repeat(Schedule.spaced(SCHEDULER_INTERVAL)),
      Effect.forkScoped,
    ),
  );
