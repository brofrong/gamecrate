// Задачи установки игр в БД: одна активная задача на appid, выдача агенту
// gamestore, итоги установки и переходы ждущих её сессий — одной транзакцией.
//
// Блокировки: `Scheduler.placeOne` держит `queued`-сессию и затем берёт строку
// активной задачи (`lockActiveJob`, `FOR UPDATE`); `finish`/`fail` берут строку
// задачи и затем — `installing`-сессии, которые её ждут. Наборы строк сессий не
// пересекаются (`queued` против `installing`), поэтому взаимной блокировки нет;
// а общая строка задачи сериализует присоединение и итог: сессия не
// присоединится к задаче, которую в это же время завершают.
import {
  Db,
  gamestoreApps,
  type InstallJobState,
  installJobs,
  installStages,
  type InstallStage,
  sessions,
  user,
  workers,
} from "@cg/db";
import {
  type ProfileRef,
  accessDeniedReason,
  steamLoginRequiredReason,
} from "@cg/rpc";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
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
 * `cancelRequestedAt` отдаём и тут же под той же блокировкой: вызывающий
 * (`Scheduler.startInstall`) мог увидеть задачу как не отменяемую чуть раньше
 * (отдельным запросом, до коммита отмены) — на блокировке он уже видит отмену
 * и не присоединяет сессию к задаче, которую немедленно провалит админ.
 */
export const lockActiveJob = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [job] = yield* db
      .select({
        id: installJobs.id,
        cancelRequestedAt: installJobs.cancelRequestedAt,
      })
      .from(installJobs)
      .where(and(eq(installJobs.appId, appId), isActiveJob))
      .for("update");
    return job;
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
    return existing.id;
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
  /** Пометка сброса входа Steam пользователя (`SessionRepo.steamLoginResetAt`). */
  readonly steamLoginResetAt: Date | null;
}

/**
 * Причина задачи, отменённой админом (`install_jobs.error` и причина ждущим
 * сессиям); `InstallDispatcher.installErrors.cancelledByAdmin`.
 */
export const cancelledByAdminError = "Установка отменена администратором";

/** Владелец задачи (`install_jobs.user_id`) заблокирован админом (`user.blocked_at`). */
const ownerBlocked = sql<boolean>`exists (select 1 from ${user} where ${user.id} = ${installJobs.userId} and ${user.blockedAt} is not null)`;

/**
 * Одна транзакция: самая старая `queued`-задача без запроса отмены админом
 * (`FOR UPDATE SKIP LOCKED`) → первый по id агент из `candidates` со строкой в
 * `workers`, не в обслуживании (`draining = false`) и без `running`-задачи →
 * `state = 'running'`, `workerId`; профиль и пометка сброса входа Steam
 * пользователя задачи читаются в той же транзакции (сбой чтения откатывает
 * выдачу). Задача, чей владелец заблокирован (`ownerBlocked`) уже после её
 * создания, не выдаётся: она проваливается (`fail`, ошибка
 * `accessDeniedReason`, ждущие сессии — как у любой проваленной задачи), и в
 * той же транзакции берётся следующая. `running`-задачи заблокированных не
 * трогаются. `undefined` — очередь пуста или свободных агентов нет.
 */
