// Ведение сессий: события хаба агентов и таймеры (раз в 5 с) превращаются в
// события автомата `decide`, решения применяются к БД, StopContainer уходит агенту.
import { Db, type SessionState } from "@cg/db";
import type { RunningSession } from "@cg/rpc";
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
import type { LifecycleEvent } from "./lifecycle";
import * as SessionRepo from "./SessionRepo";

/** Период таймеров сессий. */
export const RUNNER_INTERVAL = "5 seconds";

/** Причина для сессии, о которой переподключившийся агент не знает. */
export const lostOnRestartReason = "Сессия потеряна при перезапуске сервера";

/**
 * Только что назначенная сессия (`starting`, `agentSeenAt` моложе этого) при
 * сверке не валится: её StartSession мог прийти в это же соединение уже после
 * того, как агент отправил список `running`. Если она и правда потеряна, её
 * завершит таймаут агента (90 с).
 */
export const RECONCILE_GRACE_MS = 10_000;

/** Состояния, в которых игра запущена (есть открытый отрезок). */
const gameStates: ReadonlySet<SessionState> = new Set([
  "playing",
  "idle_warning",
  "disconnected",
]);

export interface SessionRunnerShape {
  /** Обработать событие хаба в момент `now`. Сбои логируются. */
  readonly handle: (event: AgentHubEvent, now: Date) => Effect.Effect<void>;
  /**
   * Таймеры: каждой активной сессии — `UserStop` (если запрошена остановка и
   * сессия ещё не `stopping`) или `Tick`; затем повтор StopSession для
   * `stopping`-сессий, которым команда ещё не доставлена.
   */
  readonly tick: (now: Date) => Effect.Effect<void>;
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

const make = Effect.gen(function* () {
  const db = yield* Db;
  const hub = yield* AgentHub;
  /** Сессии, которым StopSession доставлен в текущее соединение агента. */
  const stopSent = new Set<string>();

  const withDb = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.provideService(effect, Db, db);

  /** Попросить агента погасить контейнер; не подключён — повторим на тике. */
  const sendStop = (workerId: string | null, sessionId: string) =>
    Effect.gen(function* () {
      if (workerId === null) return;
      const sent = yield* hub.send(workerId, {
        _tag: "StopSession",
        sessionId,
      });
      if (sent) {
        stopSent.add(sessionId);
        yield* Effect.logInfo("StopSession sent", { sessionId, workerId });
      } else {
        stopSent.delete(sessionId);
        yield* Effect.logWarning(
          "StopSession pending: agent not connected, will retry",
          { sessionId, workerId },
        );
      }
    });

  /**
   * Шаг автомата для сессии под блокировкой; `pick` выбирает событие по
   * актуальной строке. Смену состояния логируем, StopContainer отправляем.
   */
  const step = (
    sessionId: string,
    now: Date,
    pick: (row: SessionRepo.SessionRow) => LifecycleEvent | null,
  ) =>
    withDb(
      Effect.gen(function* () {
        const settings = yield* SessionRepo.loadSettings();
        const result = yield* SessionRepo.transition(
          sessionId,
          now,
          settings,
          pick,
        );
        if (result?.decision == null) return;
        const { row, decision } = result;
        if (decision.state !== row.state)
          yield* Effect.logInfo("Session state changed", {
            sessionId,
            from: row.state,
            to: decision.state,
            ...(decision.failReason !== null && {
              reason: decision.failReason,
            }),
          });
        if (decision.command === "StopContainer")
          yield* sendStop(row.workerId, sessionId);
      }),
    );

  /** Событие агента о сессии принимается, только если сессия на этом воркере. */
  const fromWorker =
    (workerId: string, event: LifecycleEvent | null) =>
    (row: SessionRepo.SessionRow) => (row.workerId === workerId ? event : null);

  /** `GameState`: запуск — `GameStarted`; выход — `GameExited`, только если игра шла. */
  const gameState = (
    workerId: string,
    sessionId: string,
    running: boolean,
    now: Date,
  ) =>
    step(sessionId, now, (row) => {
      if (row.workerId !== workerId) return null;
      if (running) return { _tag: "GameStarted" };
      return gameStates.has(row.state) ? { _tag: "GameExited" } : null;
    });

  /**
   * Агент (пере)подключился со списком идущих сессий. Активные сессии воркера,
   * которых в списке нет, — `failed` (кроме только что назначенных). Известные —
   * как heartbeat + адрес стрима + состояние игры. Контейнеры неизвестных
   * сессий гасим, чтобы освободить слот.
   */
  const reconcile = (
    workerId: string,
    running: ReadonlyArray<RunningSession>,
    now: Date,
  ) =>
    Effect.gen(function* () {
      const active = yield* withDb(SessionRepo.activeOnWorker(workerId));
      const activeIds = new Set(active.map((s) => s.id));
      const runningIds = new Set(running.map((s) => s.sessionId));

      for (const session of active) {
        // Команды прежнего соединения могли потеряться.
        stopSent.delete(session.id);
        if (runningIds.has(session.id)) continue;
        const justScheduled =
          session.state === "starting" &&
          session.agentSeenAt !== null &&
          now.getTime() - session.agentSeenAt.getTime() < RECONCILE_GRACE_MS;
        if (justScheduled) continue;
        yield* Effect.logWarning("Session unknown to reconnected agent", {
          sessionId: session.id,
          workerId,
        });
        yield* step(
          session.id,
          now,
          fromWorker(workerId, { _tag: "Failed", reason: lostOnRestartReason }),
        ).pipe(
          logFailure("Lost session update failed", { sessionId: session.id }),
        );
      }

      const known = running.filter((s) => activeIds.has(s.sessionId));
      yield* withDb(
        SessionRepo.recordHeartbeat(
          workerId,
          known.map((s) => s.sessionId),
          now,
        ),
      );
      for (const session of known) {
        yield* withDb(
          SessionRepo.setStreamUrl(
            workerId,
            session.sessionId,
            session.streamUrl,
          ),
        );
        yield* gameState(
          workerId,
          session.sessionId,
          session.gameRunning,
          now,
        ).pipe(
          logFailure("Running session update failed", {
            sessionId: session.sessionId,
          }),
        );
      }

      for (const session of running) {
        if (activeIds.has(session.sessionId)) continue;
        yield* Effect.logWarning("Stopping container of an unknown session", {
          sessionId: session.sessionId,
          workerId,
        });
        yield* hub.send(workerId, {
          _tag: "StopSession",
          sessionId: session.sessionId,
        });
      }
    });

  const handle: SessionRunnerShape["handle"] = (event, now) => {
    switch (event._tag) {
      case "Connected":
        return reconcile(event.workerId, event.running, now).pipe(
          logFailure("Agent reconnect reconciliation failed", {
            workerId: event.workerId,
          }),
        );
      case "Disconnected":
        // Сессии не валим: потерю агента решает таймаут heartbeat в `decide`.
        return Effect.logInfo("Agent disconnected, waiting for heartbeat", {
          workerId: event.workerId,
        });
      case "Report": {
        const { workerId, report } = event;
        const effect = (() => {
          switch (report._tag) {
            case "StreamReady":
              return withDb(
                SessionRepo.setStreamUrl(
                  workerId,
                  report.sessionId,
                  report.streamUrl,
                ),
              );
            case "GameState":
              return gameState(workerId, report.sessionId, report.running, now);
            case "Heartbeat":
              return withDb(
                SessionRepo.recordHeartbeat(workerId, report.sessionIds, now),
              );
            case "Stopped":
              return step(
                report.sessionId,
                now,
                fromWorker(workerId, { _tag: "StopFinished" }),
              );
            case "Failed":
              return step(
                report.sessionId,
                now,
                fromWorker(workerId, { _tag: "Failed", reason: report.reason }),
              );
          }
        })();
        return effect.pipe(
          logFailure("Agent report handling failed", {
            workerId,
            report: report._tag,
          }),
        );
      }
    }
  };

  const tick: SessionRunnerShape["tick"] = (now) =>
    Effect.gen(function* () {
      const active = yield* withDb(SessionRepo.activeSessions());
      for (const session of active) {
        yield* step(session.id, now, (row) =>
          row.stopRequestedAt !== null && row.state !== "stopping"
            ? { _tag: "UserStop" }
            : { _tag: "Tick" },
        ).pipe(logFailure("Session tick failed", { sessionId: session.id }));
      }

      // Повтор StopSession: агент был не подключён или переподключился.
      const stopping = (yield* withDb(SessionRepo.activeSessions())).filter(
        (s) => s.state === "stopping",
      );
      const stoppingIds = new Set(stopping.map((s) => s.id));
      for (const id of stopSent) if (!stoppingIds.has(id)) stopSent.delete(id);
      for (const session of stopping)
        if (!stopSent.has(session.id))
          yield* sendStop(session.workerId, session.id);
    }).pipe(logFailure("Session runner tick failed"));

  return { handle, tick } satisfies SessionRunnerShape;
});

/**
 * Циклы: подписка на хаб (до старта HTTP-сервера, события до подписки не
 * повторяются) и таймеры раз в 5 с.
 */
const startLoops = (runner: SessionRunnerShape) =>
  Effect.gen(function* () {
    const hub = yield* AgentHub;
    const events = yield* hub.subscribe;
    const already = [...hub.connected()];
    if (already.length > 0)
      // `running` этих агентов не известен до их переподключения; StopSession
      // повторится на тике, потерю агента решит таймаут heartbeat.
      yield* Effect.logWarning("Agents connected before runner subscribed", {
        workerIds: already,
      });
    yield* PubSub.take(events).pipe(
      Effect.flatMap((event) =>
        DateTime.nowAsDate.pipe(
          Effect.flatMap((now) => runner.handle(event, now)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* DateTime.nowAsDate.pipe(
      Effect.flatMap(runner.tick),
      Effect.repeat(Schedule.spaced(RUNNER_INTERVAL)),
      Effect.forkScoped,
    );
  });

export class SessionRunner extends Context.Service<
  SessionRunner,
  SessionRunnerShape
>()("@cg/orchestrator/SessionRunner") {
  /** Сервис без фоновых циклов (тесты вызывают `handle`/`tick` сами). */
  static readonly layerWithoutLoops: Layer.Layer<
    SessionRunner,
    never,
    Db | AgentHub
  > = Layer.effect(SessionRunner, make);

  /** Сервис + подписка на события хаба + таймеры раз в 5 с. */
  static readonly layer: Layer.Layer<SessionRunner, never, Db | AgentHub> =
    Layer.effect(SessionRunner, make.pipe(Effect.tap(startLoops)));
}
