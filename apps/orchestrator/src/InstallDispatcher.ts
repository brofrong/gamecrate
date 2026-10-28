// Установки игр: раз в 2 с выдаёт задачи из очереди агентам с ролью gamestore,
// отменяет брошенные и валит потерянные; отчёты агентов об установке (прогресс,
// итог) переводит в задачи и ждущие их сессии.
import { Db } from "@cg/db";
import { Context, DateTime, Effect, Layer, PubSub, Schedule } from "effect";
import { AgentHub, type AgentHubEvent } from "./AgentHub";
import * as InstallRepo from "./InstallRepo";
import { AGENT_TIMEOUT_MS } from "./lifecycle";
import * as SessionRepo from "./SessionRepo";
import { logFailure, RECONCILE_GRACE_MS } from "./SessionRunner";
import { SteamLoginSeeds } from "./SteamLoginSeeds";

/** Период диспетчера установок. */
export const DISPATCH_INTERVAL = "2 seconds";

/**
 * Задача выдана перед самым переподключением агента и в его `installs` её нет:
 * InstallGame мог прийти в новое соединение после снимка, а мог потеряться со
 * старым. Ждём подтверждения (любой Install*-отчёт по задаче) столько от
 * выдачи — первый InstallProgress бывает только после старта контейнера,
 * восстановления профиля и входа Steam, это дольше `AGENT_TIMEOUT_MS`.
 */
export const DISPATCH_CONFIRM_MS = 5 * 60_000;

/** Ошибки задач, которые ставит сам оркестратор (`install_jobs.error`). */
export const installErrors = {
  /** Агент перезапустился без установки или молчит дольше `AGENT_TIMEOUT_MS`. */
  interrupted: "Установка прервана",
  /** Ни одна сессия больше не ждёт задачу, агенту она ещё не выдана. */
  cancelled: "Установка отменена",
  /** Задачу отменил админ (`cancelRequestedAt`); её видят и ждущие сессии. */
  cancelledByAdmin: InstallRepo.cancelledByAdminError,
} as const;

export interface InstallDispatcherShape {
  /** Обработать событие хаба в момент `now`. Сбои логируются. */
  readonly handle: (event: AgentHubEvent, now: Date) => Effect.Effect<void>;
  /**
   * Проход: отменённые админом и брошенные задачи (CancelInstall / `failed`),
   * потерянные агентом (`failed`), затем выдача `queued`-задач свободным
   * агентам gamestore.
   */
  readonly tick: (now: Date) => Effect.Effect<void>;
}

export interface InstallDispatcherOptions {
  /** Момент старта диспетчера (по умолчанию — сейчас). */
  readonly startedAt?: Date;
}

