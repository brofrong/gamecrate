// SessionSupervisor: контейнеры сессий на воркере. По команде оркестратора
// готовит overlay-слои, создаёт контейнер, кладёт в него профиль пользователя и
// запускает, ждёт Selkies, следит за процессом игры; при остановке ждёт выгрузку
// облака Steam, сохраняет профиль и убирает контейнер со слоями (профиль не
// сохранён — контейнер со слоями остаётся). Отчёты складывает в очередь `reports`
// (их по порядку отправляет OrchestratorLink).
import { readdirSync } from "node:fs";
import type {
  AgentCommand,
  AgentReport,
  ProfileRef,
  RunningSession,
} from "@cg/rpc";
import {
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
  type ContainerSpec,
  DockerClient,
  type DockerError,
} from "./DockerClient";
import { HELPER_LABEL } from "./Helper";
import {
  cleanup,
  mountsFor,
  type Overlays,
  prepare,
  sessionLayers,
} from "./Overlay";
import { restoreProfile, saveProfile } from "./profile/HomeProfile";
import type { ProfileCommitter } from "./profile/ProfileCommitter";
import type { ProfileStore } from "./profile/ProfileStore";

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
export const HEARTBEAT_INTERVAL = Duration.seconds(30);
export const STOP_TIMEOUT_SEC = 15;
export const SHM_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** Причины `Failed` (их видит пользователь). */
export const failReasons = {
  dockerStart: "Не удалось запустить игровой сервер",
  streamTimeout: "Стрим не запустился за 2 минуты",
  gpuCapture: "На сервере не работает захват экрана GPU",
  containerGone: "Игровой сервер неожиданно остановился",
  stop: "Не удалось остановить игровой сервер",
  invalidCommand: "Некорректная команда запуска сессии",
  profileRestore: "Не удалось загрузить профиль пользователя",
} as const;

/**
 * Допустимый `sessionId`/`userId`: попадает в имя контейнера и тома и в пути
 * Docker API, поэтому только `[A-Za-z0-9_-]`, не длиннее 64.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidId = (id: string) => ID_PATTERN.test(id);

export const containerName = (sessionId: string) => `cg-session-${sessionId}`;
export const streamUrlFor = (sessionId: string) =>
  `http://${containerName(sessionId)}:${SELKIES_PORT}`;

type StartSession = Extract<AgentCommand, { _tag: "StartSession" }>;

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
 * Контейнер сессии для `StartSession`: дом — слой контейнера, клиент Steam и
 * библиотека — overlay-тома сессии (`sessionLayers`), профиль кладётся до старта.
 */
export const sessionSpec = (
  config: AgentConfigValues,
  command: StartSession,
  password: string,
): ContainerSpec => ({
  name: containerName(command.sessionId),
  image: config.sessionImage,
  env: {
    CG_APP_ID: String(command.appId),
    SELKIES_WEBRTC_UDP_MUX_PORT: String(command.udpPort),
    SELKIES_WEBRTC_PUBLIC_IP: config.publicIp,
    PASSWD: password,
  },
  labels: {
    "cg.session": command.sessionId,
    "cg.slot": String(command.slot),
    "cg.app": String(command.appId),
    [USER_LABEL]: command.userId,
    [BASE_VERSION_LABEL]: formatBaseVersion(command.profile?.version ?? null),
  },
  network: config.sessionNetwork,
  udpPorts: [command.udpPort],
  binds: Option.match(config.gbmAllocatorPath, {
    onNone: () => [],
    onSome: (path) => GBM_TARGETS.map((target) => `${path}:${target}:ro`),
  }),
  mounts: mountsFor(sessionLayers(config, command.sessionId)),
  runtime: "nvidia",
  gpus: true,
  shmSizeBytes: SHM_SIZE_BYTES,
  // В базовом образе у `ubuntu` `NOPASSWD: ALL` в sudoers, а /etc/shadow ему
  // принадлежит (su root): без этого флага любой процесс сессии получает root.
  securityOpt: ["no-new-privileges:true"],
  // Интерпозеру геймпадов Selkies нужен каталог /dev/input (файлов в нём нет);
  // entrypoint создаёт его через sudo-root, что при no-new-privileges невозможно.
  tmpfs: { "/dev/input": "mode=1777,size=64k,nosuid,nodev,noexec" },
});

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
} as const;

