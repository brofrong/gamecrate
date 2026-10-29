// SessionSupervisor: контейнеры сессий на воркере. По команде оркестратора
// готовит overlay-слои, создаёт контейнер, кладёт в него профиль пользователя и
// запускает, ждёт Selkies, следит за процессом игры; при остановке ждёт выгрузку
// облака Steam, сохраняет профиль и убирает контейнер со слоями (профиль не
// сохранён — контейнер со слоями остаётся). Зависшую остановку (процесс в
// D-состоянии) повторяет в фоне, пока контейнер не уберётся (после
// `CLEANUP_GIVE_UP` — реже и с `session-container-stuck`), итог сессии сообщает
// сразу (`cleanupPending`). Отчёты складывает в очередь `reports` (их по порядку
// отправляет OrchestratorLink). Пока игра идёт, снимает замеры её ресурсов
// (`SessionMetrics`, спека 2026-10-29 §4.1).
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentCommand,
  type AgentReport,
  allowedDisplaySize,
  containerGoneReason,
  type GameEnd,
  type ProfileRef,
  type RunningSession,
  SessionStage,
  type SteamLoginSeed,
} from "@cg/rpc";
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Result,
} from "effect";
import { randomBytes } from "node:crypto";
import { AgentConfig, type AgentConfigValues } from "./config";
import {
  type ContainerInfo,
  type ContainerSpec,
  type ContainerStats,
  DockerClient,
  type DockerError,
  isGone,
} from "./DockerClient";
import { parseGpuProcesses, parseNvidiaSmi } from "./hostProbe";
import { HELPER_LABEL } from "./Helper";
import { isValidId } from "./ids";
import {
  cleanup,
  holdVolumes,
  mountsFor,
  type Overlays,
  prepare,
  sessionLayers,
  unmarkVolatile,
} from "./Overlay";
import { FreeSpace, hasFreeSpace } from "./DiskSpace";
import { PrefixTemplates } from "./PrefixTemplate";
import { restoreProfile, saveProfile } from "./profile/HomeProfile";
import type { ProfileCommitter } from "./profile/ProfileCommitter";
import type { ProfileStore } from "./profile/ProfileStore";
import {
  EMPTY_SAMPLE,
  METRICS_REPORT,
  METRICS_SAMPLE,
  MetricsAccumulator,
  type MetricsSample,
  sessionVram,
} from "./SessionMetrics";
import {
  clearLaunchOptions,
  clearSteamLogin,
  seedSteamLogin,
  setLaunchOptions,
} from "./steam/seedContainer";
import { HostProbe } from "./WorkerMonitor";

/**
 * Файл, куда обёртка образа `cg-game-exit` пишет, чем кончился процесс игры
 * (спека 2026-10-29 §4.2).
 */
export const GAME_EXIT_FILE = "/tmp/cg-game-exit";

/** Журнал облака Steam в доме пользователя (контракт образа). */
export const CLOUD_LOG = "/home/ubuntu/.local/share/Steam/logs/cloud_log.txt";
/** Строка журнала облака: выгрузка сохранений завершилась. */
export const CLOUD_MARKER = "Upload complete, result OK";
/**
 * Строка entrypoint'а базового образа: композитор Wayland не видит GPU
 * (нет `nvidia-drm modeset=1`) — захват пойдёт программно, сессия бесполезна.
 */
export const GPU_FAILURE_LINE = "GPU: the compositor cannot reach it";
/** Порт веб-интерфейса Selkies в контейнере (наружу не публикуется). */
export const SELKIES_PORT = 8080;

export const READY_TIMEOUT = Duration.minutes(2);
export const READY_POLL = Duration.seconds(2);
export const GAME_POLL = Duration.seconds(5);
export const CLOUD_TIMEOUT = Duration.seconds(60);
export const CLOUD_POLL = Duration.seconds(2);
export const STAGE_POLL = Duration.seconds(2);
/**
 * Этап не меняется дольше этого — опрос реже (`STAGE_SLOW_POLL`): окно игры не
 * находится (лаунчер, нераспознанная игра), а скрипт на каждый вызов обходит процессы
 * и окна. Сайт к этому времени уже подсказывает «Показать экран».
 */
export const STAGE_SLOW_AFTER = Duration.minutes(3);
export const STAGE_SLOW_POLL = Duration.seconds(10);
/** Сколько ждать `cg-session-stage`: зависший X11 не должен останавливать опрос. */
export const STAGE_CHECK_TIMEOUT = Duration.seconds(10);
export const HEARTBEAT_INTERVAL = Duration.seconds(30);
export const STOP_TIMEOUT_SEC = 15;
/** Пауза между попытками убрать контейнер, чья остановка не удалась. */
export const CLEANUP_RETRY = Duration.seconds(30);
/**
 * Сколько повторять уборку каждые `CLEANUP_RETRY` (процессы в D-состоянии внутри
 * `sync()` висели 15–35 мин); дальше — `session-container-stuck` в лог (решает
 * человек), попытки реже — каждые `CLEANUP_STUCK_RETRY`, слот всё так же занят.
 */
export const CLEANUP_GIVE_UP = Duration.minutes(60);
/** Пауза между попытками уборки после `CLEANUP_GIVE_UP`. */
export const CLEANUP_STUCK_RETRY = Duration.minutes(5);
/**
 * Метка в `<SCRATCH_DIR>/<id>`: профиль сессии уже сохранён — контейнер можно
 * удалить со слоями (в том числе после перезапуска агента). Уходит вместе со scratch.
 */
export const PROFILE_SAVED_MARKER = "profile-saved";
export const SHM_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** Причины `Failed` (их видит пользователь). */
export const failReasons = {
  dockerStart: "Не удалось запустить игровой сервер",
  streamTimeout: "Стрим не запустился за 2 минуты",
  gpuCapture: "На сервере не работает захват экрана GPU",
  containerGone: containerGoneReason,
  invalidCommand: "Некорректная команда запуска сессии",
  profileRestore: "Не удалось загрузить профиль пользователя",
  profileTooLarge: "Профиль пользователя слишком большой (больше 200 МиБ)",
  noSpace: "На сервере закончилось место",
} as const;

/** Допустимый `sessionId`/`userId` (см. `ids.ts`). */
export { isValidId };

export const containerName = (sessionId: string) => `cg-session-${sessionId}`;
/** `<SCRATCH_DIR>/<id>/profile-saved` (см. `PROFILE_SAVED_MARKER`). */
export const profileSavedMarker = (
  config: AgentConfigValues,
  sessionId: string,
) => join(config.scratchDir, sessionId, PROFILE_SAVED_MARKER);
export const streamUrlFor = (sessionId: string) =>
  `http://${containerName(sessionId)}:${SELKIES_PORT}`;

type StartSession = Extract<AgentCommand, { _tag: "StartSession" }>;
/** Команды сессий; команды установки идут в Installer (см. OrchestratorLink). */
export type SessionCommand = Extract<
  AgentCommand,
  { _tag: "StartSession" | "StopSession" }
>;

/**
 * Метки контейнера сессии с пользователем и базовой версией профиля (пусто —
 * профиля не было): по ним подхваченная после перезапуска агента сессия
 * сохраняет профиль так же, как начатая этим агентом.
 */
export const USER_LABEL = "cg.user";
export const BASE_VERSION_LABEL = "cg.base-version";

const formatBaseVersion = (version: number | null) =>
  version === null ? "" : String(version);

/** Значение метки базовой версии; `undefined` — метки нет или она испорчена. */
const parseBaseVersion = (
  label: string | undefined,
): number | null | undefined => {
  if (label === undefined) return undefined;
  if (label === "") return null;
  return /^-?\d{1,15}$/.test(label) ? Number(label) : undefined;
};