const make = (options: InstallDispatcherOptions) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    const seeds = yield* SteamLoginSeeds;
    const startedAt = options.startedAt ?? (yield* DateTime.nowAsDate);

    /**
     * Последнее событие от агента (подключение или любой отчёт, в т.ч.
     * heartbeat). Нет записи — агент не подавал голоса с `startedAt`: после
     * перезапуска оркестратора у него полные `AGENT_TIMEOUT_MS`, чтобы
     * переподключиться.
     */
    const lastSeen = new Map<string, Date>();
    /** Когда этот процесс выдал задачу агенту (для сверки при переподключении). */
    const dispatchedAt = new Map<string, Date>();
    /**
     * Задачи, которых не было в `installs` переподключившегося агента: валим,
     * если к `deadline` они всё ещё `running` на нём и агент о них не отчитался.
     * Обычно `deadline` — через `RECONCILE_GRACE_MS` (за это время доходят
     * итоговые отчёты, перенесённые через переподключение); только что
     * выданные ждут `DISPATCH_CONFIRM_MS` от выдачи и при провале получают
     * CancelInstall — вдруг агент всё-таки её выполняет.
     */
    const missing = new Map<
      string,
      { workerId: string; deadline: Date; cancel: boolean }
    >();
    /**
     * Брошенные или отменённые админом `running`-задачи, которым мы запросили
     * CancelInstall (до их итога); `delivered` — команда ушла в текущее
     * соединение агента. Сессии, присоединившиеся к брошенной задаче, при её
     * отменном итоге возвращаются в очередь, а не проваливаются (у отменённой
     * админом — проваливаются, это решает `InstallRepo.fail`).
     */
    const cancels = new Map<string, { workerId: string; delivered: boolean }>();

    const withDb = <A, E>(effect: Effect.Effect<A, E, Db>) =>
      Effect.provideService(effect, Db, db);

    const logFinished = (
      jobId: string,
      waiters: ReadonlyArray<string> | undefined,
      annotations: Record<string, unknown>,
    ) =>
      waiters === undefined
        ? Effect.logInfo("Ignored install result for an inactive job", {
            jobId,
            ...annotations,
          })
        : Effect.logInfo("Install job result applied", {
            jobId,
            sessions: waiters,
            ...annotations,
          });

    /**
     * Агент (пере)подключился. Наши `running`-задачи на нём, которых нет в
     * `installs`, — под подозрением (`missing`). Установки, которых мы на нём не
     * ждём, отменяем: иначе агент занят чужой работой.
     */
    const reconnected = (
      workerId: string,
      installs: ReadonlyArray<string>,
      now: Date,
    ) =>
      Effect.gen(function* () {
        // Команды прежнего соединения могли потеряться; прежняя сверка устарела.
        for (const entry of cancels.values())
          if (entry.workerId === workerId) entry.delivered = false;
        for (const [jobId, entry] of missing)
          if (entry.workerId === workerId) missing.delete(jobId);
        const running = yield* withDb(InstallRepo.runningJobs(workerId));
        const live = new Set(installs);
        for (const job of running) {
          if (live.has(job.id)) continue;
          const sent = dispatchedAt.get(job.id);
          const recent =
            sent !== undefined &&
            now.getTime() - sent.getTime() < RECONCILE_GRACE_MS;
          missing.set(job.id, {
            workerId,
            deadline: recent
              ? new Date(sent.getTime() + DISPATCH_CONFIRM_MS)
              : new Date(now.getTime() + RECONCILE_GRACE_MS),
            cancel: recent,
          });
        }
        const ours = new Set(running.map((job) => job.id));
        for (const jobId of installs) {
          if (ours.has(jobId)) continue;
          yield* Effect.logWarning("Cancelling an install unknown to us", {
            jobId,
            workerId,
          });
          yield* hub.send(workerId, { _tag: "CancelInstall", jobId });
        }
      });

    const handle: InstallDispatcherShape["handle"] = (event, now) => {
      if (event._tag === "Disconnected")
        // Задачи не валим: потерю агента решает таймаут молчания на тике.
        return Effect.void;
      lastSeen.set(event.workerId, now);
      if (event._tag === "Connected")
        return reconnected(event.workerId, event.installs, now).pipe(
          logFailure("Install reconciliation failed", {
            workerId: event.workerId,
          }),
        );
      const { workerId, report } = event;
      // Отчёт по задаче от её агента — задача у него есть.
      if ("jobId" in report && missing.get(report.jobId)?.workerId === workerId)
        missing.delete(report.jobId);
      const effect = (() => {
        switch (report._tag) {
          case "InstallProgress":
            return withDb(
              InstallRepo.recordProgress(
                workerId,
                report.jobId,
                report.bytesDownloaded,
                report.bytesTotal,
              ),
            );
          case "InstallFinished":
            cancels.delete(report.jobId);
            return withDb(
              InstallRepo.finish(
                workerId,
                report.jobId,
                { sizeBytes: report.sizeBytes, buildId: report.buildId },
                now,
              ),
            ).pipe(
              Effect.flatMap((waiters) =>
                logFinished(report.jobId, waiters, {
                  workerId,
                  result: "done",
                  buildId: report.buildId,
                }),
              ),
            );
          case "InstallFailed": {
            // Итог задачи, которую мы отменили: успевшие присоединиться
            // сессии не виноваты — обратно в очередь, за новой задачей.
            const requeue = cancels.delete(report.jobId);
            return withDb(
              InstallRepo.fail(report.jobId, report.reason, now, {
                workerId,
                requeueWaiters: requeue,
              }),
            ).pipe(
              Effect.flatMap((waiters) =>
                logFinished(report.jobId, waiters, {
                  workerId,
                  result: requeue ? "cancelled" : "failed",
                  reason: report.reason,
                }),
              ),
            );
          }
          case "InstallStage":
            return withDb(
              InstallRepo.recordStage(workerId, report.jobId, report.stage),
            );
          case "SessionStage":
            // Эту сессию ведёт SessionRunner (своя подписка), не мы.
            return Effect.void;
          default:
            return Effect.void;
        }
      })();
      return effect.pipe(
        logFailure("Install report handling failed", {
          workerId,
          report: report._tag,
        }),
      );
    };

    /**
     * Задача потеряна агентом: `failed` (если всё ещё `running` на нём);
     * `cancel` — агенту ещё и CancelInstall, если она у него всё-таки идёт.
     */
    const interrupt = (
      jobId: string,
      workerId: string,
      now: Date,
      cancel = false,
    ) =>
      Effect.gen(function* () {
        cancels.delete(jobId);
        const waiters = yield* withDb(
          InstallRepo.fail(jobId, installErrors.interrupted, now, { workerId }),
        );
        if (waiters === undefined) return;
        yield* Effect.logWarning("Install job lost by its agent", {
          jobId,
          workerId,
          sessions: waiters,
        });
        if (cancel) yield* hub.send(workerId, { _tag: "CancelInstall", jobId });
      }).pipe(logFailure("Failing a lost install job failed", { jobId }));

    /** CancelInstall `running`-задачи агенту; повтор, пока не доставлен в текущее соединение. */
    const requestCancel = (jobId: string, workerId: string) =>
      Effect.gen(function* () {
        const sent = yield* hub.send(workerId, {
          _tag: "CancelInstall",
          jobId,
        });
        cancels.set(jobId, { workerId, delivered: sent });
        if (sent)
          yield* Effect.logInfo("CancelInstall sent", { jobId, workerId });
      });

    /**
     * Отменённые админом: `queued` — сразу `failed` (`cancelledByAdmin`, ждущие
     * тоже), `running` — CancelInstall, задача ждёт итога агента.
     */
    const cancelRequested = (now: Date) =>
      Effect.gen(function* () {
        for (const job of yield* withDb(InstallRepo.cancelRequestedJobs())) {
          if (job.state === "queued") {
            const waiters = yield* withDb(
              InstallRepo.fail(job.id, installErrors.cancelledByAdmin, now),
            );
            if (waiters !== undefined)
              yield* Effect.logInfo("Queued install job cancelled by admin", {
                jobId: job.id,
                sessions: waiters,
              });
            continue;
          }
          if (job.workerId === null || cancels.get(job.id)?.delivered) continue;
          yield* requestCancel(job.id, job.workerId);
        }
      });

    /** Ни одна сессия не ждёт задачу: `queued` — `failed`, `running` — CancelInstall. */
    const cancelAbandoned = Effect.gen(function* () {
      // Итог мог не дойти (задачу провалили иначе) — забываем завершённые.
      const running = new Set(
        (yield* withDb(InstallRepo.runningJobs())).map((job) => job.id),
      );
      for (const jobId of cancels.keys())
        if (!running.has(jobId)) cancels.delete(jobId);
      for (const { id: jobId } of yield* withDb(InstallRepo.abandonedJobs())) {
        if (cancels.get(jobId)?.delivered) continue;
        const outcome = yield* withDb(
          InstallRepo.abandon(jobId, installErrors.cancelled),
        );
        if (outcome === undefined) continue;
        if (outcome._tag === "Failed") {
          yield* Effect.logInfo("Abandoned queued install job cancelled", {
            jobId,
          });
          continue;
        }
        yield* requestCancel(jobId, outcome.workerId);
      }
    });

    /** Потерянные задачи: не в `installs` после переподключения или агент молчит. */
    const failLost = (now: Date) =>
      Effect.gen(function* () {
        for (const [jobId, { workerId, deadline, cancel }] of missing) {
          if (now.getTime() < deadline.getTime()) continue;
          missing.delete(jobId);
          yield* interrupt(jobId, workerId, now, cancel);
        }
        for (const job of yield* withDb(InstallRepo.runningJobs())) {
          const seen = lastSeen.get(job.workerId) ?? startedAt;
          if (now.getTime() - seen.getTime() > AGENT_TIMEOUT_MS)
            yield* interrupt(job.id, job.workerId, now);
        }
      });

    /**
     * Выдача: по одной задаче за транзакцию (`claimNext`), InstallGame — после
     * коммита. `steamLogin` — посеянный вход пользователя задачи
     * (`SteamLoginSeeds.get`, `null` — нет или просрочен); `steamLoginTimeoutSeconds`
     * — из текущих настроек сессий (ruling P1), читаются раз на проход. Не
     * доставлен — задача снова `queued`, агент до конца прохода не
     * используется. Если процесс упадёт между коммитом и отправкой, задачу
     * провалит сверка при переподключении агента или таймаут его молчания.
     */
    const dispatch = (now: Date) =>
      Effect.gen(function* () {
        let candidates = [...hub.connected()].filter(
          (id) => hub.info(id)?.roles.includes("gamestore") ?? false,
        );
        if (candidates.length === 0) return;
        const settings = yield* withDb(SessionRepo.loadSettings());
        while (candidates.length > 0) {
          const claim = yield* withDb(InstallRepo.claimNext(candidates));
          if (claim === undefined) return;
          const { job, workerId, profile } = claim;
          candidates = candidates.filter((id) => id !== workerId);
          const steamLogin = yield* seeds.get(job.userId);
          const sent = yield* hub.send(workerId, {
            _tag: "InstallGame",
            jobId: job.id,
            appId: job.appId,
            userId: job.userId,
            profile,
            steamLogin,
            steamLoginTimeoutSeconds: settings.steamLoginTimeoutSeconds,
          });
          if (sent) {
            dispatchedAt.set(job.id, now);
            yield* Effect.logInfo("Install job dispatched", {
              jobId: job.id,
              appId: job.appId,
              workerId,
            });
          } else {
            yield* withDb(InstallRepo.unclaim(claim));
            yield* Effect.logWarning(
              "InstallGame not delivered, job stays queued",
              { jobId: job.id, workerId },
            );
          }
        }
      });

    const tick: InstallDispatcherShape["tick"] = (now) =>
      Effect.gen(function* () {
        yield* cancelRequested(now).pipe(
          logFailure("Cancelling installs by admin failed"),
        );
        yield* cancelAbandoned.pipe(logFailure("Cancelling installs failed"));
        yield* failLost(now).pipe(logFailure("Checking installs failed"));
        yield* dispatch(now);
        for (const [jobId, sent] of dispatchedAt)
          if (now.getTime() - sent.getTime() > RECONCILE_GRACE_MS)
            dispatchedAt.delete(jobId);
      }).pipe(logFailure("Install dispatcher tick failed"));

    return { handle, tick } satisfies InstallDispatcherShape;
  });