type Phase = "starting" | "ready" | "stopping";

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
  gameRunning: boolean;
  /**
   * Число маркеров облака при последнем опросе, где игра ещё шла, или перед
   * SIGTERM при остановке (игра не запускалась — нет). Выгрузки во время игры
   * (в т.ч. при её запуске) так не принимаются за итоговую.
   */
  cloudBaseline: CloudCount | undefined;
  /** Пришёл `StopSession`. */
  readonly stopRequested: Deferred.Deferred<void>;
}

/** Контейнер, в котором выполняются проверки. */
type Target = Pick<Session, "name" | "appId">;

/**
 * Сессию нельзя продолжать: убрать контейнер со слоями и сообщить `Failed`.
 * `keep` — в upper-слоях могут быть несохранённые данные игры: контейнер только
 * остановить, ни его, ни слои не удалять.
 */
class Abort extends Data.TaggedError("Abort")<{
  readonly reason: string;
  readonly cause?: unknown;
  readonly keep?: boolean;
}> {}

/** Проверка в контейнере не дала ответа (неожиданный код выхода). */
class CheckFailed extends Data.TaggedError("CheckFailed")<{
  readonly message: string;
}> {}

/** Контейнера больше нет (или он остановлен): exec отвечает 404/409. */
const isGone = (error: DockerError) =>
  error.status === 404 || error.status === 409;

export interface SessionSupervisorShape {
  /** Команда оркестратора; возвращается сразу, работа идёт в фоне. */
  readonly handle: (command: AgentCommand) => Effect.Effect<void>;
  /** Живые сессии для `agent.connect.running` (с момента приёма StartSession). */
  readonly snapshot: Effect.Effect<ReadonlyArray<RunningSession>>;
  /** Отчёты оркестратору в порядке возникновения. */
  readonly reports: Queue.Queue<AgentReport>;
}