/** Куда Debian-хосту пробрасывать `libnvidia-allocator` (GBM-бэкенд NVIDIA). */
const GBM_TARGETS = [
  "/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1",
  "/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so",
];

/**
 * Пароль пользователя `ubuntu` в контейнере (`PASSWD` базового образа, по умолчанию
 * общеизвестный `mypasswd`): случайный на каждый контейнер, нигде не логируется и
 * не сообщается. Entrypoint применяет его через `sudo-root chpasswd` — при
 * `no-new-privileges` это не удаётся (и не нужно: поднять права нечем).
 */
export const sessionPassword = () => randomBytes(24).toString("base64url");

/**
 * Графический контейнер со Steam (сессия, установщик; образ-киоск — композитор
 * labwc без рабочего стола): образ сессии, сеть сессий, GPU NVIDIA и GBM-бэкенд,
 * права и `/dev/input` — одинаково у всех.
 */
export const desktopSpec = (
  config: AgentConfigValues,
  fields: Pick<
    ContainerSpec,
    "name" | "env" | "labels" | "udpPorts" | "mounts"
  >,
): ContainerSpec => ({
  ...fields,
  image: config.sessionImage,
  network: config.sessionNetwork,
  binds: Option.match(config.gbmAllocatorPath, {
    onNone: () => [],
    onSome: (path) => GBM_TARGETS.map((target) => `${path}:${target}:ro`),
  }),
  runtime: "nvidia",
  gpus: true,
  shmSizeBytes: SHM_SIZE_BYTES,
  // В базовом образе у `ubuntu` `NOPASSWD: ALL` в sudoers, а /etc/shadow ему
  // принадлежит (su root): без этого флага любой процесс контейнера получает root.
  securityOpt: ["no-new-privileges:true"],
  // Интерпозеру геймпадов Selkies нужен каталог /dev/input (файлов в нём нет);
  // entrypoint создаёт его через sudo-root, что при no-new-privileges невозможно.
  tmpfs: { "/dev/input": "mode=1777,size=64k,nosuid,nodev,noexec" },
});

/**
 * Контейнер сессии для `StartSession`: дом — слой контейнера, клиент Steam и
 * библиотека — overlay-тома сессии (`sessionLayers`), профиль кладётся до старта.
 * Размер экрана — `command.display` против белого списка (`allowedDisplaySize`,
 * проверяется и здесь, и в оркестраторе); нет поля или размер не из списка —
 * 1920×1080. Разрешение идущей сессии не меняется — эти переменные читаются
 * entrypoint'ом только при старте контейнера.
 */
export const sessionSpec = (
  config: AgentConfigValues,
  command: StartSession,
  password: string,
): ContainerSpec => {
  const { width, height } = allowedDisplaySize(command.display);
  return desktopSpec(config, {
    name: containerName(command.sessionId),
    env: {
      CG_APP_ID: String(command.appId),
      SELKIES_WEBRTC_UDP_MUX_PORT: String(command.udpPort),
      SELKIES_WEBRTC_PUBLIC_IP: config.publicIp,
      PASSWD: password,
      SELKIES_MANUAL_WIDTH: String(width),
      SELKIES_MANUAL_HEIGHT: String(height),
      DISPLAY_SIZEW: String(width),
      DISPLAY_SIZEH: String(height),
    },
    labels: {
      "cg.session": command.sessionId,
      "cg.slot": String(command.slot),
      "cg.app": String(command.appId),
      [USER_LABEL]: command.userId,
      [BASE_VERSION_LABEL]: formatBaseVersion(command.profile?.version ?? null),
    },
    udpPorts: [command.udpPort],
    mounts: mountsFor(sessionLayers(config, command.sessionId)),
  });
};

/**
 * Шаблон процесса игры для `pgrep -f`/`pkill -f` (procps: расширенные регулярные
 * выражения по командной строке через пробел). Якорь `( |$)`: `AppId=10` не
 * совпадает с `AppId=105`.
 */
const gamePattern = (appId: number) => `AppId=${appId}( |$)`;

/** Команды внутри контейнера (`docker exec`, без shell). */
export const commands = {
  /** Selkies отвечает: в образе есть curl; HTTP из агента в `cg-sessions` не ходит. */
  probe: [
    "curl",
    "-fsS",
    "-o",
    "/dev/null",
    "--max-time",
    "5",
    `http://localhost:${SELKIES_PORT}/api/status`,
  ],
  /** Напрямую, не через `sh -c`: иначе pgrep найдёт сам shell. */
  game: (appId: number) => ["pgrep", "-f", gamePattern(appId)],
  closeGame: (appId: number) => ["pkill", "-TERM", "-f", gamePattern(appId)],
  cloud: ["grep", "-cF", CLOUD_MARKER, CLOUD_LOG],
  /** Чем кончился процесс игры (`cg-game-exit`, файла нет — код ≠ 0). */
  gameExit: ["cat", GAME_EXIT_FILE],
  /** Текущий этап запуска игры (`steam`…`visible`, контракт образа). */
  stage: (appId: number) => ["/usr/local/bin/cg-session-stage", String(appId)],
} as const;

/**
 * Строка `cg-game-exit` → чем закончилась игра: `code 0` — `quit`, `code n`
 * — `error`, но `code 128+n` (так bash отдаёт смерть от сигнала n) и
 * `signal n` — `crash`; иначе `unknown`.
 */
export const parseGameExit = (
  text: string,
): Extract<GameEnd, "quit" | "crash" | "error" | "unknown"> => {
  const match = /^(code|signal) (\d+)$/.exec(text.trim());
  if (match === null) return "unknown";
  const n = Number(match[2]);
  if (match[1] === "signal") return "crash";
  return n === 0 ? "quit" : n > 128 ? "crash" : "error";
};

/** Порядок этапов: отчёт только о более позднем, чем уже отправленный. */
const stageRank = (stage: SessionStage | undefined) =>
  stage === undefined ? -1 : SessionStage.literals.indexOf(stage);

/** Этапы, которые печатает `cg-session-stage` (`computer` — до старта контейнера). */
const isScriptStage = (stage: string): stage is SessionStage =>
  stage !== "computer" &&
  (SessionStage.literals as ReadonlyArray<string>).includes(stage);

type Phase = "starting" | "ready" | "stopping";

/**
 * Как убрать контейнер в конце сессии: `remove` — удалить (`rm -f`) вместе со
 * слоями (профиль сохранён или контейнер не нужен), `stop` — только остановить,
 * контейнер и слои остаются (`profile-unsaved`).
 */
type CleanupMode = "remove" | "stop";

/** Итог сессии для оркестратора. */
type Outcome = Extract<AgentReport, { _tag: "Stopped" | "Failed" }>;

/**
 * Замеры игры сессии (`SessionMetrics`): накопленное и момент, до которого
 * время игры уже учтено.
 */
interface GameMetrics {
  readonly acc: MetricsAccumulator;
  lastAt: number;
}

/** Число маркеров облака; `unknown` — подсчёт не удался (exec упал, grep вернул ошибку). */
type CloudCount = number | "unknown";

