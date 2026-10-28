// Протокол агента воркера ↔ оркестратор (группа `agent.*`). Обслуживается только
// оркестратором на `GET /agent` (Bearer AGENT_TOKEN); в `AppRpcs` не входит —
// браузерный API её никогда не обслуживает.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { InstallStage, SessionStage } from "./session";

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

/** Неотрицательное число байт (или мегабайт/секунд — везде, где считаем по данным хоста). */
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Железо воркера — снимается агентом один раз при подключении (`/proc/cpuinfo`,
 * `/proc/meminfo`, `nvidia-smi`, `/sys/block/*`, спека §«Как устроено сейчас»).
 * `disks` — физические диски и RAID-массивы (без `loop*`/`ram*`/`zram*`/`dm-*`);
 * `members` у RAID — имена дисков-членов (`md/slaves/`), у остальных — пусто.
 */
export const WorkerHardware = Schema.Struct({
  cpuModel: Schema.String,
  cpuCores: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cpuThreads: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  memoryBytes: NonNegativeNumber,
  gpus: Schema.Array(
    Schema.Struct({ name: Schema.String, memoryBytes: NonNegativeNumber }),
  ),
  disks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.Literals(["nvme", "ssd", "hdd", "raid"]),
      sizeBytes: NonNegativeNumber,
      raidLevel: Schema.NullOr(Schema.String),
      members: Schema.Array(Schema.String),
    }),
  ),
});
export type WorkerHardware = typeof WorkerHardware.Type;

/**
 * Версии и сборки воркера — снимаются агентом один раз при подключении.
 * `driver` — версия драйвера NVIDIA (`nvidia-smi`), `null` — GPU нет или
 * `nvidia-smi` недоступен; `steamClientBuiltAt` — mtime `STEAM_CLIENT_DIR`
 * (ISO), `null` — каталог не смонтирован или недоступен.
 */
export const WorkerVersions = Schema.Struct({
  agentCommit: Schema.String,
  sessionImage: Schema.String,
  driver: Schema.NullOr(Schema.String),
  steamClientBuiltAt: Schema.NullOr(Schema.String),
});
export type WorkerVersions = typeof WorkerVersions.Type;

/**
 * Приложение в общей библиотеке воркера с ролью `gamestore` — по одному на
 * `steamapps/appmanifest_<id>.acf` (игры и служебные пакеты: Proton, Steam
 * Linux Runtime). `sizeBytes` — `SizeOnDisk` манифеста (нет — 0).
 */
export const LibraryApp = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  sizeBytes: NonNegativeNumber,
});
export type LibraryApp = typeof LibraryApp.Type;

/**
 * Текущая загрузка воркера — отчёт `WorkerStats` раз в ~5 с (спека: оркестратор
 * хранит только последний снимок, без истории). GPU-поля и `filesystems`
 * пусты/`null`, если измерить не удалось (нет GPU, `nvidia-smi` упал,
 * `statfs` не прошёл) — карточка в админке покажет «нет данных», не упадёт.
 * `library` — содержимое общей библиотеки, только у агента с ролью
 * `gamestore` (вкладка «Игры» админки); у остальных поля нет.
 */
export const WorkerStats = Schema.Struct({
  cpuPercent: Schema.Number,
  memory: Schema.Struct({
    totalBytes: NonNegativeNumber,
    usedBytes: NonNegativeNumber,
    cacheBytes: NonNegativeNumber,
  }),
  gpus: Schema.Array(
    Schema.Struct({
      utilPercent: Schema.NullOr(Schema.Number),
      encoderPercent: Schema.NullOr(Schema.Number),
      temperatureC: Schema.NullOr(Schema.Number),
      memoryUsedBytes: Schema.NullOr(NonNegativeNumber),
      memoryTotalBytes: Schema.NullOr(NonNegativeNumber),
    }),
  ),
  filesystems: Schema.Array(
    Schema.Struct({
      purposes: Schema.Array(
        Schema.Literals(["scratch", "steamClient", "library"]),
      ),
      totalBytes: NonNegativeNumber,
      usedBytes: NonNegativeNumber,
      freeBytes: NonNegativeNumber,
    }),
  ),
  uptimeSeconds: NonNegativeNumber,
  library: Schema.optional(Schema.Array(LibraryApp)),
});
export type WorkerStats = typeof WorkerStats.Type;

