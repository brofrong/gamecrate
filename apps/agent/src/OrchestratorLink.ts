// OrchestratorLink: исходящее WebSocket-соединение агента с оркестратором
// (`agent.connect` + `agent.report`, NDJSON, Bearer WORKER_TOKEN — токен
// этого сервера, задача 4). Команды сессий передаёт SessionSupervisor,
// команды установки и удаления игр — Installer; их отчёты и снимки загрузки
// WorkerMonitor отправляет по одному, по порядку (каждого источника); на
// время соединения через него идут `agent.profileCommit` (ProfileCommitter).
// `agent.connect` несёт железо и версии воркера (WorkerMonitor).
// Обрыв, отказ в отчёте (AgentNotConnected), чужой токен (AgentUnauthorized —
// WORKER_TOKEN отозван или не принадлежит WORKER_ID) или замена соединения
// более новым — переподключение с паузой 1 → 30 с.
import {
  type AgentCommand,
  type AgentConnect,
  type AgentReport,
  AgentRpcs,
} from "@cg/rpc";
import { BunSocket } from "@effect/platform-bun";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Redacted,
  Stream,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { AgentConfig } from "./config";
import { Installer } from "./Installer";
import { ProfileCommitter } from "./profile/ProfileCommitter";
import { SessionSupervisor } from "./SessionSupervisor";
import { WorkerMonitor } from "./WorkerMonitor";

export const RECONNECT_MIN = Duration.seconds(1);
export const RECONNECT_MAX = Duration.seconds(30);
/** Соединение прожило столько — пауза перед следующим снова с RECONNECT_MIN. */
export const HEALTHY_CONNECTION = Duration.seconds(60);

/**
 * Итоговые отчёты: их не заменяет снимок `running`/`installs` при
 * переподключении (итог удаления игры — тем более: его нет ни в каком снимке).
 */
export const isTerminal = (report: AgentReport) =>
  report._tag === "Stopped" ||
  report._tag === "Failed" ||
  report._tag === "InstallFinished" ||
  report._tag === "InstallFailed" ||
  report._tag === "GameDeleted" ||
  report._tag === "GameDeleteFailed";

/** Следующая пауза: удвоение до RECONNECT_MAX. */
export const nextDelay = (delay: Duration.Duration) =>
  Duration.min(Duration.times(delay, 2), RECONNECT_MAX);

/**
 * `exit` — отказ `connection`, и среди его ошибок есть `AgentUnauthorized`
 * (чужой или отозванный `WORKER_TOKEN`, спека §3): своя причина, не сетевая —
 * быстрый повтор не поможет, в отличие от обрыва связи.
 */
export const isUnauthorized = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  Option.exists(
    Cause.findErrorOption(exit.cause),
    (error) =>
      (error as { readonly _tag?: unknown })._tag === "AgentUnauthorized",
  );

