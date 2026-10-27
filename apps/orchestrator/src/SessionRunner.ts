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
import {
  AGENT_TIMEOUT_MS,
  type LifecycleEvent,
  type Snapshot,
} from "./lifecycle";
import * as SessionRepo from "./SessionRepo";

/** Период таймеров сессий. */
export const RUNNER_INTERVAL = "5 seconds";

/** Причина для сессии, о которой переподключившийся агент не знает. */
export const lostOnRestartReason = "Сессия потеряна при перезапуске сервера";

/**
 * Только что назначенная сессия (`starting`, `stateSince` моложе этого) при
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

/**
 * Сбой обработчика не должен ронять цикл: логируем (кроме прерывания). Общий
 * для фоновых циклов оркестратора (раннер, диспетчер установок).
 */
export const logFailure =
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

export interface SessionRunnerOptions {
  /** Момент старта раннера (по умолчанию — сейчас). */
  readonly startedAt?: Date;
}

const make = (options: SessionRunnerOptions) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    const startedAt = options.startedAt ?? (yield* DateTime.nowAsDate);

    /**
     * После старта оркестратора агенты переподключаются не сразу, а их heartbeat'ы
     * за время простоя не записаны. Пока с запуска не прошло `AGENT_TIMEOUT_MS`,
     * таймаут агента отсчитывается не раньше чем от `startedAt`: каждый воркер
     * получает полные 90 с, чтобы переподключиться. Потом — настоящий
     * `agentSeenAt` (отрезок закроется на последнем реальном heartbeat'е).
     */
    const withRestartGrace = (snapshot: Snapshot, now: Date): Snapshot => {
      if (now.getTime() - startedAt.getTime() > AGENT_TIMEOUT_MS)
        return snapshot;
      const agentRef = snapshot.agentSeenAt ?? snapshot.stateSince;
      return agentRef.getTime() < startedAt.getTime()
        ? { ...snapshot, agentSeenAt: startedAt }
        : snapshot;
    };
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
      pick: (
        row: SessionRepo.SessionRow,
        snapshot: Snapshot,
      ) => SessionRepo.Pick | null,
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
      (row: SessionRepo.SessionRow) =>
        row.workerId === workerId ? event : null;

    /**
     * `GameState`: запуск — `GameStarted`; выход — `GameExited`, только если игра
     * шла. `exitedBy: "lastHeartbeat"` — момент выхода неизвестен (агент сообщил
     * его после переподключения): отрезок закрывается на последнем heartbeat'е.
     */
    const gameState = (
      workerId: string,
      sessionId: string,
      running: boolean,
      now: Date,
      exitedBy: "now" | "lastHeartbeat" = "now",
    ) =>
      step(sessionId, now, (row, snapshot): SessionRepo.Pick | null => {
        if (row.workerId !== workerId) return null;
        if (running) return { _tag: "GameStarted" };
        if (!gameStates.has(row.state)) return null;
        const lastSeen = snapshot.openSegment?.endedAt;
        return exitedBy === "lastHeartbeat" && lastSeen !== undefined
          ? { event: { _tag: "GameExited" }, at: lastSeen }
          : { _tag: "GameExited" };
      });

    /**
     * Агент (пере)подключился со списком идущих сессий. Активные сессии воркера,
     * которых в списке нет: `stopping` — контейнер уже погашен (`StopFinished`),
     * остальные — `failed` (кроме только что назначенных). Строки воркера в
     * `ended`/`failed` (включая только что ставшие такими выше), которых нет
     * среди идущих, — `releaseStaleSlots` (слот свободен: контейнера нет).
     * Известные — heartbeat (отрезок продлевается только при `gameRunning`) +
     * адрес стрима + состояние игры. Контейнеры неизвестных сессий гасим,
     * чтобы агент освободил слот (отчётом `Stopped`/`Failed`).
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
            now.getTime() - session.stateSince.getTime() < RECONCILE_GRACE_MS;
          if (justScheduled) continue;
          if (session.state === "stopping") {
            yield* step(
              session.id,
              now,
              fromWorker(workerId, { _tag: "StopFinished" }),
            ).pipe(
              logFailure("Stopped session update failed", {
                sessionId: session.id,
              }),
            );
            continue;
          }
          yield* Effect.logWarning("Session unknown to reconnected agent", {
            sessionId: session.id,
            workerId,
          });
          yield* step(
            session.id,
            now,
            fromWorker(workerId, {
              _tag: "Failed",
              reason: lostOnRestartReason,
            }),
          ).pipe(
            logFailure("Lost session update failed", { sessionId: session.id }),
          );
        }

        // Строки этого воркера, уже ended/failed и не в `running`: контейнера
        // действительно нет (в т. ч. те, что стали такими в цикле выше) — слот
        // свободен. Строка из `running` не трогается: агент может ещё гасить
        // её контейнер, слот освободит отчёт Stopped/Failed.
        yield* withDb(
          SessionRepo.releaseStaleSlots(workerId, [...runningIds], now),
        );

        const known = running.filter((s) => activeIds.has(s.sessionId));
        yield* withDb(
          SessionRepo.recordHeartbeat(
            workerId,
            known.map((s) => s.sessionId),
            now,
            known.filter((s) => s.gameRunning).map((s) => s.sessionId),
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
            "lastHeartbeat",
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
                return gameState(
                  workerId,
                  report.sessionId,
                  report.running,
                  now,
                );
              case "Heartbeat":
                return withDb(
                  SessionRepo.recordHeartbeat(workerId, report.sessionIds, now),
                );
              case "Stopped": {
                // Профиль не сохранён: агент оставил контейнер со слоями
                // (`profile-unsaved`) — нужен разбор вручную (deploy/README.md).
                // Контейнер остановлен в любом случае (сохранён профиль или
                // нет) — слот выпускаем независимо от состояния строки: она
                // может быть уже терминальной (например, если сессию погасили
                // как неизвестную при сверке), `step` для неё ничего не делает.
                let userId: string | undefined;
                return Effect.gen(function* () {
                  yield* step(report.sessionId, now, (row) => {
                    userId = row.userId;
                    return fromWorker(workerId, { _tag: "StopFinished" })(row);
                  });
                  yield* withDb(
                    SessionRepo.releaseSlot(workerId, report.sessionId, now),
                  );
                  if (!report.profileSaved)
                    yield* Effect.logWarning(
                      "Session profile not saved (profile-unsaved on the agent)",
                      { sessionId: report.sessionId, userId, workerId },
                    );
                });
              }
              case "Failed":
                // Агент шлёт `Failed` уже после удаления контейнера — слот
                // выпускаем вместе с переводом сессии в `failed`.
                return Effect.gen(function* () {
                  yield* step(
                    report.sessionId,
                    now,
                    fromWorker(workerId, {
                      _tag: "Failed",
                      reason: report.reason,
                    }),
                  );
                  yield* withDb(
                    SessionRepo.releaseSlot(workerId, report.sessionId, now),
                  );
                });
              case "InstallProgress":
              case "InstallFinished":
              case "InstallFailed":
              case "InstallStage":
                // Задачу и ждущие её сессии ведёт InstallDispatcher (своя подписка).
                return Effect.void;
              case "SessionStage":
                return withDb(
                  SessionRepo.setStage(
                    workerId,
                    report.sessionId,
                    report.stage,
                  ),
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
          yield* step(session.id, now, (row, snapshot) =>
            row.stopRequestedAt !== null && row.state !== "stopping"
              ? { _tag: "UserStop" }
              : {
                  event: { _tag: "Tick" },
                  snapshot: withRestartGrace(snapshot, now),
                },
          ).pipe(logFailure("Session tick failed", { sessionId: session.id }));
        }

        // Повтор StopSession: агент был не подключён или переподключился.
        const stopping = (yield* withDb(SessionRepo.activeSessions())).filter(
          (s) => s.state === "stopping",
        );
        const stoppingIds = new Set(stopping.map((s) => s.id));
        for (const id of stopSent)
          if (!stoppingIds.has(id)) stopSent.delete(id);
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
  static readonly layerWithoutLoops = (
    options: SessionRunnerOptions = {},
  ): Layer.Layer<SessionRunner, never, Db | AgentHub> =>
    Layer.effect(SessionRunner, make(options));

  /** Сервис + подписка на события хаба + таймеры раз в 5 с. */
  static readonly layer: Layer.Layer<SessionRunner, never, Db | AgentHub> =
    Layer.effect(SessionRunner, make({}).pipe(Effect.tap(startLoops)));
}
