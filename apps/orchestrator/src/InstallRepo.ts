// Задачи установки игр в БД: задача привязана к серверу (библиотека своя у
// каждого сервера, спека 2026-11-09 §5) — не больше одной активной на пару
// (сервер, appid); выдача агенту этого сервера, итоги установки и переходы
// ждущих её сессий — одной транзакцией.
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
  installStageMarks,
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
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { LifecycleEvent } from "./lifecycle";
import * as SessionRepo from "./SessionRepo";

const activeStates: InstallJobState[] = ["queued", "running"];

/** Условие «задача активна» (`queued`/`running`). */
const isActiveJob = inArray(installJobs.state, activeStates);

/**
 * Серверы, на которых игра `appId` стоит и не удаляется (`deleting_at is
 * null`), по возрастанию id. Строки читаются под `FOR SHARE` (вызывать в
 * транзакции): api помечает удаление под `FOR UPDATE` и проверяет активные
 * сессии этого сервера — либо мы ждём его коммита и уже не видим сервер
 * (условие перепроверяется после блокировки), либо api видит нашу сессию.
 */
export const installedOn = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ workerId: gamestoreApps.workerId })
      .from(gamestoreApps)
      .where(
        and(eq(gamestoreApps.appId, appId), isNull(gamestoreApps.deletingAt)),
      )
      .orderBy(asc(gamestoreApps.workerId))
      .for("share");
    return rows.map((r) => r.workerId);
  });

/**
 * Серверы, где у игры `appId` есть строка библиотеки, в том числе
 * удаляемая (`deleting_at`): туда игру не ставим — агент сейчас удаляет её
 * файлы, установка поверх удаления сломала бы обе.
 */
export const libraryWorkersOf = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ workerId: gamestoreApps.workerId })
      .from(gamestoreApps)
      .where(eq(gamestoreApps.appId, appId));
    return rows.map((r) => r.workerId);
  });

/**
 * Активная задача установки `appId` на одном из серверов `workerIds` (самая
 * старая) под `FOR UPDATE` (вызывать в транзакции). Если её сейчас завершают,
 * ждёт конца той транзакции и видит уже итог. `cancelRequestedAt` отдаём и
 * тут же под той же блокировкой: вызывающий (`Scheduler.startInstall`) мог
 * увидеть задачу как не отменяемую чуть раньше (отдельным запросом, до
 * коммита отмены) — на блокировке он уже видит отмену и не присоединяет
 * сессию к задаче, которую немедленно провалит админ. Пустой `workerIds` —
 * `undefined` без запроса.
 */
export const lockActiveJob = (
  appId: number,
  workerIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (workerIds.length === 0) return undefined;
    const db = yield* Db;
    const [job] = yield* db
      .select({
        id: installJobs.id,
        workerId: installJobs.workerId,
        cancelRequestedAt: installJobs.cancelRequestedAt,
      })
      .from(installJobs)
      .where(
        and(
          eq(installJobs.appId, appId),
          inArray(installJobs.workerId, [...workerIds]),
          isActiveJob,
        ),
      )
      .orderBy(asc(installJobs.createdAt))
      .limit(1)
      .for("update");
    return job;
  });

/**
 * Новая `queued`-задача `appId` на сервере `workerId` с `userId` — чьим Steam
 * качать (вызывать в транзакции, когда `lockActiveJob` ничего не нашёл).
 * Параллельная вставка той же задачи упирается в частичный уникальный индекс
 * `(worker_id, app_id)` — тогда берём вставленную ею.
 */
