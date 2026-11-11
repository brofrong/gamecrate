// Снимок места в очереди (спека 2026-11-10 §5): раз в 5 с пересчитывает для
// каждой ждущей сессии место и «всего» среди тех, кто претендует на те же
// серверы, и оценку ожидания по тому, как часто там освобождаются слоты.
// Пишет `queue_position/queue_total/queue_eta_minutes`, api отдаёт их в
// `SessionView.queue`. Триггер `session_changed` эти колонки не слушает:
// `session.watch` и так перечитывает сессию каждые 5 с.
import { Db, eligibleWorkers, sessions } from "@cg/db";
import { isOwnAppId } from "@cg/rpc";
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  not,
  notInArray,
  or,
} from "drizzle-orm";
import { Effect } from "effect";
import { AgentHub } from "./AgentHub";
import * as InstallRepo from "./InstallRepo";
import {
  placeableGame,
  queueOrder,
  userBlocked,
  waitingInQueue,
} from "./Scheduler";

/** Период пересчёта снимка. */
export const QUEUE_REFRESH_INTERVAL = "5 seconds";

/** Окно, за которое считаются освобождения слотов. */
const RELEASE_WINDOW_MS = 60 * 60_000;
/** Меньше стольких освобождений за окно — оценки нет («оцениваем…»). */
const MIN_RELEASES = 3;
/** Оценка округляется вверх до кратного этому числу минут. */
const ETA_STEP_MINUTES = 5;
/** Оценка больше этого числа минут пишется как `ETA_OVER_HOUR`. */
const ETA_MAX_MINUTES = 60;
/** «Больше часа» (web так и показывает `61`). */
const ETA_OVER_HOUR = 61;

export type QueueEntry = {
  readonly id: string;
  readonly priority: number;
  readonly createdAt: Date;
  /** Серверы, куда сессию может поставить планировщик. */
  readonly targets: ReadonlySet<string>;
};

export type QueuePlace = {
  readonly position: number;
  readonly total: number;
  readonly etaMinutes: number | null;
};

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  for (const id of a) if (b.has(id)) return true;
  return false;
};

/**
 * Оценка ожидания в минутах для места `position` при `releasesPerHour`
 * освобождениях слотов за час: меньше `MIN_RELEASES` — `null`; иначе
 * `position ÷ (освобождений в минуту)`, вверх до кратного 5, минимум 5;
 * больше 60 — `61` («больше часа»).
 */
export const etaMinutes = (
  position: number,
  releasesPerHour: number,
): number | null => {
  if (releasesPerHour < MIN_RELEASES) return null;
  const minutes = Math.ceil((position * 60) / releasesPerHour);
  const rounded = Math.max(
    ETA_STEP_MINUTES,
    Math.ceil(minutes / ETA_STEP_MINUTES) * ETA_STEP_MINUTES,
  );
  return rounded > ETA_MAX_MINUTES ? ETA_OVER_HOUR : rounded;
};

/**
 * Место/всего среди пересекающихся по targets; releasesPerHour(targets) —
 * освобождения слотов за час. Порядок как у планировщика (`queueOrder`:
 * приоритет по убыванию, затем `createdAt`; при равенстве — `id`, чтобы
 * номер не прыгал). Место = 1 + записи впереди, чьи `targets` пересекаются
 * с моими; всего = все пересекающиеся записи, включая меня. Пустые `targets`
 * ни с чем не пересекаются — такая запись получает `1/1` (её не разместят,
 * пока не появится сервер, но номер не врёт).
 */
