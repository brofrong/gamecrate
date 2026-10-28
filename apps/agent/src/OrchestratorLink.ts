// OrchestratorLink: исходящее WebSocket-соединение агента с оркестратором
// (`agent.connect` + `agent.report`, NDJSON, Bearer AGENT_TOKEN). Команды сессий
// передаёт SessionSupervisor, команды установки — Installer; их отчёты и снимки
// загрузки WorkerMonitor отправляет по одному, по порядку (каждого источника); на
// время соединения через него идут `agent.profileCommit` (ProfileCommitter).
// `agent.connect` несёт железо и версии воркера (WorkerMonitor).
// Обрыв, отказ в отчёте (AgentNotConnected) или замена соединения более новым —
// переподключение с паузой 1 → 30 с.
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
 * переподключении.
 */
export const isTerminal = (report: AgentReport) =>
  report._tag === "Stopped" ||
  report._tag === "Failed" ||
  report._tag === "InstallFinished" ||
  report._tag === "InstallFailed";

/** Следующая пауза: удвоение до RECONNECT_MAX. */
export const nextDelay = (delay: Duration.Duration) =>
  Duration.min(Duration.times(delay, 2), RECONNECT_MAX);

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
          authorization: `Bearer ${Redacted.value(config.agentToken)}`,
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
    const payload: AgentConnect = {
      workerId: config.workerId,
      publicIp: config.publicIp,
      slots: config.slots,
      udpPortBase: config.udpPortBase,
      running: yield* supervisor.snapshot,
      roles: config.roles,
      installs: installer.running(),
      hardware: yield* monitor.hardware,
      versions: yield* monitor.versions,
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
        default:
          return supervisor.handle(command);
      }
    };
    const commands = client["agent.connect"](payload).pipe(
      Stream.runForEach((command) =>
        Effect.logInfo("Command received", {
          command: command._tag,
          id: "sessionId" in command ? command.sessionId : command.jobId,
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
    if (Exit.isSuccess(exit))
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
