// Планировщик: раз в 2 с раздаёт сессии из очереди по свободным слотам
// подключённых воркеров и отправляет агенту StartSession.
import { Db, sessions, workers } from "@cg/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Cause, Data, DateTime, Effect, Layer, Schedule } from "effect";
import { AgentHub } from "./AgentHub";
import { isActive } from "./SessionRepo";

/** Период планировщика. */
export const SCHEDULER_INTERVAL = "2 seconds";

/** Агент не принял StartSession (соединение пропало) — откатываем назначение. */
class StartNotDelivered extends Data.TaggedError("StartNotDelivered")<{
  readonly workerId: string;
}> {}

/** Наименьший свободный слот `0..slots-1` или `undefined`. */
const lowestFreeSlot = (slots: number, busy: ReadonlySet<number>) => {
  for (let slot = 0; slot < slots; slot++) if (!busy.has(slot)) return slot;
  return undefined;
};

/**
 * Один проход планировщика. В транзакции: `queued`-сессии по `createdAt`
 * (`FOR UPDATE SKIP LOCKED`); каждой — первый по `id` подключённый воркер со
 * строкой в `workers` и свободным слотом, слот — наименьший свободный. Сессия
 * получает `workerId`, `slot`, `state = 'starting'`, `stateSince = agentSeenAt = now`,
 * агенту уходит `StartSession` с `udpPort = udpPortBase + slot`. Если `send`
 * вернул `false`, назначение откатывается (savepoint) — сессия остаётся `queued`.
 */
export const tick = (now: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    const connected = [...hub.connected()];
    if (connected.length === 0) return;

    yield* db.transaction(() =>
      Effect.gen(function* () {
        const queued = yield* db
          .select({
            id: sessions.id,
            userId: sessions.userId,
            appId: sessions.appId,
          })
          .from(sessions)
          .where(eq(sessions.state, "queued"))
          .orderBy(asc(sessions.createdAt))
          .for("update", { skipLocked: true });
        if (queued.length === 0) return;

        // Только воркеры, чья строка уже записана хабом (на неё ссылается FK).
        const known = yield* db
          .select({ id: workers.id })
          .from(workers)
          .where(inArray(workers.id, connected))
          .orderBy(asc(workers.id));
        const busy = new Map<string, Set<number>>(
          known.map((w) => [w.id, new Set<number>()]),
        );
        const taken = yield* db
          .select({ workerId: sessions.workerId, slot: sessions.slot })
          .from(sessions)
          .where(and(inArray(sessions.workerId, connected), isActive));
        for (const { workerId, slot } of taken)
          if (workerId !== null && slot !== null) busy.get(workerId)?.add(slot);

        let candidates = known.map((w) => w.id);
        for (const session of queued) {
          let placed = false;
          while (!placed) {
            const choice = candidates
              .map((workerId) => {
                const info = hub.info(workerId);
                const slot =
                  info &&
                  lowestFreeSlot(
                    info.slots,
                    busy.get(workerId) ?? new Set<number>(),
                  );
                return info && slot !== undefined
                  ? { workerId, slot, udpPort: info.udpPortBase + slot }
                  : undefined;
              })
              .find((c) => c !== undefined);
            // Свободных слотов нет — остальные сессии тоже ждут.
            if (choice === undefined) return;

            const delivered = yield* db
              .transaction(() =>
                Effect.gen(function* () {
                  yield* db
                    .update(sessions)
                    .set({
                      state: "starting",
                      stateSince: now,
                      workerId: choice.workerId,
                      slot: choice.slot,
                      agentSeenAt: now,
                    })
                    .where(eq(sessions.id, session.id));
                  const sent = yield* hub.send(choice.workerId, {
                    _tag: "StartSession",
                    sessionId: session.id,
                    userId: session.userId,
                    appId: session.appId,
                    slot: choice.slot,
                    udpPort: choice.udpPort,
                  });
                  if (!sent)
                    return yield* new StartNotDelivered({
                      workerId: choice.workerId,
                    });
                }),
              )
              .pipe(
                Effect.as(true),
                Effect.catchTag("StartNotDelivered", () =>
                  Effect.succeed(false),
                ),
              );

            if (delivered) {
              busy.get(choice.workerId)?.add(choice.slot);
              placed = true;
              yield* Effect.logInfo("Session scheduled", {
                sessionId: session.id,
                ...choice,
              });
            } else {
              // Агент отключился между проверкой и отправкой — в этом проходе не трогаем.
              candidates = candidates.filter((id) => id !== choice.workerId);
              yield* Effect.logWarning(
                "StartSession not delivered, session stays queued",
                { sessionId: session.id, workerId: choice.workerId },
              );
            }
          }
        }
      }),
    );
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