export const rankQueue = (
  entries: ReadonlyArray<QueueEntry>,
  releasesPerHour: (targets: ReadonlySet<string>) => number,
): ReadonlyMap<string, QueuePlace> => {
  const ordered = [...entries].sort(
    (a, b) =>
      b.priority - a.priority ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const places = new Map<string, QueuePlace>();
  ordered.forEach((me, index) => {
    let ahead = 0;
    let behind = 0;
    ordered.forEach((other, otherIndex) => {
      if (otherIndex === index || !intersects(me.targets, other.targets))
        return;
      if (otherIndex < index) ahead++;
      else behind++;
    });
    const position = ahead + 1;
    places.set(me.id, {
      position,
      total: position + behind,
      etaMinutes: etaMinutes(position, releasesPerHour(me.targets)),
    });
  });
  return places;
};

/**
 * Пересчёт снимка очереди на момент `now`:
 *
 * - ждущие сессии — те же, что просматривает планировщик (`waitingInQueue`,
 *   `placeableGame`), без заблокированных пользователей и без `FOR UPDATE`;
 * - `targets` — `eligibleWorkers` среди подключённых агентов с ролью
 *   `worker`; для Steam-игры — те из них, где игра стоит
 *   (`InstallRepo.installedOn`), если такие есть, иначе все годные (игру
 *   поставят на один из них);
 * - освобождения — сессии, выпустившие слот на сервере из `targets` за
 *   последний час (`slot_released_at`);
 * - колонки пишутся только у сессий, чьи значения изменились; у остальных
 *   сессий (ушли из очереди или больше не ждут) непустые колонки обнуляются.
 */
export const refreshQueue = (
  now: Date,
): Effect.Effect<void, never, Db | AgentHub> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    const connected = [...hub.connected()].filter(
      (id) => hub.info(id)?.roles.includes("worker") ?? false,
    );

    const waiting = yield* db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        appId: sessions.appId,
        priority: sessions.queuePriority,
        createdAt: sessions.createdAt,
        queuePosition: sessions.queuePosition,
        queueTotal: sessions.queueTotal,
        queueEtaMinutes: sessions.queueEtaMinutes,
      })
      .from(sessions)
      .where(and(waitingInQueue, placeableGame, not(userBlocked)))
      .orderBy(...queueOrder);

    const installedCache = new Map<number, ReadonlySet<string>>();
    const installedOf = (appId: number) =>
      Effect.gen(function* () {
        const cached = installedCache.get(appId);
        if (cached !== undefined) return cached;
        const installed = new Set(yield* InstallRepo.installedOn(appId));
        installedCache.set(appId, installed);
        return installed;
      });

    const entries: QueueEntry[] = [];
    for (const session of waiting) {
      const eligible = (yield* eligibleWorkers(session.userId, session.appId, {
        workerIds: connected,
      })).map((w) => w.id);
      let targets = eligible;
      if (!isOwnAppId(session.appId)) {
        const installed = yield* installedOf(session.appId);
        const withGame = eligible.filter((id) => installed.has(id));
        if (withGame.length > 0) targets = withGame;
      }
      entries.push({
        id: session.id,
        priority: session.priority,
        createdAt: session.createdAt,
        targets: new Set(targets),
      });
    }

    const releases =
      connected.length === 0
        ? []
        : yield* db
            .select({ workerId: sessions.workerId, released: count() })
            .from(sessions)
            .where(
              and(
                inArray(sessions.workerId, connected),
                gte(
                  sessions.slotReleasedAt,
                  new Date(now.getTime() - RELEASE_WINDOW_MS),
                ),
              ),
            )
            .groupBy(sessions.workerId);
    const releasesOf = new Map(
      releases.map((r) => [r.workerId ?? "", r.released]),
    );
    const releasesPerHour = (targets: ReadonlySet<string>) => {
      let sum = 0;
      for (const id of targets) sum += releasesOf.get(id) ?? 0;
      return sum;
    };

    const places = rankQueue(entries, releasesPerHour);
    for (const session of waiting) {
      const place = places.get(session.id)!;
      if (
        session.queuePosition === place.position &&
        session.queueTotal === place.total &&
        session.queueEtaMinutes === place.etaMinutes
      )
        continue;
      yield* db
        .update(sessions)
        .set({
          queuePosition: place.position,
          queueTotal: place.total,
          queueEtaMinutes: place.etaMinutes,
        })
        .where(and(eq(sessions.id, session.id), eq(sessions.state, "queued")));
    }

    const ranked = waiting.map((s) => s.id);
    yield* db
      .update(sessions)
      .set({ queuePosition: null, queueTotal: null, queueEtaMinutes: null })
      .where(
        and(
          or(
            isNotNull(sessions.queuePosition),
            isNotNull(sessions.queueTotal),
            isNotNull(sessions.queueEtaMinutes),
          ),
          ...(ranked.length === 0 ? [] : [notInArray(sessions.id, ranked)]),
        ),
      );
  }).pipe(Effect.orDie);