interface Session {
  readonly sessionId: string;
  readonly userId: string;
  /** Версия профиля, из которой собран дом (`null` — профиля не было). */
  readonly baseVersion: number | null;
  readonly appId: number;
  readonly slot: number;
  readonly name: string;
  readonly overlays: Overlays;
  readonly streamUrl: string;
  /**
   * Контейнер создан этой сессией (или подхвачен). Нет — `create` не удался,
   * возможно из-за чужого или остановленного контейнера с тем же именем: его не трогаем.
   */
  created: boolean;
  phase: Phase;
  /** Вход §4 вписан этим агентом перед стартом (для `ProfileCommit.steamLoginSeeded`). */
  seeded: boolean;
  /**
   * Момент сброса входа Steam, эхом которого агент стёр вход перед стартом
   * (для `ProfileCommit.steamLoginResetAt`); `undefined` — стирания в этом
   * запуске не было.
   */
  loginResetAt: string | undefined;
  gameRunning: boolean;
  /** Последний отправленный этап запуска (`undefined` — ещё ни одного). */
  stage: SessionStage | undefined;
  /**
   * Число маркеров облака при последнем опросе, где игра ещё шла, или перед
   * SIGTERM при остановке (игра не запускалась — нет). Выгрузки во время игры
   * (в т.ч. при её запуске) так не принимаются за итоговую.
   */
  cloudBaseline: CloudCount | undefined;
  /**
   * Замеры ресурсов с начала игры (`watchGame`); `undefined` — игра не
   * запускалась при этом агенте (подхваченная с уже идущей игрой сессия не
   * замеряется: её прежние замеры уже у оркестратора) или итог уже отправлен.
   */
  metrics: GameMetrics | undefined;
  /** Пришёл `StopSession`. */
  readonly stopRequested: Deferred.Deferred<void>;
}

/** Контейнер, в котором выполняются проверки. */
type Target = Pick<Session, "name" | "appId">;

/**
 * Сессию нельзя продолжать: убрать контейнер со слоями и сообщить `Failed`
 * (после готовности стрима — только остановить, см. `fail`).
 */
class Abort extends Data.TaggedError("Abort")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** Проверка в контейнере не дала ответа (неожиданный код выхода). */
class CheckFailed extends Data.TaggedError("CheckFailed")<{
  readonly message: string;
}> {}

export interface SessionSupervisorShape {
  /** Команда оркестратора; возвращается сразу, работа идёт в фоне. */
  readonly handle: (command: SessionCommand) => Effect.Effect<void>;
  /** Живые сессии для `agent.connect.running` (с момента приёма StartSession). */
  readonly snapshot: Effect.Effect<ReadonlyArray<RunningSession>>;
  /** Отчёты оркестратору в порядке возникновения. */
  readonly reports: Queue.Queue<AgentReport>;
}