/** Подписка на хаб и проход раз в 2 с (как у SessionRunner). */
const startLoops = (dispatcher: InstallDispatcherShape) =>
  Effect.gen(function* () {
    const hub = yield* AgentHub;
    const events = yield* hub.subscribe;
    yield* PubSub.take(events).pipe(
      Effect.flatMap((event) =>
        DateTime.nowAsDate.pipe(
          Effect.flatMap((now) => dispatcher.handle(event, now)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* DateTime.nowAsDate.pipe(
      Effect.flatMap(dispatcher.tick),
      Effect.repeat(Schedule.spaced(DISPATCH_INTERVAL)),
      Effect.forkScoped,
    );
  });

export class InstallDispatcher extends Context.Service<
  InstallDispatcher,
  InstallDispatcherShape
>()("@cg/orchestrator/InstallDispatcher") {
  /** Сервис без фоновых циклов (тесты вызывают `handle`/`tick` сами). */
  static readonly layerWithoutLoops = (
    options: InstallDispatcherOptions = {},
  ): Layer.Layer<InstallDispatcher, never, Db | AgentHub | SteamLoginSeeds> =>
    Layer.effect(InstallDispatcher, make(options));

  /** Сервис + подписка на события хаба + проход раз в 2 с. */
  static readonly layer: Layer.Layer<
    InstallDispatcher,
    never,
    Db | AgentHub | SteamLoginSeeds
  > = Layer.effect(InstallDispatcher, make({}).pipe(Effect.tap(startLoops)));
}
