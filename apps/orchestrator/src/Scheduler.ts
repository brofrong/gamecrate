// Планировщик: раз в 2 с раздаёт сессии из очереди по свободным слотам
// подключённых воркеров и отправляет агенту StartSession; сессии неустановленных
// игр отправляет ждать установку (`installing`); сессии удаляемых игр ждут в
// очереди.
import { Db, gamestoreApps, installJobs, sessions, workers } from "@cg/db";
import type { ProfileRef } from "@cg/rpc";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { Cause, DateTime, Effect, Layer, Schedule } from "effect";
import { AgentHub } from "./AgentHub";
import * as InstallRepo from "./InstallRepo";
import * as SessionRepo from "./SessionRepo";
import { holdsSlot } from "./SessionRepo";
import { SteamLoginSeeds } from "./SteamLoginSeeds";

/** Период планировщика. */
export const SCHEDULER_INTERVAL = "2 seconds";

/** Наименьший свободный слот `0..slots-1` или `undefined`. */
const lowestFreeSlot = (slots: number, busy: ReadonlySet<number>) => {
  for (let slot = 0; slot < slots; slot++) if (!busy.has(slot)) return slot;
  return undefined;
};

/** Не больше стольких назначений (включая отправки в установку) за проход. */
export const SCHEDULE_BATCH = 20;

/** Назначение одной сессии, уже записанное в БД. */
interface Placement {
  readonly _tag: "Placed";
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
  readonly profile: ProfileRef | null;
}

/**
 * Итог `placeOne`: `Placed` — назначена на воркер; `Installing` — ждёт задачу
 * установки; `Retry` — игру только что установили (или только что пометили к
 * удалению), сессию разберёт следующий `placeOne`; `undefined` — делать нечего.
 */
type Outcome =
  | Placement
  | {
      readonly _tag: "Installing";
      readonly sessionId: string;
      readonly jobId: string;
    }
  | { readonly _tag: "Retry" };

/**
 * Строка игры сессии есть в `gamestore_apps` (подзапрос по внешней `sessions`),
 * в том числе у удаляемой: её не ставим, пока агент не удалит игру.
 */
const appInLibrary: SQL = sql`exists (select 1 from ${gamestoreApps} where ${gamestoreApps.appId} = ${sessions.appId})`;

/** Игра сессии в общей библиотеке и не удаляется (`deleting_at is null`). */
const appInstalled: SQL = sql`exists (select 1 from ${gamestoreApps} where ${gamestoreApps.appId} = ${sessions.appId} and ${gamestoreApps.deletingAt} is null)`;

/**
 * У пользователя сессии нет активной (`queued`/`running`) задачи установки,
 * которую качают его Steam-профилем. Иначе сессия ждёт в очереди её конца:
 * профиль пользователя в каждый момент держит ровно один процесс (спека §6),
 * иначе выгрузка установщика сделала бы выгрузку сессии устаревшей.
 */
const ownerFree: SQL = sql`not exists (select 1 from ${installJobs} where ${installJobs.userId} = ${sessions.userId} and ${installJobs.state} in ('queued', 'running'))`;

/**
 * Самая старая `queued`-сессия без запроса остановки, чей пользователь не
 * владеет активной задачей установки (`ownerFree`), под условием `where`.
 */
const lockOldestQueued = (where: SQL) =>
  Effect.gen(function* () {
    const db = yield* Db;
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
        and(
          eq(sessions.state, "queued"),
          isNull(sessions.stopRequestedAt),
          ownerFree,
          where,
        ),
      )
      .orderBy(asc(sessions.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    return session;
  });

/**
 * Сессия неустановленной игры: задача установки — активная этого appid или
 * новая `queued` с `userId` сессии; `installJobId` и `InstallStarted`
 * (→ `installing`). Задача блокируется до проверки библиотеки: если её как раз
 * завершают, видим уже установленную игру (`Retry`), а не завершённую задачу.
 */
const startInstall = (
  now: Date,
  session: {
    readonly id: string;
    readonly userId: string;
    readonly appId: number;
  },
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const locked = yield* InstallRepo.lockActiveJob(session.appId);
    if (yield* InstallRepo.isInstalled(session.appId))
      return { _tag: "Retry" } as const;
    const jobId =
      locked ?? (yield* InstallRepo.createJob(session.appId, session.userId));
    yield* db
      .update(sessions)
      .set({ installJobId: jobId })
      .where(eq(sessions.id, session.id));
    const settings = yield* SessionRepo.loadSettings();
    yield* SessionRepo.transition(session.id, now, settings, (row) =>
      row.state === "queued" ? { _tag: "InstallStarted" } : null,
    );
    return { _tag: "Installing", sessionId: session.id, jobId } as const;
  });