export const claimNext = (candidates: ReadonlyArray<string>, now: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    if (candidates.length === 0) return undefined;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        let job: Claim["job"] | undefined;
        while (job === undefined) {
          const [next] = yield* db
            .select({
              id: installJobs.id,
              appId: installJobs.appId,
              userId: installJobs.userId,
              ownerBlocked,
            })
            .from(installJobs)
            .where(
              and(
                eq(installJobs.state, "queued"),
                isNull(installJobs.cancelRequestedAt),
              ),
            )
            .orderBy(asc(installJobs.createdAt))
            .limit(1)
            .for("update", { skipLocked: true });
          if (next === undefined) return undefined;
          const { ownerBlocked: blocked, ...rest } = next;
          if (!blocked) {
            job = rest;
            break;
          }
          // Другие пользователи ждут не из-за себя — их сессии возвращаются в
          // очередь (`InstallCancelled`) и получат новую задачу под своим
          // профилем. Сессии самого владельца к этому моменту уже
          // stop-requested через `setBlocked`, так что `UserStop` кончит их
          // раньше; если какая-то всё же проскочила сюда, `placeOne` увидит
          // блокировку заново и провалит её `blockedFailure` с «Доступ закрыт».
          const waiters = yield* fail(next.id, accessDeniedReason, now, {
            requeueWaiters: true,
          });
          yield* Effect.logInfo("Queued install job of a blocked user failed", {
            jobId: next.id,
            sessions: waiters,
          });
        }
        // Не в обслуживании (`draining`) — такие новых установок не берут.
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
        const steamLoginResetAt = yield* SessionRepo.steamLoginResetAt(
          job.userId,
        );
        return {
          job,
          workerId: free.id,
          profile,
          steamLoginResetAt,
        } satisfies Claim;
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

/**
 * Этап установки (экран загрузки) — только у `running`-задачи этого агента,
 * вперёд-только (`SessionRepo.forwardOnly`, как `setStage`).
 */
export const recordStage = (
  workerId: string,
  jobId: string,
  stage: InstallStage,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(installJobs)
      .set({ stage })
      .where(
        and(
          eq(installJobs.id, jobId),
          eq(installJobs.state, "running"),
          eq(installJobs.workerId, workerId),
          SessionRepo.forwardOnly(installStages, installJobs.stage, stage),
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

/**
 * Событие автомата каждой сессии, всё ещё ждущей задачу `jobId` (`event` —
 * событие или функция от строки сессии).
 */
const notifyWaiters = (
  jobId: string,
  event: LifecycleEvent | ((row: SessionRepo.SessionRow) => LifecycleEvent),
  now: Date,
) =>
  Effect.gen(function* () {
    const settings = yield* SessionRepo.loadSettings();
    const waiters = yield* waitersOf(jobId);
    for (const sessionId of waiters)
      yield* SessionRepo.transition(sessionId, now, settings, (row) =>
        row.state === "installing" && row.installJobId === jobId
          ? typeof event === "function"
            ? event(row)
            : event
          : null,
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
 * Задача провалилась (`InstallFailed` агента или агент её потерял): `failed` +
 * `error`, ждущие сессии — `failed` (или `queued`, см. `requeueWaiters`);
 * `steamLoginRequiredReason` и `accessDeniedReason` (владелец заблокирован,
 * `claimNext`) владелец задачи видит как есть. Задача, которую
 * отменил админ (`cancelRequestedAt`), проваливается с `cancelledByAdminError`
 * при любом `error`: ждущие видят эту причину и не возвращаются в очередь.
 * Только активная задача (и, если задан `workerId`, только на этом агенте);
 * иначе `undefined`. Иначе — id сессий, которым отправлено событие.
 */
export const fail = (
  jobId: string,
  error: string,
  now: Date,
  options: {
    /** Принимать итог только от этого агента. */
    readonly workerId?: string;
    /**
     * Задачу отменили мы (её бросили все ждущие), а к ней успели
     * присоединиться сессии: они возвращаются в `queued` (`InstallCancelled`)
     * и получат новую задачу, а не проваливаются.
     */
    readonly requeueWaiters?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const job = yield* lockJob(jobId, options.workerId);
        if (job === undefined) return undefined;
        const byAdmin = job.cancelRequestedAt !== null;
        yield* db
          .update(installJobs)
          .set({
            state: "failed",
            error: byAdmin ? cancelledByAdminError : error,
          })
          .where(eq(installJobs.id, jobId));
        if (byAdmin)
          return yield* notifyWaiters(
            jobId,
            {
              _tag: "InstallFailed",
              reason: cancelledByAdminError,
              userReason: cancelledByAdminError,
            },
            now,
          );
        // Нужен вход в Steam или владелец заблокирован — это про владельца
        // задачи: ему причина как есть, остальным ждущим — общая (их профиль
        // и доступ ни при чём).
        return yield* notifyWaiters(
          jobId,
          options.requeueWaiters === true
            ? { _tag: "InstallCancelled" }
            : (row) => ({
                _tag: "InstallFailed",
                reason: error,
                ...((error === steamLoginRequiredReason ||
                  error === accessDeniedReason) &&
                  row.userId === job.userId && { userReason: error }),
              }),
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

/** Активные задачи, которые админ попросил отменить (`cancelRequestedAt`). */
export const cancelRequestedJobs = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({
        id: installJobs.id,
        state: installJobs.state,
        workerId: installJobs.workerId,
      })
      .from(installJobs)
      .where(and(isActiveJob, isNotNull(installJobs.cancelRequestedAt)))
      .orderBy(asc(installJobs.createdAt));
    return rows.flatMap(({ id, state, workerId }) =>
      state === "queued" || state === "running"
        ? [{ id, state, workerId }]
        : [],
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
