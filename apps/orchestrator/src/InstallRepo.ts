// Задачи установки игр в БД: одна активная задача на appid, выдача агенту
// gamestore, итоги установки и переходы ждущих её сессий — одной транзакцией.
//
// Порядок блокировок: строка задачи (`FOR UPDATE`), затем строки сессий. Так же
// берёт блокировки планировщик (`Scheduler.placeOne` → `lockActiveJob`), поэтому
// сессия не присоединится к задаче, которую в это же время завершают.
import {
  Db,
  gamestoreApps,
  type InstallJobState,
  installJobs,
  sessions,
  workers,
} from "@cg/db";
import type { ProfileRef } from "@cg/rpc";
import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import { Effect } from "effect";
import type { LifecycleEvent } from "./lifecycle";
import * as SessionRepo from "./SessionRepo";

const activeStates: InstallJobState[] = ["queued", "running"];

/** Условие «задача активна» (`queued`/`running`). */
const isActiveJob = inArray(installJobs.state, activeStates);

/** Игра уже в общей библиотеке. */
export const isInstalled = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ appId: gamestoreApps.appId })
      .from(gamestoreApps)
      .where(eq(gamestoreApps.appId, appId));
    return row !== undefined;
  });

/**
 * Активная задача установки `appId` под `FOR UPDATE` (вызывать в транзакции).
 * Если её сейчас завершают, ждёт конца той транзакции и видит уже итог.
 */
export const lockActiveJob = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [job] = yield* db
      .select({ id: installJobs.id })
      .from(installJobs)
      .where(and(eq(installJobs.appId, appId), isActiveJob))
      .for("update");
    return job?.id;
  });

/**
 * Новая `queued`-задача `appId` с `userId` — чьим Steam качать (вызывать в
 * транзакции, когда `lockActiveJob` ничего не нашёл). Параллельная вставка той
 * же задачи упирается в частичный уникальный индекс — тогда берём вставленную ею.
 */
export const createJob = (appId: number, userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [inserted] = yield* db
      .insert(installJobs)
      .values({ id: crypto.randomUUID(), appId, userId })
      .onConflictDoNothing()
      .returning({ id: installJobs.id });
    if (inserted !== undefined) return inserted.id;
    const existing = yield* lockActiveJob(appId);
    if (existing === undefined)
      return yield* Effect.die(`install job for app ${appId} vanished`);
    return existing;
  });

/** Задача, выданная агенту (уже записана как `running`). */
export interface Claim {
  readonly job: {
    readonly id: string;
    readonly appId: number;
    readonly userId: string;
  };
  readonly workerId: string;
  readonly profile: ProfileRef | null;
}

/**
 * Одна транзакция: самая старая `queued`-задача (`FOR UPDATE SKIP LOCKED`) →
 * первый по id агент из `candidates` со строкой в `workers` и без
 * `running`-задачи → `state = 'running'`, `workerId`. `undefined` — очередь
 * пуста или свободных агентов нет.
 */
export const claimNext = (candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    if (candidates.length === 0) return undefined;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [job] = yield* db
          .select({
            id: installJobs.id,
            appId: installJobs.appId,
            userId: installJobs.userId,
          })
          .from(installJobs)
          .where(eq(installJobs.state, "queued"))
          .orderBy(asc(installJobs.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (job === undefined) return undefined;
        const known = yield* db
          .select({ id: workers.id })
          .from(workers)
          .where(inArray(workers.id, [...candidates]))
          .orderBy(asc(workers.id));
        const busy = yield* db
          .select({ workerId: installJobs.workerId })
          .from(installJobs)
          .where(
            and(
              eq(installJobs.state, "running"),
              inArray(installJobs.workerId, [...candidates]),
            ),
          );
        const busyIds = new Set(busy.map((b) => b.workerId));
        const free = known.find((w) => !busyIds.has(w.id));
        if (free === undefined) return undefined;
        yield* db
          .update(installJobs)
          .set({ state: "running", workerId: free.id })
          .where(eq(installJobs.id, job.id));
        const profile = yield* SessionRepo.profileOf(job.userId);
        return { job, workerId: free.id, profile } satisfies Claim;
      }),
    );
  });

/** InstallGame не доставлен: задача снова `queued`, если её никто не трогал. */
export const unclaim = (claim: Claim) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(installJobs)
      .set({ state: "queued", workerId: null })
      .where(
        and(
          eq(installJobs.id, claim.job.id),
          eq(installJobs.state, "running"),
          eq(installJobs.workerId, claim.workerId),
        ),
      );
  });

/** Прогресс загрузки — только у `running`-задачи этого агента. */
export const recordProgress = (
  workerId: string,
  jobId: string,
  bytesDownloaded: number,
  bytesTotal: number,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(installJobs)
      .set({ bytesDownloaded, bytesTotal })
      .where(
        and(
          eq(installJobs.id, jobId),
          eq(installJobs.state, "running"),
          eq(installJobs.workerId, workerId),
        ),
      );
  });