/**
 * Одна транзакция на одну сессию (`FOR UPDATE SKIP LOCKED`, `LIMIT 1`, без
 * запроса остановки, пользователь не владеет активной задачей установки).
 * Сначала самая старая `queued`-сессия неустановленной
 * игры (её игры нет в `gamestore_apps`) уходит в установку (`startInstall`) —
 * слот ей не нужен, поэтому она не ждёт воркеров. Иначе самая старая сессия
 * установленной и не удаляемой игры (строка игры под `FOR SHARE`: api
 * помечает удаление под `FOR UPDATE` и проверяет активные сессии — либо мы
 * видим пометку, либо api видит нашу сессию): первый по `id` воркер из
 * `candidates` со строкой в `workers`, не в обслуживании (`draining = false`)
 * и со свободным слотом, слот — наименьший свободный. Запись `workerId`,
 * `slot`, `state = 'starting'`, `stateSince = agentSeenAt = now` и коммит.
 */
const placeOne = (now: Date, candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const uninstalled = yield* lockOldestQueued(sql`not ${appInLibrary}`);
        if (uninstalled !== undefined)
          return (yield* startInstall(now, uninstalled)) as Outcome;

        if (candidates.length === 0) return undefined;
        const session = yield* lockOldestQueued(appInstalled);
        if (session === undefined) return undefined;
        const [app] = yield* db
          .select({ deletingAt: gamestoreApps.deletingAt })
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, session.appId))
          .for("share");
        if (app === undefined || app.deletingAt !== null)
          return { _tag: "Retry" } as const;

        // Только воркеры, чья строка уже записана хабом (на неё ссылается FK)
        // и которые не в обслуживании (`draining` — новых сессий не берут).
        const known = yield* db
          .select({ id: workers.id })
          .from(workers)
          .where(
            and(
              inArray(workers.id, [...candidates]),
              eq(workers.draining, false),
            ),
          )
          .orderBy(asc(workers.id));
        const taken = yield* db
          .select({ workerId: sessions.workerId, slot: sessions.slot })
          .from(sessions)
          .where(and(inArray(sessions.workerId, [...candidates]), holdsSlot));

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
          const profile = yield* SessionRepo.profileOf(session.userId);
          return {
            _tag: "Placed",
            session,
            workerId,
            slot,
            udpPort: info.udpPortBase + slot,
            profile,
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
 * больше `SCHEDULE_BATCH` за проход. Сессии размещаются только на агентах с
 * ролью `worker`. StartSession (`udpPort = udpPortBase + slot`)
 * уходит после коммита, поэтому сбой не откатит уже отправленные команды.
 * `send` вернул `false` — сессия возвращается в `queued` (`unplace`), а воркер
 * до конца прохода не используется. Если процесс упадёт между коммитом и
 * отправкой, сессия останется `starting` без агента и её завершит таймаут
 * агента (90 с от `agentSeenAt = now`).
 */
export const tick = (now: Date) =>
  Effect.gen(function* () {
    const hub = yield* AgentHub;
    const seeds = yield* SteamLoginSeeds;
    let candidates = [...hub.connected()].filter(
      (id) => hub.info(id)?.roles.includes("worker") ?? false,
    );
    let placed = 0;
    while (placed < SCHEDULE_BATCH) {
      const placement = yield* placeOne(now, candidates);
      if (placement === undefined) return;
      if (placement._tag !== "Placed") {
        placed++;
        if (placement._tag === "Installing")
          yield* Effect.logInfo("Session waits for game install", {
            sessionId: placement.sessionId,
            jobId: placement.jobId,
          });
        continue;
      }
      const { session, workerId, slot, udpPort, profile } = placement;
      const steamLogin = yield* seeds.get(session.userId);
      const sent = yield* hub.send(workerId, {
        _tag: "StartSession",
        sessionId: session.id,
        userId: session.userId,
        appId: session.appId,
        slot,
        udpPort,
        profile,
        steamLogin,
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
export const layer: Layer.Layer<never, never, Db | AgentHub | SteamLoginSeeds> =
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
