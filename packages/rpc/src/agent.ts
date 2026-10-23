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

/** Роли агента: `worker` — сессии, `gamestore` — установка игр в общую библиотеку. */
export const AgentRoles = Schema.Array(
  Schema.Literals(["worker", "gamestore"]),
);
export type AgentRoles = typeof AgentRoles.Type;

/**
 * Подключение агента. `workerId` — имя воркера из конфига агента; слот `i`
 * на воркере — UDP-порт `udpPortBase + i`, публичный IP — `publicIp`.
 * `installs` — id задач установки, чьи контейнеры у агента ещё живы (роль
 * `gamestore`; снимок для переподключения, как `running` для сессий).
 */
export const AgentConnect = Schema.Struct({
  workerId: Schema.String,
  publicIp: Schema.String,
  slots: NonNegativeInt,
  udpPortBase: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 65535 }),
  ),
  running: Schema.Array(RunningSession),
  roles: AgentRoles,
  installs: Schema.Array(Schema.String),
});
export type AgentConnect = typeof AgentConnect.Type;

/**
 * Ссылка на объект профиля пользователя в `profiles` — передаётся агенту,
 * чтобы он собрал дом сессии/установки из актуальной версии (спека §6).
 */
export const ProfileRef = Schema.Struct({
  version: Schema.Int,
  objectKey: Schema.String,
});
export type ProfileRef = typeof ProfileRef.Type;

/**
 * Профиль Steam, который агент сеет в дом контейнера перед запуском сессии
 * или установщика: вместо (или до) QR-входа установщик сразу использует этот
 * аккаунт (спека §4). `accountName` и `refreshToken` никогда не должны
 * попасть в лог, БД или браузер — отсюда `Redacted`; по WebSocket агенту они
 * всё равно уходят (кодирование `SteamLoginSeed` отдаёт исходную строку),
 * только `console.log`/`String()`/`JSON.stringify` их не печатают.
 *
 * `Schema.Redacted` ожидает на входе уже обёрнутый `Redacted` (не декодируется
 * из простого JSON-значения), поэтому для сырых значений с провода нужен
 * `RedactedFromValue` — он декодирует значение в `Redacted` и кодирует его
 * обратно в исходное значение (P2 из общего контекста плана).
 */
export const SteamLoginSeed = Schema.Struct({
  accountName: Schema.RedactedFromValue(Schema.String),
  steamId: Schema.String,
  refreshToken: Schema.RedactedFromValue(Schema.String),
});
export type SteamLoginSeed = typeof SteamLoginSeed.Type;

/**
 * Команда оркестратора агенту: поднять или погасить контейнер сессии,
 * запустить или отменить установку игры в общую библиотеку (роль `gamestore`).
 * `steamLogin` — профиль для посева (Task 2); `null`, пока вызывающая сторона
 * не завела его. `InstallGame.steamLoginTimeoutSeconds` — сколько установщик
 * ждёт сканирования QR до `InstallFailed` (из `SessionSettings`, ruling P1).
 */
export const AgentCommand = Schema.Union([
  Schema.TaggedStruct("StartSession", {
    sessionId: Schema.String,
    userId: Schema.String,
    appId: Schema.Int,
    slot: NonNegativeInt,
    udpPort: Schema.Int,
    profile: Schema.NullOr(ProfileRef),
    steamLogin: Schema.NullOr(SteamLoginSeed),
  }),
  Schema.TaggedStruct("StopSession", { sessionId: Schema.String }),
  Schema.TaggedStruct("InstallGame", {
    jobId: Schema.String,
    appId: Schema.Int,
    userId: Schema.String,
    profile: Schema.NullOr(ProfileRef),
    steamLogin: Schema.NullOr(SteamLoginSeed),
    steamLoginTimeoutSeconds: Schema.Int,
  }),
  Schema.TaggedStruct("CancelInstall", { jobId: Schema.String }),
]);
export type AgentCommand = typeof AgentCommand.Type;

/**
 * Причина `InstallFailed`, когда у пользователя нет профиля и установщику
 * нужен вход в Steam (спека §4: раньше — «запустите любую уже установленную
 * игру», теперь — QR на `/login-steam`). Оркестратор показывает её владельцу
 * задачи как есть (а не общую «Не удалось установить игру»).
 */
export const steamLoginRequiredReason = "Войдите в Steam";

/**
 * Отчёт агента: стрим готов (`streamUrl` — внутренний адрес Selkies), состояние
 * процесса игры, heartbeat со списком живых сессий, прогресс/итог установки,
 * контейнер остановлен (`cloudSynced` — Steam Cloud успел синхронизироваться,
 * `profileSaved` — профиль выгружен и принят), сбой с причиной.
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
  Schema.TaggedStruct("InstallProgress", {
    jobId: Schema.String,
    bytesDownloaded: NonNegativeInt,
    bytesTotal: NonNegativeInt,
  }),
  Schema.TaggedStruct("InstallFinished", {
    jobId: Schema.String,
    sizeBytes: NonNegativeInt,
    buildId: Schema.String,
  }),
  Schema.TaggedStruct("InstallFailed", {
    jobId: Schema.String,
    reason: Schema.String,
  }),
  Schema.TaggedStruct("Stopped", {
    sessionId: Schema.String,
    cloudSynced: Schema.Boolean,
    profileSaved: Schema.Boolean,
  }),
  Schema.TaggedStruct("Failed", {
    sessionId: Schema.String,
    reason: Schema.String,
  }),
]);
export type AgentReport = typeof AgentReport.Type;

/** `agent.report`/`agent.profileCommit` пришёл по соединению без активного `agent.connect`. */
export class AgentNotConnected extends Schema.TaggedError<AgentNotConnected>()(
  "AgentNotConnected",
  {},
) {}

/**
 * Выгрузка новой версии профиля пользователя. `baseVersion` — версия, от
 * которой агент отталкивался (`null` — профиля ещё не было); принимается,
 * только если она совпадает с текущей версией в `profiles` (устаревшая
 * базовая версия отклоняется — спека §6). `steamLoginSeeded` — профиль
 * сохранён после посева `steamLogin` этой сессией/установкой (Task 2):
 * оркестратор привяжет `steamId` к аккаунту только для таких коммитов.
 */
export const ProfileCommit = Schema.Struct({
  userId: Schema.String,
  baseVersion: Schema.NullOr(Schema.Int),
  objectKey: Schema.String,
  sizeBytes: NonNegativeInt,
  steamLoginSeeded: Schema.Boolean,
});
export type ProfileCommit = typeof ProfileCommit.Type;

/**
 * `agent.connect` — поток команд воркеру; жизнь соединения агента = жизнь этого
 * потока (обрыв → воркер отключён; поток завершился сам — подключился более новый
 * агент с тем же `workerId`). `agent.report` и `agent.profileCommit` — по тому же
 * WebSocket, на котором открыт `agent.connect`.
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
  // Task 5: оркестратор проверяет baseVersion и upsert'ит `profiles`.
  Rpc.make("agent.profileCommit", {
    payload: ProfileCommit,
    success: Schema.Struct({ accepted: Schema.Boolean }),
    error: AgentNotConnected,
  }),
);