/** Задача под `FOR UPDATE`, если она активна (и, когда задан, на этом агенте). */
const lockJob = (jobId: string, workerId?: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [job] = yield* db
      .select()
      .from(installJobs)
      .where(eq(installJobs.id, jobId))
      .for("update");
    if (job === undefined || !activeStates.includes(job.state))
      return undefined;
    if (workerId !== undefined && job.workerId !== workerId) return undefined;
    return job;
  });

/** Id сессий, ждущих задачу (`installing` с этим `installJobId`). */
const waitersOf = (jobId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.installJobId, jobId), eq(sessions.state, "installing")),
      )
      .orderBy(asc(sessions.createdAt));
    return rows.map((r) => r.id);
  });

/** Событие автомата каждой сессии, всё ещё ждущей задачу `jobId`. */
const notifyWaiters = (jobId: string, event: LifecycleEvent, now: Date) =>
  Effect.gen(function* () {
    const settings = yield* SessionRepo.loadSettings();
    const waiters = yield* waitersOf(jobId);
    for (const sessionId of waiters)
      yield* SessionRepo.transition(sessionId, now, settings, (row) =>
        row.state === "installing" && row.installJobId === jobId ? event : null,
      );
    return waiters;
  });

/**
 * `InstallFinished` агента `workerId`: игра в библиотеке (upsert
 * `gamestore_apps`), задача `done`, ждущие сессии — снова `queued`. Первый
 * итог побеждает: задача уже не активна (или чужая) — `undefined`, ничего не
 * меняется. Иначе — id переведённых сессий.
 */
export const finish = (
  workerId: string,
  jobId: string,
  result: { readonly sizeBytes: number; readonly buildId: string },
  now: Date,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const job = yield* lockJob(jobId, workerId);
        if (job === undefined) return undefined;
        yield* db
          .insert(gamestoreApps)
          .values({ appId: job.appId, ...result, installedAt: now })
          .onConflictDoUpdate({
            target: gamestoreApps.appId,
            set: { ...result, installedAt: now },
          });
        yield* db
          .update(installJobs)
          .set({ state: "done" })
          .where(eq(installJobs.id, jobId));
        return yield* notifyWaiters(jobId, { _tag: "InstallFinished" }, now);
      }),
    );
  });

/**
 * Задача провалилась (`InstallFailed` агента, агент её потерял или отмена до
 * выдачи): `failed` + `error`, ждущие сессии — `failed`. Только активная задача
 * (и, если задан `workerId`, только на этом агенте); иначе `undefined`.
 */
export const fail = (
  jobId: string,
  error: string,
  now: Date,
  workerId?: string,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const job = yield* lockJob(jobId, workerId);
        if (job === undefined) return undefined;
        yield* db
          .update(installJobs)
          .set({ state: "failed", error })
          .where(eq(installJobs.id, jobId));
        return yield* notifyWaiters(
          jobId,
          { _tag: "InstallFailed", reason: error },
          now,
        );
      }),
    );
  });

/** `running`-задачи (все или одного агента). */
export const runningJobs = (workerId?: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ id: installJobs.id, workerId: installJobs.workerId })
      .from(installJobs)
      .where(
        and(
          eq(installJobs.state, "running"),
          workerId === undefined
            ? undefined
            : eq(installJobs.workerId, workerId),
        ),
      );
    return rows.flatMap((r) =>
      r.workerId === null ? [] : [{ id: r.id, workerId: r.workerId }],
    );
  });

/** Активные задачи, которых не ждёт ни одна сессия (последняя ушла). */
export const abandonedJobs = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({ id: installJobs.id })
      .from(installJobs)
      .where(
        and(
          isActiveJob,
          notExists(
            db
              .select({ id: sessions.id })
              .from(sessions)
              .where(
                and(
                  eq(sessions.installJobId, installJobs.id),
                  eq(sessions.state, "installing"),
                ),
              ),
          ),
        ),
      );
  });

/**
 * Брошенная задача (проверка под блокировкой — к ней могла присоединиться
 * сессия): `queued` — сразу `failed` с `error`; `running` — агенту нужен
 * CancelInstall, задача остаётся `running` до его итога. `undefined` — задача
 * уже не брошена или не активна.
 */
export const abandon = (jobId: string, error: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const job = yield* lockJob(jobId);
        if (job === undefined) return undefined;
        if ((yield* waitersOf(jobId)).length > 0) return undefined;
        if (job.state === "running" && job.workerId !== null)
          return { _tag: "Cancel", workerId: job.workerId } as const;
        yield* db
          .update(installJobs)
          .set({ state: "failed", error })
          .where(eq(installJobs.id, jobId));
        return { _tag: "Failed" } as const;
      }),
    );
  });