const make = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const docker = yield* DockerClient;
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

  /** Следит за процессом игры, пока он не завершится (после запуска). */
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
          // Состояние и отчёт — без точки прерывания между ними: StopSession в этот
          // момент видит уже запущенную игру (и закроет её, и подождёт облако).
          yield* Effect.uninterruptible(
            Effect.suspend(() => {
              session.gameRunning = alive;
              return emit({
                _tag: "GameState",
                sessionId: session.sessionId,
                running: alive,
              });
            }),
          );
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
  const untilStop = <A, E>(session: Session, effect: Effect.Effect<A, E>) =>
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
   * Остановка: облако (если игра шла) → профиль → stop → remove → слои →
   * `Stopped`. Профиль не сохранён — контейнер только останавливается и вместе
   * со слоями остаётся (`profile-unsaved` в логе), следующая сессия получит
   * предыдущую версию профиля.
   */
  const finish = (session: Session) =>
    Effect.gen(function* () {
      session.phase = "stopping";
      let cloudSynced = false;
      if (session.gameRunning) {
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
      }).pipe(withServices, Effect.result);
      if (Result.isFailure(saved)) {
        yield* Effect.logError("profile-unsaved", {
          sessionId: session.sessionId,
          userId: session.userId,
          container: session.name,
          stage: saved.failure.stage,
          error: saved.failure.message,
        });
        yield* docker
          .stop(session.name, STOP_TIMEOUT_SEC)
          .pipe(
            Effect.mapError(
              (cause) =>
                new Abort({ reason: failReasons.stop, cause, keep: true }),
            ),
          );
      } else {
        yield* docker.stop(session.name, STOP_TIMEOUT_SEC).pipe(
          Effect.andThen(docker.remove(session.name)),
          Effect.mapError(
            (cause) =>
              new Abort({ reason: failReasons.stop, cause, keep: false }),
          ),
        );
        yield* cleanupLogged(session.overlays);
      }
      const profileSaved = Result.isSuccess(saved) && saved.success;
      sessions.delete(session.sessionId);
      yield* emit({
        _tag: "Stopped",
        sessionId: session.sessionId,
        cloudSynced,
        profileSaved,
      });
      yield* Effect.logInfo("Session stopped", {
        sessionId: session.sessionId,
        cloudSynced,
        profileSaved,
      });
    });

  /**
   * Сбой: контейнер и слои убрать (слот и UDP-порт свободны), затем `Failed`.
   * После готовности стрима пользователь мог играть: такой контейнер (если не
   * сказано иное) только останавливается и остаётся вместе со слоями.
   */
  const fail = (session: Session, abort: Abort) =>
    Effect.gen(function* () {
      const keep = abort.keep ?? session.phase !== "starting";
      yield* Effect.logError("Session failed", {
        sessionId: session.sessionId,
        reason: abort.reason,
        cause: abort.cause,
      });
      if (keep) {
        yield* Effect.logError("profile-unsaved", {
          sessionId: session.sessionId,
          userId: session.userId,
          container: session.name,
        });
        yield* docker.stop(session.name, STOP_TIMEOUT_SEC).pipe(
          Effect.catchTag("DockerError", (error) =>
            Effect.logError("Stopping failed session container failed", {
              sessionId: session.sessionId,
              error: error.message,
            }),
          ),
        );
      } else if (session.created) {
        const removed = yield* docker.remove(session.name).pipe(
          Effect.as(true),
          Effect.catchTag("DockerError", (error) =>
            Effect.logError("Removing failed session container failed", {
              sessionId: session.sessionId,
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (removed) yield* cleanupLogged(session.overlays);
      } else {
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
      }
      sessions.delete(session.sessionId);
      yield* emit({
        _tag: "Failed",
        sessionId: session.sessionId,
        reason: abort.reason,
      });
    });

  /** Новый контейнер: слои → create → профиль → start. */
  const launch = (
    session: Session,
    spec: ContainerSpec,
    profile: ProfileRef | null,
  ) =>
    Effect.gen(function* () {
      const dockerStart = (cause: unknown) =>
        new Abort({ reason: failReasons.dockerStart, cause });
      yield* prepare(session.overlays).pipe(
        withServices,
        Effect.mapError(dockerStart),
      );
      yield* docker.create(spec).pipe(Effect.mapError(dockerStart));
      session.created = true;
      const from = yield* restoreProfile({
        container: session.name,
        userId: session.userId,
        profile,
      }).pipe(
        withServices,
        Effect.mapError(
          (cause) => new Abort({ reason: failReasons.profileRestore, cause }),
        ),
      );
      yield* docker.start(session.name).pipe(Effect.mapError(dockerStart));
      yield* Effect.logInfo("Session container started", {
        sessionId: session.sessionId,
        slot: session.slot,
        profile: from,
      });
    });

  /** Жизнь сессии: [создание] → готовность Selkies → игра → остановка. */
  const lifecycle = (
    session: Session,
    launchWith:
      | { readonly spec: ContainerSpec; readonly profile: ProfileRef | null }
      | undefined,
  ) =>
    Effect.gen(function* () {
      if (launchWith !== undefined)
        yield* launch(session, launchWith.spec, launchWith.profile);
      const ready = yield* untilStop(session, waitReady(session));
      if (ready.stopped) return yield* finish(session);
      session.phase = "ready";
      yield* emit({
        _tag: "StreamReady",
        sessionId: session.sessionId,
        streamUrl: session.streamUrl,
      });
      yield* untilStop(session, watchGame(session));
      yield* finish(session);
    }).pipe(Effect.catchTag("Abort", (abort) => fail(session, abort)));

  const register = (
    fields: Pick<
      Session,
      "sessionId" | "userId" | "baseVersion" | "appId" | "slot" | "name"
    > &
      Partial<Pick<Session, "created" | "gameRunning" | "cloudBaseline">>,
  ) =>
    Effect.gen(function* () {
      const session: Session = {
        ...fields,
        overlays: sessionLayers(config, fields.sessionId),
        streamUrl: streamUrlFor(fields.sessionId),
        created: fields.created ?? false,
        phase: "starting",
        gameRunning: fields.gameRunning ?? false,
        cloudBaseline: fields.cloudBaseline,
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
      // Неизвестная (уже остановленная) сессия: убрать запущенный контейнер с её
      // именем вместе со слоями, только если он наш (метка cg.session=<id>), и
      // подтвердить остановку. Остановленный не трогаем: в его слоях может быть
      // несохранённый профиль.
      const name = containerName(sessionId);
      yield* Effect.forkIn(
        docker.inspect(name).pipe(
          Effect.flatMap((container) => {
            if (container === undefined) return Effect.void;
            if (container.labels["cg.session"] !== sessionId)
              return Effect.logWarning(
                "Not removing a container without our session label",
                { sessionId, name },
              );
            if (!container.running)
              return Effect.logWarning(
                "Keeping a stopped session container (profile-unsaved)",
                { sessionId, name },
              );
            return docker
              .remove(name)
              .pipe(
                Effect.andThen(cleanupLogged(sessionLayers(config, sessionId))),
              );
          }),
          Effect.catchTag("DockerError", (error) =>
            Effect.logWarning("Removing unknown session container failed", {
              sessionId,
              error: error.message,
            }),
          ),
          Effect.andThen(
            emit({
              _tag: "Stopped",
              sessionId,
              cloudSynced: false,
              profileSaved: false,
            }),
          ),
        ),
        scope,
      );
    });

  /**
   * Контейнеры, пережившие перезапуск агента: живые подхватить, живые чужие или
   * испорченные убрать. Остановленные не удаляются никогда: в их слоях —
   * несохранённый профиль (`profile-unsaved`).
   */
  const adopt = Effect.gen(function* () {
    const containers = yield* docker.listByLabel("cg.session");
    for (const container of containers) {
      const sessionId = container.labels["cg.session"] ?? "";
      const userId = container.labels[USER_LABEL] ?? "";
      const baseVersion = parseBaseVersion(
        container.labels[BASE_VERSION_LABEL],
      );
      const slot = Number(container.labels["cg.slot"]);
      const appId = Number(container.labels["cg.app"]);
      if (!container.running) {
        yield* Effect.logWarning(
          "Keeping stopped session container (profile-unsaved)",
          { name: container.name, sessionId },
        );
        continue;
      }
      const valid =
        isValidId(sessionId) &&
        isValidId(userId) &&
        baseVersion !== undefined &&
        Number.isInteger(slot) &&
        Number.isInteger(appId);
      if (!valid || sessions.has(sessionId) || baseVersion === undefined) {
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
        continue;
      }
      const target: Target = { name: container.name, appId };
      const gameRunning = yield* gameAlive(target).pipe(
        Effect.orElseSucceed(() => false),
      );
      const session = yield* register({
        sessionId,
        userId,
        baseVersion,
        appId,
        slot,
        name: container.name,
        created: true,
        gameRunning,
        cloudBaseline: gameRunning ? yield* cloudCount(target) : undefined,
      });
      yield* Effect.logInfo("Adopted running session container", {
        sessionId,
        slot,
        gameRunning,
      });
      yield* Effect.forkIn(lifecycle(session, undefined), scope);
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
   * `cg-session-<id>` нет вовсе. Слои остановленного контейнера — его, не трогаются.
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
      if ((yield* docker.inspect(containerName(id))) !== undefined) continue;
      yield* Effect.logInfo("Removing orphan session layers", {
        sessionId: id,
      });
      yield* cleanupLogged(sessionLayers(config, id));
    }
  });

  yield* adopt;
  yield* removeHelpers;
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
        case "InstallGame":
        case "CancelInstall":
          // Task 4: обрабатывает Installer (роль gamestore); этот агент
          // подключается с roles: ["worker"] и такие команды не получает.
          return Effect.void;
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