/**
 * Подключение агента. `workerId` — имя воркера из конфига агента; слот `i`
 * на воркере — UDP-порт `udpPortBase + i`, публичный IP — `publicIp`.
 * `installs` — id задач установки, чьи контейнеры у агента ещё живы (роль
 * `gamestore`; снимок для переподключения, как `running` для сессий).
 * `hardware`/`versions` — снимок железа и версий воркера (админка, спека
 * 2026-10-28); необязательные — старый агент без этих полей совместим.
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
  hardware: Schema.optional(WorkerHardware),
  versions: Schema.optional(WorkerVersions),
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
 * Вход в Steam, который агент вписывает в дом контейнера перед запуском
 * сессии или установщика (спека §4): оркестратор получил его QR-входом на
 * сайте и прикладывает к следующей команде пользователя — клиент Steam
 * в контейнере входит этим аккаунтом сам. `accountName` и `refreshToken` никогда не должны
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
 * запустить или отменить установку игры в общую библиотеку, удалить игру из
 * неё (`DeleteGame`, итог — `GameDeleted`/`GameDeleteFailed`; всё — роль
 * `gamestore`).
 * `steamLogin` — ожидающий вход пользователя для посева (`SteamLoginSeeds`
 * оркестратора); `null` — его нет. `InstallGame.steamLoginTimeoutSeconds` —
 * сколько установщик ждёт входа клиента Steam (ответа на его попытку входа
 * в журнале подключения, отсчёт — с этой попытки, а не с первых строк
 * журнала: клиенту может потребоваться время, чтобы начать её) до
 * `InstallFailed` «Войдите в Steam» (из текущих `SessionSettings`).
 * `StartSession.display` — размер экрана стрима (белый список спеки
 * «меню сессии»: 1280×720/1920×1080/2560×1440), оркестратор берёт его из
 * настроек стрима пользователя (`displaySizeOf`/`allowedDisplaySize`); нет
 * поля (старый оркестратор) — агент использует 1920×1080. Разрешение идущей
 * сессии не меняется — поле читается только при старте контейнера.
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
    display: Schema.optional(
      Schema.Struct({ width: Schema.Int, height: Schema.Int }),
    ),
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
  Schema.TaggedStruct("DeleteGame", { appId: Schema.Int }),
]);
export type AgentCommand = typeof AgentCommand.Type;

/**
 * Причина `InstallFailed`, когда установщику нужен вход в Steam: профиля и
 * посеянного входа нет или Steam не вошёл за `steamLoginTimeoutSeconds` (спека
 * §4: раньше — «запустите любую уже установленную игру», теперь — вход по QR
 * на сайте: `/library`, профиль, экран сессии). Оркестратор показывает её
 * владельцу задачи как есть (а не общую «Не удалось установить игру»).
 */
export const steamLoginRequiredReason = "Войдите в Steam";

/**
 * Отчёт агента: стрим готов (`streamUrl` — внутренний адрес Selkies), состояние
 * процесса игры, heartbeat со списком живых сессий, этап запуска контейнера
 * сессии до появления игрового окна (`SessionStage`) или этап задачи установки
 * (`InstallStage`) — экран загрузки, прогресс/итог установки, контейнер
 * остановлен (`cloudSynced` — Steam Cloud успел синхронизироваться,
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
  Schema.TaggedStruct("SessionStage", {
    sessionId: Schema.String,
    stage: SessionStage,
  }),
  Schema.TaggedStruct("InstallStage", {
    jobId: Schema.String,
    stage: InstallStage,
  }),
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
  /**
   * Итог сессии. `cleanupPending: true` — контейнер ещё не убран (остановка
   * зависла, агент повторяет её в фоне): сессия ещё в heartbeat агента, слот
   * выпустит heartbeat без неё. Нет поля или `false` — контейнер уже убран
   * или остановлен.
   */
  Schema.TaggedStruct("Stopped", {
    sessionId: Schema.String,
    cloudSynced: Schema.Boolean,
    profileSaved: Schema.Boolean,
    cleanupPending: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct("Failed", {
    sessionId: Schema.String,
    reason: Schema.String,
    cleanupPending: Schema.optional(Schema.Boolean),
  }),
  /** Снимок текущей загрузки воркера, раз в ~5 с (админка, вкладка «Воркеры»). */
  Schema.TaggedStruct("WorkerStats", { stats: WorkerStats }),
  /** Итог `DeleteGame`: игры в библиотеке больше нет (или не было). */
  Schema.TaggedStruct("GameDeleted", { appId: Schema.Int }),
  Schema.TaggedStruct("GameDeleteFailed", {
    appId: Schema.Int,
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
 * сохранён после посева `steamLogin` этой сессией/установкой: принятый такой
 * коммит снимает ожидающий вход пользователя у оркестратора (профиль уже
 * хранит вход, сеять его снова незачем).
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