export const createJob = (workerId: string, appId: number, userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [inserted] = yield* db
      .insert(installJobs)
      .values({ id: crypto.randomUUID(), workerId, appId, userId })
      .onConflictDoNothing()
      .returning({ id: installJobs.id });
    if (inserted !== undefined) return inserted.id;
    const existing = yield* lockActiveJob(appId, [workerId]);
    if (existing === undefined)
      return yield* Effect.die(
        `install job for app ${appId} on ${workerId} vanished`,
      );
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

/** Другая задача того же сервера — для «на сервере уже идёт установка». */
const runningOnWorker = alias(installJobs, "running_on_worker");

/**
 * Одна транзакция: самая старая `queued`-задача без запроса отмены админом
 * (`FOR UPDATE SKIP LOCKED`), чей сервер (`worker_id`, задача привязана к нему
 * при создании) есть в `candidates`, не в обслуживании (`draining = false`)
 * и сейчас не выполняет другую (`running`) задачу → `state = 'running'`;
 * профиль и пометка сброса входа Steam пользователя задачи читаются в той же
 * транзакции (сбой чтения откатывает выдачу). Задачи других серверов ждут
 * свой сервер — чужому агенту не выдаются никогда: игра должна оказаться в
 * библиотеке того сервера, где потом будет сессия. Задача, чей владелец
 * заблокирован (`ownerBlocked`) уже после её создания, не выдаётся: она
 * проваливается (`fail`, ошибка `accessDeniedReason`, ждущие сессии — как у
 * любой проваленной задачи), и в той же транзакции берётся следующая.
 * `running`-задачи заблокированных не трогаются. `undefined` — подходящих
 * задач нет.
 */
export const claimNext = (candidates: ReadonlyArray<string>, now: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    if (candidates.length === 0) return undefined;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        while (true) {
          const [next] = yield* db
            .select({
              id: installJobs.id,
              appId: installJobs.appId,
              userId: installJobs.userId,
              workerId: installJobs.workerId,
              ownerBlocked,
            })
            .from(installJobs)
            .where(
              and(
                eq(installJobs.state, "queued"),
                isNull(installJobs.cancelRequestedAt),
                inArray(installJobs.workerId, [...candidates]),
                // Не в обслуживании (`draining`) — такие новых установок не берут.
                exists(
                  db
                    .select({ id: workers.id })
                    .from(workers)
                    .where(
                      and(
                        eq(workers.id, installJobs.workerId),
                        eq(workers.draining, false),
                      ),
                    ),
                ),
                notExists(
                  db
                    .select({ id: runningOnWorker.id })
                    .from(runningOnWorker)
                    .where(
                      and(
                        eq(runningOnWorker.workerId, installJobs.workerId),
                        eq(runningOnWorker.state, "running"),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(installJobs.createdAt))
            .limit(1)
            .for("update", { skipLocked: true });
          if (next === undefined) return undefined;
          const { ownerBlocked: blocked, workerId, ...job } = next;
          if (blocked) {
            // Другие пользователи ждут не из-за себя — их сессии возвращаются
            // в очередь (`InstallCancelled`) и получат новую задачу под своим
            // профилем. Сессии самого владельца к этому моменту уже
            // stop-requested через `setBlocked`, так что `UserStop` кончит их
            // раньше; если какая-то всё же проскочила сюда, `placeOne` увидит
            // блокировку заново и провалит её `blockedFailure` с «Доступ закрыт».
            const waiters = yield* fail(next.id, accessDeniedReason, now, {
              requeueWaiters: true,
            });
            yield* Effect.logInfo(
              "Queued install job of a blocked user failed",
              { jobId: next.id, sessions: waiters },
            );
            continue;
          }
          if (workerId === null)
            return yield* Effect.die(`install job ${job.id} has no worker`);
          yield* db
            .update(installJobs)
            .set({ state: "running" })
            .where(eq(installJobs.id, job.id));
          const profile = yield* SessionRepo.profileOf(job.userId);
          const steamLoginResetAt = yield* SessionRepo.steamLoginResetAt(
            job.userId,
          );
          return {
            job,
            workerId,
            profile,
            steamLoginResetAt,
          } satisfies Claim;
        }
      }),
    );
  });

/**
 * InstallGame не доставлен: задача снова `queued`, если её никто не трогал;
 * сервер остаётся прежним — задача привязана к нему с создания.
 */
export const unclaim = (claim: Claim) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(installJobs)
      .set({ state: "queued" })
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
 * вперёд-только (`SessionRepo.forwardOnly`, как `setStage`). Строка реально
 * сменилась (`returning`) — в той же транзакции пишется отметка начала этапа
 * (`install_stage_marks`, `at = now` оркестратора); повтор того же этапа не
 * меняет строку, значит и отметку не трогает (`onConflictDoNothing` — на
 * случай гонки, не основной путь).
 */
export const recordStage = (
  workerId: string,
  jobId: string,
  stage: InstallStage,
  now: Date,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.transaction(() =>
      Effect.gen(function* () {
        const updated = yield* db
          .update(installJobs)
          .set({ stage })
          .where(
            and(
              eq(installJobs.id, jobId),
              eq(installJobs.state, "running"),
              eq(installJobs.workerId, workerId),
              SessionRepo.forwardOnly(installStages, installJobs.stage, stage),
            ),
          )
          .returning({ id: installJobs.id });
        if (updated.length === 0) return;
        yield* db
          .insert(installStageMarks)
          .values({ jobId, stage, at: now })
          .onConflictDoNothing();
      }),
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
 * `InstallFinished` агента `workerId`: игра в библиотеке сервера задачи
 * (upsert `gamestore_apps` по `(worker_id, app_id)`), задача `done`, ждущие
 * сессии — снова `queued` (планировщик разместит их на этом сервере, как
 * только там освободится слот). Первый итог побеждает: задача уже не
 * активна (или чужая) — `undefined`, ничего не меняется. Иначе — id
 * переведённых сессий.
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
        if (job === undefined || job.workerId === null) return undefined;
        // Сервер задачи (`lockJob` уже сверил его с агентом, приславшим
        // итог): библиотека своя у каждого сервера (спека §5).
        yield* db
          .insert(gamestoreApps)
          .values({
            workerId: job.workerId,
            appId: job.appId,
            ...result,
            installedAt: now,
          })
          .onConflictDoUpdate({
            target: [gamestoreApps.workerId, gamestoreApps.appId],
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
