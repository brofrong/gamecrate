// OrchestratorLink: исходящее WebSocket-соединение агента с оркестратором
// (`agent.connect` + `agent.report`, NDJSON, Bearer AGENT_TOKEN). Команды из
// потока передаёт SessionSupervisor, его отчёты отправляет по одному, по порядку;
// на время соединения через него идут `agent.profileCommit` (ProfileCommitter).
// Обрыв, отказ в отчёте (AgentNotConnected) или замена соединения более новым —
// переподключение с паузой 1 → 30 с.
import { type AgentConnect, type AgentReport, AgentRpcs } from "@cg/rpc";
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
import { ProfileCommitter } from "./profile/ProfileCommitter";
import { SessionSupervisor } from "./SessionSupervisor";

export const RECONNECT_MIN = Duration.seconds(1);
export const RECONNECT_MAX = Duration.seconds(30);
/** Соединение прожило столько — пауза перед следующим снова с RECONNECT_MIN. */
export const HEALTHY_CONNECTION = Duration.seconds(60);

/** Итоговые отчёты: их не заменяет снимок `running` при переподключении. */
const isTerminal = (report: AgentReport) =>
  report._tag === "Stopped" || report._tag === "Failed";

/** Следующая пауза: удвоение до RECONNECT_MAX. */
export const nextDelay = (delay: Duration.Duration) =>
  Duration.min(Duration.times(delay, 2), RECONNECT_MAX);

export const run = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const supervisor = yield* SessionSupervisor;
  const committer = yield* ProfileCommitter;
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

  const connection = Effect.gen(function* () {
    const context = yield* Layer.build(protocol);
    const client = yield* RpcClient.make(AgentRpcs).pipe(
      Effect.provideContext(context),
    );
    yield* committer.attach((payload) =>
      client["agent.profileCommit"](payload),
    );
    const buffered = yield* Queue.clear(supervisor.reports);
    carry.push(...buffered.filter(isTerminal));
    const payload: AgentConnect = {
      workerId: config.workerId,
      publicIp: config.publicIp,
      slots: config.slots,
      udpPortBase: config.udpPortBase,
      running: yield* supervisor.snapshot,
      // Task 4: роль gamestore и список живых установок (конфиг агента пока
      // не знает про роли — этот агент всегда "worker" без установок).
      roles: ["worker"],
      installs: [],
    };
    yield* Effect.logInfo("Connecting to orchestrator", {
      url: config.orchestratorUrl,
      running: payload.running.length,
    });

    const commands = client["agent.connect"](payload).pipe(
      Stream.runForEach((command) =>
        // Task 4: InstallGame/CancelInstall не несут sessionId — лог общий по тегу.
        Effect.logInfo("Command received", {
          command: command._tag,
        }).pipe(Effect.andThen(supervisor.handle(command))),
      ),
    );

    /** Один отчёт; не дошедший итоговый возвращается в `carry`. */
    const sendNext = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const report =
          carry.shift() ?? (yield* restore(Queue.take(supervisor.reports)));
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
  AgentConfig | SessionSupervisor | ProfileCommitter
> = Layer.effectDiscard(run.pipe(Effect.forkScoped));
