// Установки игр: раз в 2 с выдаёт задачи из очереди агентам с ролью gamestore,
// отменяет брошенные и валит потерянные; отчёты агентов об установке (прогресс,
// итог) переводит в задачи и ждущие их сессии.
import { Db } from "@cg/db";
import {
  Cause,
  Context,
  DateTime,
  Effect,
  Layer,
  PubSub,
  Schedule,
} from "effect";
import { AgentHub, type AgentHubEvent } from "./AgentHub";
import * as InstallRepo from "./InstallRepo";
import { AGENT_TIMEOUT_MS } from "./lifecycle";
import { RECONCILE_GRACE_MS } from "./SessionRunner";

/** Период диспетчера установок. */
export const DISPATCH_INTERVAL = "2 seconds";

/** Ошибки задач, которые ставит сам оркестратор (`install_jobs.error`). */
export const installErrors = {
  /** Агент перезапустился без установки или молчит дольше `AGENT_TIMEOUT_MS`. */
  interrupted: "Установка прервана",
  /** Ни одна сессия больше не ждёт задачу, агенту она ещё не выдана. */
  cancelled: "Установка отменена",
} as const;

export interface InstallDispatcherShape {
  /** Обработать событие хаба в момент `now`. Сбои логируются. */
  readonly handle: (event: AgentHubEvent, now: Date) => Effect.Effect<void>;
  /**
   * Проход: брошенные задачи (CancelInstall / `failed`), потерянные агентом
   * (`failed`), затем выдача `queued`-задач свободным агентам gamestore.
   */
  readonly tick: (now: Date) => Effect.Effect<void>;
}

export interface InstallDispatcherOptions {
  /** Момент старта диспетчера (по умолчанию — сейчас). */
  readonly startedAt?: Date;
}

/** Сбой обработчика не должен ронять цикл: логируем (кроме прерывания). */
const logFailure =
  (message: string, annotations: Record<string, unknown> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError(message, Cause.pretty(cause)),
      ),
      Effect.annotateLogs(annotations),
    );

const make = (options: InstallDispatcherOptions) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
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
     * если через `RECONCILE_GRACE_MS` они всё ещё `running` на нём — за это
     * время доходят итоговые отчёты, перенесённые агентом через переподключение.
     */
    const missing = new Map<string, { workerId: string; since: Date }>();
    /** CancelInstall доставлен в текущее соединение агента (jobId → workerId). */
    const cancelSent = new Map<string, string>();

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
     * `installs` (кроме только что выданных — InstallGame мог прийти в это же
     * соединение после снимка), — под подозрением до конца сверки. Установки,
     * которых мы на нём не ждём, отменяем: иначе агент занят чужой работой.
     */
    const reconnected = (
      workerId: string,
      installs: ReadonlyArray<string>,
      now: Date,
    ) =>
      Effect.gen(function* () {
        // Команды прежнего соединения могли потеряться; прежняя сверка устарела.
        for (const [jobId, owner] of cancelSent)
          if (owner === workerId) cancelSent.delete(jobId);
        for (const [jobId, entry] of missing)
          if (entry.workerId === workerId) missing.delete(jobId);
        const running = yield* withDb(InstallRepo.runningJobs(workerId));
        const live = new Set(installs);
        for (const job of running) {
          if (live.has(job.id)) continue;
          const sent = dispatchedAt.get(job.id);
          if (
            sent !== undefined &&
            now.getTime() - sent.getTime() < RECONCILE_GRACE_MS
          )
            continue;
          missing.set(job.id, { workerId, since: now });
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
          case "InstallFailed":
            return withDb(
              InstallRepo.fail(report.jobId, report.reason, now, workerId),
            ).pipe(
              Effect.flatMap((waiters) =>
                logFinished(report.jobId, waiters, {
                  workerId,
                  result: "failed",
                  reason: report.reason,
                }),
              ),
            );
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

    /** Задача потеряна агентом: `failed` (если всё ещё `running` на нём). */
    const interrupt = (jobId: string, workerId: string, now: Date) =>
      withDb(
        InstallRepo.fail(jobId, installErrors.interrupted, now, workerId),
      ).pipe(
        Effect.flatMap((waiters) =>
          waiters === undefined
            ? Effect.void
            : Effect.logWarning("Install job lost by its agent", {
                jobId,
                workerId,
                sessions: waiters,
              }),
        ),
        logFailure("Failing a lost install job failed", { jobId }),
      );

    /** Ни одна сессия не ждёт задачу: `queued` — `failed`, `running` — CancelInstall. */
    const cancelAbandoned = Effect.gen(function* () {
      const abandoned = yield* withDb(InstallRepo.abandonedJobs());
      const ids = new Set(abandoned.map((job) => job.id));
      for (const jobId of cancelSent.keys())
        if (!ids.has(jobId)) cancelSent.delete(jobId);
      for (const { id: jobId } of abandoned) {
        if (cancelSent.has(jobId)) continue;
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
        const sent = yield* hub.send(outcome.workerId, {
          _tag: "CancelInstall",
          jobId,
        });
        if (sent) {
          cancelSent.set(jobId, outcome.workerId);
          yield* Effect.logInfo("CancelInstall sent", {
            jobId,
            workerId: outcome.workerId,
          });
        }
      }
    });

    /** Потерянные задачи: не в `installs` после переподключения или агент молчит. */
    const failLost = (now: Date) =>
      Effect.gen(function* () {
        for (const [jobId, { workerId, since }] of missing) {
          if (now.getTime() - since.getTime() < RECONCILE_GRACE_MS) continue;
          missing.delete(jobId);
          yield* interrupt(jobId, workerId, now);
        }
        for (const job of yield* withDb(InstallRepo.runningJobs())) {
          const seen = lastSeen.get(job.workerId) ?? startedAt;
          if (now.getTime() - seen.getTime() > AGENT_TIMEOUT_MS)
            yield* interrupt(job.id, job.workerId, now);
        }
      });

    /**
     * Выдача: по одной задаче за транзакцию (`claimNext`), InstallGame — после
     * коммита. Не доставлен — задача снова `queued`, агент до конца прохода не
     * используется. Если процесс упадёт между коммитом и отправкой, задачу
     * провалит сверка при переподключении агента или таймаут его молчания.
     */
    const dispatch = (now: Date) =>
      Effect.gen(function* () {
        let candidates = [...hub.connected()].filter(
          (id) => hub.info(id)?.roles.includes("gamestore") ?? false,
        );
        while (candidates.length > 0) {
          const claim = yield* withDb(InstallRepo.claimNext(candidates));
          if (claim === undefined) return;
          const { job, workerId, profile } = claim;
          candidates = candidates.filter((id) => id !== workerId);
          const sent = yield* hub.send(workerId, {
            _tag: "InstallGame",
            jobId: job.id,
            appId: job.appId,
            userId: job.userId,
            profile,
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
  ): Layer.Layer<InstallDispatcher, never, Db | AgentHub> =>
    Layer.effect(InstallDispatcher, make(options));

  /** Сервис + подписка на события хаба + проход раз в 2 с. */
  static readonly layer: Layer.Layer<InstallDispatcher, never, Db | AgentHub> =
    Layer.effect(InstallDispatcher, make({}).pipe(Effect.tap(startLoops)));
}