export const run = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const supervisor = yield* SessionSupervisor;
  const installer = yield* Installer;
  const committer = yield* ProfileCommitter;
  const monitor = yield* WorkerMonitor;
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      BunSocket.layerWebSocket(config.orchestratorUrl, {
        headers: {
          authorization: `Bearer ${Redacted.value(config.workerToken)}`,
        },
      }),
    ),
    Layer.provide(RpcSerialization.layerNdjson),
  );

  /**
   * Итоговые отчёты, не дошедшие до оркестратора: уходят первыми на следующем
   * соединении. Прочие отчёты без связи теряют смысл — их заменяет `running`.
   */
  const carry: Array<AgentReport> = [];

  /**
   * Отчёты сессий, установок и снимки загрузки в одной очереди (порядок внутри
   * источника сохраняется); перекачка идёт всё время жизни агента, и со связью,
   * и без.
   */
  const outbox = yield* Queue.unbounded<AgentReport>();
  for (const source of [supervisor.reports, installer.reports, monitor.reports])
    yield* Queue.take(source).pipe(
      Effect.flatMap((report) => Queue.offer(outbox, report)),
      Effect.forever,
      Effect.forkChild,
    );

  const connection = Effect.gen(function* () {
    const context = yield* Layer.build(protocol);
    const client = yield* RpcClient.make(AgentRpcs).pipe(
      Effect.provideContext(context),
    );
    yield* committer.attach((payload) =>
      client["agent.profileCommit"](payload),
    );
    const buffered = yield* Queue.clear(outbox);
    carry.push(...buffered.filter(isTerminal));
    const { hardware, versions } = yield* monitor.snapshot;
    const payload: AgentConnect = {
      // Тот же токен сервера, что на апгрейде `GET /agent` — оркестратор
      // сверяет, что он принадлежит именно `workerId` (AgentUnauthorized).
      token: config.workerToken,
      workerId: config.workerId,
      publicIp: config.publicIp,
      slots: config.slots,
      udpPortBase: config.udpPortBase,
      running: yield* supervisor.snapshot,
      roles: config.roles,
      installs: installer.running(),
      hardware,
      versions,
    };
    yield* Effect.logInfo("Connecting to orchestrator", {
      url: config.orchestratorUrl,
      running: payload.running.length,
      roles: payload.roles,
      installs: payload.installs,
    });

    const route = (command: AgentCommand) => {
      switch (command._tag) {
        case "InstallGame":
          return installer.install(command);
        case "CancelInstall":
          return installer.cancel(command.jobId);
        case "DeleteGame":
          return installer.deleteGame(command.appId);
        case "OpenTunnel":
          // Канал тоннеля стрима агент откроет в задаче 6; до тех пор relay
          // оркестратора отвечает api 502 по тайм-ауту.
          return Effect.logWarning("Stream tunnel is not supported yet", {
            tunnelId: command.tunnelId,
          });
        default:
          return supervisor.handle(command);
      }
    };
    const commands = client["agent.connect"](payload).pipe(
      Stream.runForEach((command) =>
        Effect.logInfo("Command received", {
          command: command._tag,
          id:
            "sessionId" in command
              ? command.sessionId
              : "jobId" in command
                ? command.jobId
                : command.appId,
        }).pipe(Effect.andThen(route(command))),
      ),
    );

    /** Один отчёт; не дошедший итоговый возвращается в `carry`. */
    const sendNext = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const report = carry.shift() ?? (yield* restore(Queue.take(outbox)));
        yield* restore(client["agent.report"](report)).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || !isTerminal(report)
              ? Effect.void
              : Effect.sync(() => carry.unshift(report)),
          ),
        );
      }),
    );

    yield* Effect.raceFirst(commands, Effect.forever(sendNext));
  }).pipe(Effect.scoped);

  let delay = RECONNECT_MIN;
  while (true) {
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(connection);
    const lived = Duration.millis((yield* Clock.currentTimeMillis) - startedAt);
    if (Duration.isGreaterThanOrEqualTo(lived, HEALTHY_CONNECTION))
      delay = RECONNECT_MIN;
    if (isUnauthorized(exit)) {
      delay = RECONNECT_MAX;
      yield* Effect.logError("Worker token rejected by orchestrator");
    } else if (Exit.isSuccess(exit))
      yield* Effect.logWarning(
        "Orchestrator ended the command stream (another agent with this WORKER_ID connected?)",
        { retryIn: Duration.format(delay) },
      );
    else
      yield* Effect.logWarning("Orchestrator connection lost", {
        retryIn: Duration.format(delay),
        cause: Cause.pretty(exit.cause),
      });
    yield* Effect.sleep(delay);
    delay = nextDelay(delay);
  }
});

/** Фоновое соединение с оркестратором на всё время жизни слоя. */
export const layer: Layer.Layer<
  never,
  never,
  AgentConfig | SessionSupervisor | Installer | ProfileCommitter | WorkerMonitor
> = Layer.effectDiscard(run.pipe(Effect.forkScoped));
