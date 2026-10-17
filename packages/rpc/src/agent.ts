// Протокол агента воркера ↔ оркестратор (группа `agent.*`). Обслуживается только
// оркестратором на `GET /agent` (Bearer AGENT_TOKEN); в `AppRpcs` не входит —
// браузерный API её никогда не обслуживает.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Сессия, которая уже идёт на воркере в момент подключения агента (после
 * переподключения или перезапуска оркестратора). `streamUrl` — внутренний адрес
 * Selkies в сети `cg-sessions`; `gameRunning` — жив ли процесс игры.
 */
export const RunningSession = Schema.Struct({
  sessionId: Schema.String,
  slot: NonNegativeInt,
  streamUrl: Schema.String,
  gameRunning: Schema.Boolean,
});
export type RunningSession = typeof RunningSession.Type;

/** Порт веб-сервера Selkies в контейнере сессии. */
export const selkiesPort = 8080;

/**
 * Единственный допустимый внутренний адрес Selkies сессии в сети
 * `cg-sessions`: `http://cg-session-<sessionId>:8080`.
 */
export const sessionStreamUrl = (sessionId: string) =>
  `http://cg-session-${sessionId}:${selkiesPort}`;

/**
 * `streamUrl` — ровно адрес Selkies этой сессии (`sessionStreamUrl`): http,
 * хост `cg-session-<sessionId>`, порт 8080, без пути, query и учётных данных.
 * Оркестратор не записывает, а api не проксирует никакой другой адрес — иначе
 * подделанный отчёт агента превратил бы прокси стрима в SSRF.
 */
export const isSessionStreamUrl = (
  sessionId: string,
  streamUrl: string,
): boolean => {
  try {
    const url = new URL(streamUrl);
    const expected = new URL(sessionStreamUrl(sessionId));
    return (
      url.protocol === "http:" &&
      url.hostname === expected.hostname &&
      url.port === String(selkiesPort) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

/**
 * Подключение агента. `workerId` — имя воркера из конфига агента; слот `i`
 * на воркере — UDP-порт `udpPortBase + i`, публичный IP — `publicIp`.
 */
export const AgentConnect = Schema.Struct({
  workerId: Schema.String,
  publicIp: Schema.String,
  slots: NonNegativeInt,
  udpPortBase: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 65535 }),
  ),
  running: Schema.Array(RunningSession),
});
export type AgentConnect = typeof AgentConnect.Type;

/** Команда оркестратора агенту: поднять контейнер сессии или погасить его. */
export const AgentCommand = Schema.Union([
  Schema.TaggedStruct("StartSession", {
    sessionId: Schema.String,
    userId: Schema.String,
    appId: Schema.Int,
    slot: NonNegativeInt,
    udpPort: Schema.Int,
  }),
  Schema.TaggedStruct("StopSession", { sessionId: Schema.String }),
]);
export type AgentCommand = typeof AgentCommand.Type;

/**
 * Отчёт агента: стрим готов (`streamUrl` — внутренний адрес Selkies), состояние
 * процесса игры, heartbeat со списком живых сессий, контейнер остановлен
 * (`cloudSynced` — Steam Cloud успел синхронизироваться), сбой с причиной.
 */
export const AgentReport = Schema.Union([
  Schema.TaggedStruct("StreamReady", {
    sessionId: Schema.String,
    streamUrl: Schema.String,
  }),
  Schema.TaggedStruct("GameState", {
    sessionId: Schema.String,
    running: Schema.Boolean,
  }),
  Schema.TaggedStruct("Heartbeat", { sessionIds: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Stopped", {
    sessionId: Schema.String,
    cloudSynced: Schema.Boolean,
  }),
  Schema.TaggedStruct("Failed", {
    sessionId: Schema.String,
    reason: Schema.String,
  }),
]);
export type AgentReport = typeof AgentReport.Type;

/** `agent.report` пришёл по соединению, на котором нет активного `agent.connect`. */
export class AgentNotConnected extends Schema.TaggedError<AgentNotConnected>()(
  "AgentNotConnected",
  {},
) {}

/**
 * `agent.connect` — поток команд воркеру; жизнь соединения агента = жизнь этого
 * потока (обрыв → воркер отключён; поток завершился сам — подключился более новый
 * агент с тем же `workerId`). `agent.report` — отчёт по тому же WebSocket, на
 * котором открыт `agent.connect`.
 */
export const AgentRpcs = RpcGroup.make(
  Rpc.make("agent.connect", {
    payload: AgentConnect,
    success: AgentCommand,
    stream: true,
  }),
  Rpc.make("agent.report", {
    payload: AgentReport,
    error: AgentNotConnected,
  }),
);