const make = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const docker = yield* DockerClient;
  const probe = yield* HostProbe;
  const freeSpace = yield* FreeSpace;
  const templates = yield* PrefixTemplates;
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<
    AgentConfig | DockerClient | ProfileStore | ProfileCommitter
  >();
  /** Профиль и слои — функции на сервисах агента (их же использует установщик). */
  const withServices = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      AgentConfig | DockerClient | ProfileStore | ProfileCommitter
    >,
  ) => Effect.provideContext(effect, services);
  const sessions = new Map<string, Session>();
  const reports = yield* Queue.unbounded<AgentReport>();
  const emit = (report: AgentReport) =>
    Queue.offer(reports, report).pipe(Effect.asVoid);

  const exec = (target: Target, cmd: ReadonlyArray<string>) =>
    docker.exec(target.name, cmd);

  /** Exec, для которого «контейнера нет» — конец сессии. */
  const execAlive = (target: Target, cmd: ReadonlyArray<string>) =>
    exec(target, cmd).pipe(
      Effect.catchIf(isGone, (cause) =>
        Effect.fail(new Abort({ reason: failReasons.containerGone, cause })),
      ),
    );

  /** grep -c: 0 — есть совпадения, 1 — нет (stdout «0»); другое — ошибка (нет файла и т.п.). */
  const cloudCount = (target: Target): Effect.Effect<CloudCount> =>
    exec(target, commands.cloud).pipe(
      Effect.map(({ exitCode, stdout }): CloudCount => {
        const count = Number(stdout.trim());
        return (exitCode === 0 || exitCode === 1) &&
          stdout.trim() !== "" &&
          Number.isInteger(count) &&
          count >= 0
          ? count
          : "unknown";
      }),
      Effect.orElseSucceed((): CloudCount => "unknown"),
    );

  /** pgrep: 0 — игра идёт, 1 — нет; любой другой код — проверка не удалась. */
  const gameAlive = (target: Target) =>
    execAlive(target, commands.game(target.appId)).pipe(
      Effect.flatMap(({ exitCode }) =>
        exitCode === 0
          ? Effect.succeed(true)
          : exitCode === 1
            ? Effect.succeed(false)
            : Effect.fail(
                new CheckFailed({ message: `pgrep exited with ${exitCode}` }),
              ),
      ),
    );

  /** Ждёт ответа Selkies; строка про GPU в логе или таймаут — `Abort`. */
  const waitReady = (session: Session) =>
    Effect.gen(function* () {
      while (true) {
        const ready = yield* execAlive(session, commands.probe).pipe(
          Effect.map(({ exitCode }) => exitCode === 0),
          Effect.catchTag("DockerError", (error) =>
            Effect.logWarning("Selkies probe failed", {
              sessionId: session.sessionId,
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        // Строка entrypoint'а печатается до старта Selkies — к моменту ответа
        // она уже в логе.
        const logs = yield* docker
          .logs(session.name)
          .pipe(Effect.orElseSucceed(() => ""));
        if (logs.includes(GPU_FAILURE_LINE))
          return yield* new Abort({ reason: failReasons.gpuCapture });
        if (ready) return;
        yield* Effect.sleep(READY_POLL);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: READY_TIMEOUT,
        orElse: () =>
          Effect.fail(new Abort({ reason: failReasons.streamTimeout })),
      }),
    );

  /** Занятая память и загрузка первой GPU по `nvidia-smi`; не ответил — `null`. */
  const gpuNow = probe.nvidiaSmi.pipe(
    Effect.map((csv) => {
      const gpu = csv === undefined ? undefined : parseNvidiaSmi(csv)[0];
      return {
        usedBytes: gpu?.memoryUsedBytes ?? null,
        util: gpu?.utilPercent ?? null,
      };
    }),
  );

  /** Снимок `docker stats`; сбой — `undefined` и причина в `failed`. */
  const statsOf = (session: Session, failed: Array<string>) =>
    docker.stats(session.name).pipe(
      Effect.map((stats): ContainerStats | undefined => stats),
      Effect.catchTag("DockerError", (error) =>
        Effect.sync(() => {
          failed.push(`stats: ${error.message}`);
          return undefined;
        }),
      ),
    );

  /**
   * Один замер контейнера сессии. Сбой любого источника — `null` в его полях
   * и одно предупреждение на замер; сессию это не трогает. CPU в ядрах —
   * разность с прошлым снимком `cpu.prev` (`Δcpu / Δsystem × ядер`).
   */
  const takeSample = (
    session: Session,
    baselineBytes: number | null,
    cpu: { prev: ContainerStats | undefined },
  ) =>
    Effect.gen(function* () {
      const failed: Array<string> = [];
      const stats = yield* statsOf(session, failed);
      const pids = yield* docker.top(session.name).pipe(
        Effect.map((pids): ReadonlyArray<number> | undefined => pids),
        Effect.catchTag("DockerError", (error) =>
          Effect.sync(() => {
            failed.push(`top: ${error.message}`);
            return undefined;
          }),
        ),
      );
      const xml = yield* probe.nvidiaSmiProcesses;
      if (xml === undefined) failed.push("nvidia-smi processes");
      const gpu = yield* gpuNow;
      if (gpu.usedBytes === null && gpu.util === null) failed.push("nvidia-smi");
      let cpuCores: number | null = null;
      if (stats !== undefined && cpu.prev !== undefined) {
        const system = stats.systemNanos - cpu.prev.systemNanos;
        const used = stats.cpuNanos - cpu.prev.cpuNanos;
        if (system > 0 && used >= 0)
          cpuCores = (used / system) * stats.onlineCpus;
      }
      if (stats !== undefined) cpu.prev = stats;
      const vram = sessionVram({
        processes: xml === undefined ? undefined : parseGpuProcesses(xml),
        pids,
        gpuUsedBytes: gpu.usedBytes,
        baselineBytes,
      });
      if (failed.length > 0)
        yield* Effect.logWarning("Session metrics sample failed", {
          sessionId: session.sessionId,
          failed,
        });
      return {
        vramBytes: vram.bytes,
        vramSource: vram.source,
        ramBytes: stats?.memoryBytes ?? null,
        cpuCores,
        gpuUtil: gpu.util,
      } satisfies MetricsSample;
    });

  const emitMetrics = (session: Session, metrics: GameMetrics) =>
    emit({
      _tag: "SessionMetrics",
      sessionId: session.sessionId,
      ...metrics.acc.snapshot(),
    });

  /**
   * Итоговый `SessionMetrics` (игра закрылась или остановка): хвост игры после
   * последнего замера идёт во время, замеры сессии на этом кончаются.
   */
  const finalMetrics = (session: Session) =>
    Effect.gen(function* () {
      const metrics = session.metrics;
      if (metrics === undefined) return;
      session.metrics = undefined;
      const now = yield* Clock.currentTimeMillis;
      metrics.acc.add(EMPTY_SAMPLE, (now - metrics.lastAt) / 1000);
      metrics.lastAt = now;
      yield* emitMetrics(session, metrics);
    });

  /**
   * Замеры, пока игра идёт: база `gpu_total` (занятая на карте память) — на
   * старте игры, затем замер по сетке METRICS_SAMPLE от старта игры (время
   * самого замера — docker и два nvidia-smi — не сдвигает сетку; замер дольше
   * периода — следующий сразу) и отчёт, как только с прошлого прошло
   * METRICS_REPORT (по часам, а не по числу замеров). Прерывается вместе с
   * `watchGame` (scope `lifecycle`).
   */
  const sampleGame = (session: Session, metrics: GameMetrics) =>
    Effect.gen(function* () {
      const samplePeriod = Duration.toMillis(METRICS_SAMPLE);
      const reportPeriod = Duration.toMillis(METRICS_REPORT);
      const startedAt = metrics.lastAt;
      let nextSampleAt = startedAt + samplePeriod;
      let nextReportAt = startedAt + reportPeriod;
      const baseline = (yield* gpuNow).usedBytes;
      const cpu = { prev: yield* statsOf(session, []) };
      while (true) {
        const wait = nextSampleAt - (yield* Clock.currentTimeMillis);
        if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
        const sample = yield* takeSample(session, baseline, cpu);
        // Итог уже отправлен (игра закрылась) — дальше не считаем.
        if (session.metrics !== metrics) return;
        const now = yield* Clock.currentTimeMillis;
        metrics.acc.add(sample, (now - metrics.lastAt) / 1000);
        metrics.lastAt = now;
        nextSampleAt = Math.max(nextSampleAt + samplePeriod, now);
        if (now >= nextReportAt) {
          yield* emitMetrics(session, metrics);
          nextReportAt += reportPeriod;
          if (nextReportAt <= now) nextReportAt = now + reportPeriod;
        }
      }
    });

  /** Чем закончилась игра: файл `cg-game-exit`; нет или не прочитался — `unknown`. */
  const gameEnd = (session: Session) =>
    exec(session, commands.gameExit).pipe(
      Effect.map(({ exitCode, stdout }) =>
        exitCode === 0 ? parseGameExit(stdout) : "unknown",
      ),
      Effect.orElseSucceed(() => "unknown" as const),
    );

  /**
   * Следит за процессом игры, пока он не завершится (после запуска). С
   * запуском игры начинаются замеры её ресурсов (`sampleGame`), итог замеров
   * уходит перед `GameState` о выходе.
   */
  const watchGame = (session: Session) =>
    Effect.gen(function* () {
      while (true) {
        const alive = yield* gameAlive(session).pipe(
          Effect.catchTag(["DockerError", "CheckFailed"], (error) =>
            Effect.logWarning("Game check failed", {
              sessionId: session.sessionId,
              error: error.message,
            }).pipe(Effect.as(session.gameRunning)),
          ),
        );
        if (alive !== session.gameRunning) {
          // Игра закрылась сама: обёртка уже записала код (её процесс — потомок
          // `reaper`, по которому pgrep видит игру).
          const end = alive ? undefined : yield* gameEnd(session);
          const now = yield* Clock.currentTimeMillis;
          // Состояние и отчёт — без точки прерывания между ними: StopSession в этот
          // момент видит уже запущенную игру (и закроет её, и подождёт облако).
          // Игра запущена — этап не раньше `prepare`, даже если скрипт этапов
          // молчит (старый образ): иначе сайт показывал бы «Запускаем Steam» поверх игры.
          // Итог замеров — до `GameState` о выходе (строка замеров уже есть,
          // когда оркестратор узнаёт о конце игры).
          yield* Effect.uninterruptible(
            Effect.suspend(() => {
              session.gameRunning = alive;
              if (alive)
                session.metrics = {
                  acc: new MetricsAccumulator(),
                  lastAt: now,
                };
              return Effect.andThen(
                alive ? reportStage(session, "prepare") : finalMetrics(session),
                emit({
                  _tag: "GameState",
                  sessionId: session.sessionId,
                  running: alive,
                  ...(end !== undefined ? { end } : {}),
                }),
              );
            }),
          );
          if (session.metrics !== undefined)
            yield* Effect.forkScoped(sampleGame(session, session.metrics));
          yield* Effect.logInfo(alive ? "Game started" : "Game exited", {
            sessionId: session.sessionId,
          });
          if (!alive) return;
        }
        // Игра идёт: база облака — на этот опрос. Прервано остановкой — базу снимет
        // finish прямо перед SIGTERM.
        if (alive) session.cloudBaseline = yield* cloudCount(session);
        yield* Effect.sleep(GAME_POLL);
      }
    });

  /** Отчёт об этапе, если он дальше отправленного (этапы только вперёд). */
  const reportStage = (session: Session, stage: SessionStage) =>
    Effect.suspend(() => {
      if (stageRank(stage) <= stageRank(session.stage)) return Effect.void;
      session.stage = stage;
      return emit({
        _tag: "SessionStage",
        sessionId: session.sessionId,
        stage,
      });
    });

  /**
   * Опрос этапа запуска до `visible`; этап долго не меняется — реже. Сбой
   * проверки (таймаут, код выхода, непонятный ответ) — предупреждение, опрос
   * продолжается. Скрипта нет или он не исполняемый (код 126/127, старый
   * образ) — одно предупреждение, и опрос
   * заканчивается: этап `prepare` тогда сообщит `watchGame`. Контейнера нет —
   * опрос молча заканчивается: сбой сессии решают проверки Selkies и игры.
   */
  const watchStage = (session: Session) =>
    Effect.gen(function* () {
      let seen = session.stage;
      let seenAt = yield* Clock.currentTimeMillis;
      while (true) {
        const stage = yield* docker
          .exec(session.name, commands.stage(session.appId), {
            timeout: STAGE_CHECK_TIMEOUT,
          })
          .pipe(
            Effect.flatMap(({ exitCode, stdout }) => {
              const stage = stdout.trim();
              if (exitCode === 126 || exitCode === 127)
                return Effect.succeed("missing" as const);
              return exitCode === 0 && isScriptStage(stage)
                ? Effect.succeed(stage)
                : Effect.fail(
                    new CheckFailed({
                      message: `cg-session-stage exited with ${exitCode}: ${JSON.stringify(stage.slice(0, 40))}`,
                    }),
                  );
            }),
            Effect.catchTag(["DockerError", "CheckFailed"], (error) =>
              error._tag === "DockerError" && isGone(error)
                ? Effect.succeed("gone" as const)
                : Effect.logWarning("Stage check failed", {
                    sessionId: session.sessionId,
                    error: error.message,
                  }).pipe(Effect.as(undefined)),
            ),
          );
        if (stage === "gone") return;
        if (stage === "missing")
          return yield* Effect.logWarning(
            "Stage script is missing, stage polling stopped",
            { sessionId: session.sessionId },
          );
        if (stage !== undefined) yield* reportStage(session, stage);
        if (session.stage === "visible") return;
        const now = yield* Clock.currentTimeMillis;
        if (session.stage !== seen) {
          seen = session.stage;
          seenAt = now;
        }
        yield* Effect.sleep(
          now - seenAt >= Duration.toMillis(STAGE_SLOW_AFTER)
            ? STAGE_SLOW_POLL
            : STAGE_POLL,
        );
      }
    });

  /**
   * Маркер облака вырос относительно базы (ждём до CLOUD_TIMEOUT). База неизвестна —
   * сравнивать не с чем: ждём всё время (Steam успеет выгрузить) и сообщаем `false`.
   */
  const waitCloud = (session: Session, baseline: CloudCount) =>
    Effect.gen(function* () {
      if (baseline === "unknown") return yield* Effect.never;
      while (true) {
        const count = yield* cloudCount(session);
        if (count !== "unknown" && count > baseline) return true;
        yield* Effect.sleep(CLOUD_POLL);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: CLOUD_TIMEOUT,
        orElse: () => Effect.succeed(false),
      }),
    );

  /** Бежит до конца `effect` или до `StopSession`, что раньше. */
  const untilStop = <A, E, R>(
    session: Session,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.raceFirst(
      effect.pipe(Effect.map((value) => ({ stopped: false as const, value }))),
      Deferred.await(session.stopRequested).pipe(
        Effect.as({ stopped: true as const }),
      ),
    );

  /** Убрать слои; не вышло — только лог (при старте агента уберутся как осиротевшие). */
  const cleanupLogged = (overlays: Overlays) =>
    cleanup(overlays).pipe(
      withServices,
      Effect.catchTag("OverlayError", (error) =>
        Effect.logWarning("Removing session layers failed", {
          id: overlays.id,
          operation: error.operation,
          error: error.message,
        }),
      ),
    );

  /**
   * Контейнер остановлен и остаётся вместе со слоями: снять с них метку
   * `volatile`, чтобы `docker start` смонтировал их снова. Не вышло — только лог
   * (при старте агент повторит для всех остановленных сессий).
   */
  const keepStopped = (sessionId: string, overlays: Overlays) =>
    unmarkVolatile(overlays).pipe(
      withServices,
      Effect.catchTag("OverlayError", (error) =>
        Effect.logWarning("Unmarking kept session layers failed", {
          sessionId,
          operation: error.operation,
          error: error.message,
        }),
      ),
    );

  /**
   * Одна попытка убрать контейнер (`CleanupMode`); `false` — не вышло (лог).
   * `remove`: `rm -f` (kill + remove) → тома и scratch; `stop`: штатный `stop`
   * → снять `volatile` со слоёв (сбой этого — только лог, см. `keepStopped`).
   */
  const cleanupOnce = (session: Session, mode: CleanupMode) =>
    (mode === "remove"
      ? docker
          .remove(session.name)
          .pipe(Effect.andThen(cleanup(session.overlays).pipe(withServices)))
      : docker
          .stop(session.name, STOP_TIMEOUT_SEC)
          .pipe(
            Effect.andThen(keepStopped(session.sessionId, session.overlays)),
          )
    ).pipe(
      Effect.as(true),
      Effect.catchTag(["DockerError", "OverlayError"], (error) =>
        Effect.logWarning("Session container cleanup failed, retrying", {
          sessionId: session.sessionId,
          container: session.name,
          mode,
          error: error.message,
        }).pipe(Effect.as(false)),
      ),
    );

  /**
   * Конец сессии: убрать контейнер (`mode`) и сообщить итог `report`. Первая
   * попытка удалась — сессия уходит из `sessions`, затем `report`. Нет —
   * `report` сразу с `cleanupPending: true` (игрок видит конец сессии), а
   * попытки повторяются каждые `CLEANUP_RETRY`, после `CLEANUP_GIVE_UP` — лог
   * `session-container-stuck` (один раз) и попытки каждые `CLEANUP_STUCK_RETRY`,
   * пока контейнер не уберётся: всё это время сессия в `sessions` — её называет
   * heartbeat, и оркестратор держит слот (порт и GPU ещё у контейнера).
   * Убрали — сессия уходит из `sessions`, ближайший heartbeat без неё выпускает
   * слот. Proton создавал префикс игры (`compatdata/<appId>` в upper слоя apps)
   * и контейнер удалён после `Stopped` — в фоне проверяется шаблон префикса этой
   * игры (`PrefixTemplates.ensure`: нет или устарел — собрать).
   */
  const settle = (session: Session, mode: CleanupMode, report: Outcome) =>
    Effect.gen(function* () {
      const protonUsed =
        mode === "remove" &&
        report._tag === "Stopped" &&
        existsSync(
          join(
            session.overlays.apps.upper,
            "compatdata",
            String(session.appId),
          ),
        );
      const startedAt = yield* Clock.currentTimeMillis;
      let done = yield* cleanupOnce(session, mode);
      if (done) {
        sessions.delete(session.sessionId);
        yield* emit(report);
      } else {
        yield* emit({ ...report, cleanupPending: true });
        let stuck = false;
        while (!done) {
          yield* Effect.sleep(stuck ? CLEANUP_STUCK_RETRY : CLEANUP_RETRY);
          done = yield* cleanupOnce(session, mode);
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          if (
            !done &&
            !stuck &&
            elapsed >= Duration.toMillis(CLEANUP_GIVE_UP)
          ) {
            yield* Effect.logError("session-container-stuck", {
              sessionId: session.sessionId,
              container: session.name,
              mode,
            });
            stuck = true;
          }
        }
        sessions.delete(session.sessionId);
      }
      if (done && protonUsed)
        yield* Effect.forkIn(templates.ensure(session.appId), scope);
    });

  /** Метка `profile-saved`; не записалась — только предупреждение. */
  const markProfileSaved = (sessionId: string) =>
    Effect.try(() =>
      writeFileSync(profileSavedMarker(config, sessionId), ""),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Writing the profile-saved marker failed", {
          sessionId,
          error: String(error),
        }),
      ),
    );

  /**
   * Остановка: облако (если игра шла) → профиль → метка `profile-saved` →
   * штатный stop (его сбой — только лог) → `settle` в режиме `remove` (контейнер
   * и слои) → `Stopped`. Профиль не сохранён (в том числе коммит отклонён: база
   * устарела) — `settle` в режиме `stop`: контейнер только останавливается и
   * вместе со слоями остаётся (`profile-unsaved` в логе), следующая сессия
   * получит предыдущую версию профиля. Зависшую остановку повторяет `settle`.
   */
  const finish = (session: Session) =>
    Effect.gen(function* () {
      session.phase = "stopping";
      let cloudSynced = false;
      if (session.gameRunning) {
        // Остановка посреди игры — итог замеров (игра закрылась сама — его уже
        // отправил watchGame).
        yield* finalMetrics(session);
        // StopSession посреди игры: база — прямо перед SIGTERM (всё выгруженное
        // во время игры уже в ней), затем закрыть игру штатно, тогда Steam выгрузит
        // сохранения («AC Exit»).
        session.cloudBaseline = yield* cloudCount(session);
        yield* exec(session, commands.closeGame(session.appId)).pipe(
          Effect.catchTag("DockerError", (error) =>
            Effect.logWarning("Closing the game failed", {
              sessionId: session.sessionId,
              error: error.message,
            }),
          ),
        );
      }
      if (session.cloudBaseline !== undefined)
        cloudSynced = yield* waitCloud(session, session.cloudBaseline);
      const saved = yield* saveProfile({
        container: session.name,
        userId: session.userId,
        baseVersion: session.baseVersion,
        steamLoginSeeded: session.seeded,
        // Steam уже закрыт: обёртка игры не должна попасть в профиль.
        beforePack: clearLaunchOptions({
          container: session.name,
          appId: session.appId,
        }).pipe(
          Effect.catchTag("SeedError", (error) =>
            Effect.logWarning("Restoring the game launch options failed", {
              sessionId: session.sessionId,
              error: error.message,
            }),
          ),
        ),
        ...(session.loginResetAt !== undefined
          ? { steamLoginResetAt: session.loginResetAt }
          : {}),
      }).pipe(withServices, Effect.result);
      const profileSaved = Result.isSuccess(saved);
      const stopped: Outcome = {
        _tag: "Stopped",
        sessionId: session.sessionId,
        cloudSynced,
        profileSaved,
      };
      // До `settle`: с повторами уборки он может идти долго (зависший контейнер).
      yield* Effect.logInfo("Session stopped", {
        sessionId: session.sessionId,
        cloudSynced,
        profileSaved,
      });
      if (Result.isFailure(saved)) {
        yield* Effect.logError("profile-unsaved", {
          sessionId: session.sessionId,
          userId: session.userId,
          container: session.name,
          stage: saved.failure.stage,
          error: saved.failure.message,
        });
        yield* settle(session, "stop", stopped);
      } else {
        yield* markProfileSaved(session.sessionId);
        yield* docker.stop(session.name, STOP_TIMEOUT_SEC).pipe(
          Effect.catchTag("DockerError", (error) =>
            Effect.logWarning("Stopping session container failed", {
              sessionId: session.sessionId,
              error: error.message,
            }),
          ),
        );
        yield* settle(session, "remove", stopped);
      }
    });

  /**
   * Сбой: контейнер и слои убрать (слот и UDP-порт свободны), затем `Failed`.
   * После готовности стрима пользователь мог играть: такой контейнер только
   * останавливается и остаётся вместе со слоями. Зависшую уборку повторяет `settle`.
   */
  const fail = (session: Session, abort: Abort) =>
    Effect.gen(function* () {
      // После готовности стрима в upper-слоях могут быть несохранённые данные игры.
      const keep = session.phase !== "starting";
      yield* Effect.logError("Session failed", {
        sessionId: session.sessionId,
        reason: abort.reason,
        cause: abort.cause,
      });
      const failed: Outcome = {
        _tag: "Failed",
        sessionId: session.sessionId,
        reason: abort.reason,
      };
      if (keep) {
        yield* Effect.logError("profile-unsaved", {
          sessionId: session.sessionId,
          userId: session.userId,
          container: session.name,
        });
        return yield* settle(session, "stop", failed);
      }
      if (session.created) return yield* settle(session, "remove", failed);
      // Слои убираем, только если контейнера с этим именем нет вовсе: иначе
      // они его (например, остановленного с несохранённым профилем).
      const existing = yield* docker
        .inspect(session.name)
        .pipe(Effect.orElseSucceed(() => "unknown" as const));
      if (existing === undefined) yield* cleanupLogged(session.overlays);
      else
        yield* Effect.logWarning(
          "Leaving a container this session did not create",
          { sessionId: session.sessionId, name: session.name },
        );
      sessions.delete(session.sessionId);
      yield* emit(failed);
    });

  /** Новый контейнер: слои → create → профиль → стирание входа → посев → start. */
  const launch = (
    session: Session,
    spec: ContainerSpec,
    profile: ProfileRef | null,
    steamLogin: SteamLoginSeed | null,
    steamLoginResetAt: string | undefined,
  ) =>
    Effect.gen(function* () {
      const dockerStart = (cause: unknown) =>
        new Abort({ reason: failReasons.dockerStart, cause });
      yield* reportStage(session, "computer");
      yield* prepare(session.overlays).pipe(
        withServices,
        Effect.mapError(dockerStart),
      );
      yield* docker.create(spec).pipe(Effect.mapError(dockerStart));
      session.created = true;
      // Профиль, посев входа и старт — по одному монтированию volatile-слоёв.
      const from = yield* Effect.scoped(
        Effect.gen(function* () {
          // withServices заменил бы весь контекст вместе со Scope.
          yield* holdVolumes(session.overlays).pipe(
            Effect.provideService(AgentConfig, config),
            Effect.provideService(DockerClient, docker),
            Effect.mapError(dockerStart),
          );
          const from = yield* restoreProfile({
            container: session.name,
            userId: session.userId,
            profile,
          }).pipe(
            withServices,
            Effect.mapError(
              (cause) =>
                new Abort({
                  reason:
                    cause.stage === "size"
                      ? failReasons.profileTooLarge
                      : failReasons.profileRestore,
                  cause,
                }),
            ),
          );
          if (steamLoginResetAt !== undefined) {
            yield* clearSteamLogin({ container: session.name }).pipe(
              withServices,
              Effect.mapError(
                (cause) =>
                  new Abort({ reason: failReasons.profileRestore, cause }),
              ),
            );
            session.loginResetAt = steamLoginResetAt;
          }
          if (steamLogin !== null) {
            yield* seedSteamLogin({
              container: session.name,
              seed: steamLogin,
            }).pipe(
              withServices,
              Effect.mapError(
                (cause) =>
                  new Abort({ reason: failReasons.profileRestore, cause }),
              ),
            );
            session.seeded = true;
          }
          // Обёртка `cg-game-exit` в параметрах запуска игры (§4.2); не вышло —
          // игра идёт без неё, её конец будет `unknown`.
          yield* setLaunchOptions({
            container: session.name,
            appId: session.appId,
          }).pipe(
            withServices,
            Effect.catchTag("SeedError", (error) =>
              Effect.logWarning("Setting the game launch options failed", {
                sessionId: session.sessionId,
                error: error.message,
              }),
            ),
          );
          yield* docker.start(session.name).pipe(Effect.mapError(dockerStart));
          yield* reportStage(session, "steam");
          return from;
        }),
      );
      yield* Effect.logInfo("Session container started", {
        sessionId: session.sessionId,
        slot: session.slot,
        profile: from,
        steamLoginSeeded: session.seeded,
        steamLoginCleared: session.loginResetAt !== undefined,
      });
    });

  /** Жизнь сессии: [создание] → готовность Selkies → игра → остановка. */
  const lifecycle = (
    session: Session,
    launchWith:
      | {
          readonly spec: ContainerSpec;
          readonly profile: ProfileRef | null;
          readonly steamLogin: SteamLoginSeed | null;
          readonly steamLoginResetAt: string | undefined;
        }
      | undefined,
  ) =>
    Effect.gen(function* () {
      if (launchWith !== undefined)
        yield* launch(
          session,
          launchWith.spec,
          launchWith.profile,
          launchWith.steamLogin,
          launchWith.steamLoginResetAt,
        );
      // Опрос этапов идёт параллельно готовности и игре; scope закрывается
      // (fiber прерван) до finish/fail — после Stopped/Failed этапов нет.
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Остановка уже запрошена (подхвачен по StopSession) — без StreamReady.
          if (yield* Deferred.isDone(session.stopRequested)) return;
          yield* Effect.forkScoped(watchStage(session));
          const ready = yield* untilStop(session, waitReady(session));
          if (ready.stopped) return;
          session.phase = "ready";
          yield* emit({
            _tag: "StreamReady",
            sessionId: session.sessionId,
            streamUrl: session.streamUrl,
          });
          yield* untilStop(session, watchGame(session));
        }),
      );
      yield* finish(session);
    }).pipe(Effect.catchTag("Abort", (abort) => fail(session, abort)));

  const register = (
    fields: Pick<
      Session,
      "sessionId" | "userId" | "baseVersion" | "appId" | "slot" | "name"
    > &
      Partial<
        Pick<Session, "created" | "phase" | "gameRunning" | "cloudBaseline">
      >,
  ) =>
    Effect.gen(function* () {
      const session: Session = {
        ...fields,
        overlays: sessionLayers(config, fields.sessionId),
        streamUrl: streamUrlFor(fields.sessionId),
        created: fields.created ?? false,
        phase: fields.phase ?? "starting",
        seeded: false,
        loginResetAt: undefined,
        gameRunning: fields.gameRunning ?? false,
        stage: undefined,
        cloudBaseline: fields.cloudBaseline,
        metrics: undefined,
        stopRequested: yield* Deferred.make<void>(),
      };
      sessions.set(session.sessionId, session);
      return session;
    });

  /** Почему команду запуска нельзя исполнять (`undefined` — можно). */
  const invalidStart = (command: StartSession) => {
    if (!isValidId(command.sessionId)) return "sessionId";
    if (!isValidId(command.userId)) return "userId";
    if (command.slot < 0 || command.slot >= config.slots) return "slot";
    if (command.udpPort !== config.udpPortBase + command.slot) return "udpPort";
    return undefined;
  };

  const start = (command: StartSession) =>
    Effect.gen(function* () {
      const invalid = invalidStart(command);
      if (invalid !== undefined) {
        // Docker не трогаем: значения уходят в имена, тома и пути API.
        yield* Effect.logError("Rejected invalid StartSession", {
          sessionId: command.sessionId,
          field: invalid,
          slot: command.slot,
          udpPort: command.udpPort,
        });
        yield* emit({
          _tag: "Failed",
          sessionId: command.sessionId,
          reason: failReasons.invalidCommand,
        });
        return;
      }
      const known = sessions.get(command.sessionId);
      if (known !== undefined) {
        // Повтор StartSession (переотправка оркестратором): второй контейнер не
        // создаём, повторяем текущее состояние.
        yield* Effect.logInfo("StartSession for a known session", {
          sessionId: command.sessionId,
          phase: known.phase,
        });
        if (known.phase === "ready") {
          yield* emit({
            _tag: "StreamReady",
            sessionId: known.sessionId,
            streamUrl: known.streamUrl,
          });
          yield* emit({
            _tag: "GameState",
            sessionId: known.sessionId,
            running: known.gameRunning,
          });
        }
        return;
      }
      // Scratch сессий — на общем диске хоста: без запаса места не стартуем.
      if (
        !(yield* hasFreeSpace(freeSpace, config.scratchDir, config.minFreeGb))
      ) {
        yield* emit({
          _tag: "Failed",
          sessionId: command.sessionId,
          reason: failReasons.noSpace,
        });
        return;
      }
      const session = yield* register({
        sessionId: command.sessionId,
        userId: command.userId,
        baseVersion: command.profile?.version ?? null,
        appId: command.appId,
        slot: command.slot,
        name: containerName(command.sessionId),
      });
      yield* Effect.logInfo("StartSession accepted", {
        sessionId: command.sessionId,
        slot: command.slot,
        udpPort: command.udpPort,
        appId: command.appId,
        profileVersion: command.profile?.version ?? null,
      });
      yield* Effect.forkIn(
        lifecycle(session, {
          spec: sessionSpec(config, command, sessionPassword()),
          profile: command.profile,
          steamLogin: command.steamLogin,
          steamLoginResetAt: command.steamLoginResetAt,
        }),
        scope,
      );
    });

  const stop = (sessionId: string) =>
    Effect.gen(function* () {
      if (!isValidId(sessionId)) {
        yield* Effect.logError(
          "Ignored StopSession with an invalid sessionId",
          {
            sessionId,
          },
        );
        return;
      }
      const session = sessions.get(sessionId);
      if (session !== undefined) {
        yield* Deferred.succeed(session.stopRequested, undefined);
        return;
      }
      // Неизвестная сессия: контейнер с её именем удаляется только штатной
      // остановкой — дом пользователя в его слоях. Запущенный наш (например,
      // `docker stop` не удался при прошлой остановке) подхватывается и
      // останавливается как обычно, с сохранением профиля (`Stopped` отправит
      // finish). Без меток профиля — только остановить. Остановленный не трогаем,
      // кроме контейнера с меткой `profile-saved` (его профиль уже сохранён).
      const name = containerName(sessionId);
      const stopped = emit({
        _tag: "Stopped",
        sessionId,
        cloudSynced: false,
        profileSaved: false,
      });
      yield* Effect.forkIn(
        Effect.gen(function* () {
          const container = yield* docker.inspect(name);
          if (container === undefined) return yield* stopped;
          if (container.labels["cg.session"] !== sessionId) {
            yield* Effect.logWarning(
              "Not touching a container without our session label",
              { sessionId, name },
            );
            return yield* stopped;
          }
          // Профиль уже сохранён (прошлый запуск агента не успел убрать): только
          // убрать, второй раз профиль не снимается.
          if (existsSync(profileSavedMarker(config, sessionId)))
            return yield* adoptSaved(container, sessionId);
          if (!container.running) {
            yield* Effect.logWarning(
              "Keeping a stopped session container (profile-unsaved)",
              { sessionId, name },
            );
            return yield* stopped;
          }
          const adopted = yield* adoptRunning(container, { stop: true });
          if (adopted !== undefined) return;
          yield* Effect.logError("profile-unsaved", {
            sessionId,
            container: name,
            reason: "no profile labels",
          });
          yield* docker.stop(name, STOP_TIMEOUT_SEC);
          yield* keepStopped(sessionId, sessionLayers(config, sessionId));
          yield* stopped;
        }).pipe(
          Effect.catchTag("DockerError", (error) =>
            Effect.logWarning("Stopping unknown session container failed", {
              sessionId,
              error: error.message,
            }).pipe(Effect.andThen(stopped)),
          ),
        ),
        scope,
      );
    });

  /**
   * Запущенный контейнер `cg.session` под надзор: проверка меток (пользователь и
   * база профиля нужны для сохранения), состояние игры и облака, жизненный цикл.
   * `stop` — сразу остановить (штатно, с сохранением профиля). `undefined` —
   * метки испорчены или сессия уже ведётся.
   */
  const adoptRunning = (
    container: ContainerInfo,
    options: { readonly stop: boolean },
  ) =>
    Effect.gen(function* () {
      const sessionId = container.labels["cg.session"] ?? "";
      const userId = container.labels[USER_LABEL] ?? "";
      const baseVersion = parseBaseVersion(
        container.labels[BASE_VERSION_LABEL],
      );
      const slot = Number(container.labels["cg.slot"]);
      const appId = Number(container.labels["cg.app"]);
      if (
        !isValidId(sessionId) ||
        !isValidId(userId) ||
        baseVersion === undefined ||
        !Number.isInteger(slot) ||
        !Number.isInteger(appId) ||
        sessions.has(sessionId)
      )
        return undefined;
      const target: Target = { name: container.name, appId };
      const gameRunning = yield* gameAlive(target).pipe(
        Effect.orElseSucceed(() => false),
      );
      const cloudBaseline = gameRunning ? yield* cloudCount(target) : undefined;
      // Пока шли проверки, сессию мог подхватить параллельный StopSession.
      if (sessions.has(sessionId)) return undefined;
      const session = yield* register({
        sessionId,
        userId,
        baseVersion,
        appId,
        slot,
        name: container.name,
        created: true,
        gameRunning,
        cloudBaseline,
      });
      if (options.stop)
        yield* Deferred.succeed(session.stopRequested, undefined);
      yield* Effect.logInfo("Adopted running session container", {
        sessionId,
        slot,
        gameRunning,
        stopping: options.stop,
      });
      yield* Effect.forkIn(lifecycle(session, undefined), scope);
      return session;
    });

  /**
   * Контейнер с меткой `profile-saved` (профиль уже сохранён, а убрать его
   * прошлый запуск агента не успел): под надзор в фазе `stopping` и сразу
   * `settle` в режиме `remove` (запущенный — тоже, профиль второй раз не
   * снимается), затем `Stopped`. Метки, кроме `cg.session`, здесь не нужны —
   * испорченные заменяются нулями (их видит только `snapshot`).
   */
  const adoptSaved = (container: ContainerInfo, sessionId: string) =>
    Effect.gen(function* () {
      // Сессию мог уже подхватить параллельный StopSession (после своего inspect).
      if (sessions.has(sessionId)) return;
      const label = (name: string) => {
        const value = Number(container.labels[name]);
        return Number.isInteger(value) ? value : 0;
      };
      const session = yield* register({
        sessionId,
        userId: container.labels[USER_LABEL] ?? "",
        baseVersion:
          parseBaseVersion(container.labels[BASE_VERSION_LABEL]) ?? null,
        appId: label("cg.app"),
        slot: label("cg.slot"),
        name: container.name,
        created: true,
        phase: "stopping",
      });
      yield* Effect.logInfo(
        "Removing a session container with a saved profile",
        {
          sessionId,
          name: container.name,
          running: container.running,
        },
      );
      yield* Effect.forkIn(
        settle(session, "remove", {
          _tag: "Stopped",
          sessionId,
          cloudSynced: false,
          profileSaved: true,
        }),
        scope,
      );
    });

  /**
   * Контейнеры, пережившие перезапуск агента: с меткой `profile-saved` — удалить
   * со слоями (`adoptSaved`), живые подхватить, живые с испорченными метками
   * (MVP-2, без cg.user) убрать. Остановленные без метки не удаляются никогда: в
   * их слоях — несохранённый профиль (`profile-unsaved`).
   */
  const adopt = Effect.gen(function* () {
    const containers = yield* docker.listByLabel("cg.session");
    for (const container of containers) {
      const labelled = container.labels["cg.session"] ?? "";
      if (
        isValidId(labelled) &&
        !sessions.has(labelled) &&
        existsSync(profileSavedMarker(config, labelled))
      ) {
        yield* adoptSaved(container, labelled);
        continue;
      }
      if (!container.running) {
        const sessionId = container.labels["cg.session"] ?? "";
        yield* Effect.logWarning(
          "Keeping stopped session container (profile-unsaved)",
          { name: container.name, sessionId },
        );
        // Агент мог упасть между остановкой и снятием метки volatile.
        if (isValidId(sessionId))
          yield* keepStopped(sessionId, sessionLayers(config, sessionId));
        continue;
      }
      if ((yield* adoptRunning(container, { stop: false })) !== undefined)
        continue;
      yield* Effect.logInfo("Removing leftover session container", {
        name: container.name,
      });
      yield* docker.remove(container.name).pipe(
        Effect.catchTag("DockerError", (error) =>
          Effect.logWarning("Removing leftover container failed", {
            name: container.name,
            error: error.message,
          }),
        ),
      );
    }
  });

  /** Помощники (`cg.helper`) прошлого запуска агента: одноразовые, убрать. */
  const removeHelpers = Effect.gen(function* () {
    for (const helper of yield* docker.listByLabel(HELPER_LABEL))
      yield* docker.remove(helper.name).pipe(
        Effect.catchTag("DockerError", (error) =>
          Effect.logWarning("Removing leftover helper failed", {
            name: helper.name,
            error: error.message,
          }),
        ),
      );
  });

  /**
   * Слои сессий (тома `cg-s-<id>-*` и `<SCRATCH_DIR>/<id>`), у которых контейнера
   * `cg-session-<id>` нет вовсе и которые не под надзором. Слои остановленного
   * контейнера — его, не трогаются.
   */
  const removeOrphanLayers = Effect.gen(function* () {
    const ids = new Set<string>();
    for (const volume of yield* docker.listVolumes("cg.session")) {
      const id = volume.labels["cg.session"] ?? "";
      if (isValidId(id)) ids.add(id);
    }
    const dirs = yield* Effect.try(() =>
      readdirSync(config.scratchDir, { withFileTypes: true }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Reading the scratch dir failed", {
          scratchDir: config.scratchDir,
          error: String(error),
        }).pipe(Effect.as([])),
      ),
    );
    for (const dir of dirs)
      if (dir.isDirectory() && isValidId(dir.name)) ids.add(dir.name);
    for (const id of ids) {
      // Слои сессии под надзором (например, `adoptSaved`) убирает сама сессия.
      if (sessions.has(id)) continue;
      if ((yield* docker.inspect(containerName(id))) !== undefined) continue;
      yield* Effect.logInfo("Removing orphan session layers", {
        sessionId: id,
      });
      yield* cleanupLogged(sessionLayers(config, id));
    }
  });

  // Помощники — до подхвата: оставшийся hold держит тома смонтированными, а
  // метку volatile снимают только с размонтированных.
  yield* removeHelpers;
  yield* adopt;
  yield* removeOrphanLayers;

  // Heartbeat: все живые сессии, включая создаваемые и останавливаемые.
  yield* Effect.sleep(HEARTBEAT_INTERVAL).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        emit({ _tag: "Heartbeat", sessionIds: [...sessions.keys()] }),
      ),
    ),
    Effect.forever,
    Effect.forkIn(scope),
  );

  return {
    handle: (command) => {
      switch (command._tag) {
        case "StartSession":
          return start(command);
        case "StopSession":
          return stop(command.sessionId);
      }
    },
    snapshot: Effect.sync(() =>
      [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        slot: session.slot,
        streamUrl: session.streamUrl,
        gameRunning: session.gameRunning,
      })),
    ),
    reports,
  } satisfies SessionSupervisorShape;
});

export class SessionSupervisor extends Context.Service<
  SessionSupervisor,
  SessionSupervisorShape
>()("@cg/agent/SessionSupervisor") {
  /**
   * Подхватывает контейнеры с меткой `cg.session` при старте, убирает забытых
   * помощников и осиротевшие слои (Docker недоступен — ошибка слоя), запускает
   * heartbeat.
   */
  static readonly layer: Layer.Layer<
    SessionSupervisor,
    DockerError,
    AgentConfig | DockerClient | ProfileStore | ProfileCommitter
  > = Layer.effect(SessionSupervisor, make);
}
