// Installer (роль gamestore): установка игры в общую библиотеку без участия
// пользователя. Контейнер образа сессии в режиме установки (`CG_MODE=install`:
// `steam -silent` без запуска игры) с профилем пользователя и overlay-слоями
// поверх клиента Steam и библиотеки; в `steamapps` до старта кладётся заготовка
// манифеста со `StateFlags 1026` — Steam сам ставит игру (и её зависимости) в
// upper. Прогресс — из манифеста (`exec cat`, агент не читает upper
// смонтированного overlay изнутри контейнера), для плавности — ещё и размер
// каталога `downloading` upper-слоя (его агент читает прямо на хосте, не через
// exec). Готово → профиль сохраняется, контейнер и тома удаляются, новые
// приложения переносятся `rename` из upper в библиотеку. Одна установка за раз.
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { lstat as lstatAsync, readdir as readdirAsync } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentCommand,
  type AgentReport,
  type ProfileRef,
  type SteamLoginSeed,
  steamLoginRequiredReason,
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
import { AgentConfig, type AgentConfigValues } from "./config";
import {
  type ContainerSpec,
  DockerClient,
  type DockerError,
  isGone,
} from "./DockerClient";
import { FreeSpace, hasFreeSpace } from "./DiskSpace";
import { isValidId } from "./ids";
import {
  cleanup,
  holdName,
  holdVolumes,
  INSTALL_CLIENT_DIR,
  installLayers,
  mountsFor,
  type Overlays,
  prepare,
  removeScratch,
  removeVolumes,
  STEAM_DIR,
  STEAMAPPS_DIR,
} from "./Overlay";
import { singleFileTar } from "./profile/codec";
import { restoreProfile, saveProfile } from "./profile/HomeProfile";
import type { ProfileCommitter } from "./profile/ProfileCommitter";
import type { ProfileStore } from "./profile/ProfileStore";
import {
  desktopSpec,
  STOP_TIMEOUT_SEC,
  sessionPassword,
  USER_LABEL,
} from "./SessionSupervisor";
import { seedSteamLogin } from "./steam/seedContainer";
import { tokenize } from "./steam/vdf";

/** Метка контейнеров и томов установки: `cg.install=<jobId>`. */
export const INSTALL_LABEL = "cg.install";
export const INSTALL_POLL = Duration.seconds(2);
/**
 * Манифест не менялся столько (байты загрузки и распаковки, `StateFlags`) —
 * загрузка считается остановившейся.
 */
export const STALL_TIMEOUT = Duration.minutes(10);
/**
 * С первых строк журнала подключения (клиент пишет его, только закончив
 * bootstrap/самообновление) — сколько ждать, что клиент хотя бы попробует
 * войти (`STEAM_LOGON_ATTEMPT`), прежде чем считать его застрявшим в своём
 * окне входа. На части железа (проба на brofrong, 2026-10-26) UI Steam готов
 * звать `LogOn()` только спустя ~80 с после первых строк журнала — заметно
 * дольше, чем сам `steamLoginTimeoutSeconds` (который отсчитывается от этой
 * попытки, а не от первых строк, см. `waitForSteamLogon`).
 */
export const STEAM_CLIENT_START_TIMEOUT = Duration.minutes(5);

/** Причины `InstallFailed` (их видит пользователь). */
export const installReasons = {
  busy: "Установщик занят",
  stalled: "Загрузка остановилась",
  cancelled: "Установка отменена",
  dockerStart: "Не удалось запустить установщик",
  profileRestore: "Не удалось загрузить профиль пользователя",
  /** Профиля нет: Steam без входа ждал бы невидимый QR (оркестратор покажет как есть). */
  steamLogin: steamLoginRequiredReason,
  containerGone: "Установщик неожиданно остановился",
  stop: "Не удалось остановить установщик",
  promote: "Не удалось перенести игру в библиотеку",
  invalidCommand: "Некорректная команда установки",
  noSpace: "На сервере закончилось место",
  notGamestore: "Этот сервер не устанавливает игры",
  unexpected: "Внутренняя ошибка установщика",
} as const;

export const installContainerName = (jobId: string) => `cg-install-${jobId}`;

/** Журнал подключения клиента Steam (спека §5.4): признак входа/невхода. */
export const CONNECTION_LOG = `${STEAM_DIR}/logs/connection_log.txt`;

/**
 * Строка принятого входа в `connection_log.txt` (проба на brofrong, спека
 * §5.4): `RecvMsgClientLogOnResponse() : [U:1:…] 'OK'` на одной строке
 * (`'OK'` — не `'Failure'`/другой код отказа).
 */
export const STEAM_LOGON_OK = /RecvMsgClientLogOnResponse\(\).*'OK'/;

/**
 * Строка попытки входа в `connection_log.txt` (проба на brofrong,
 * 2026-10-26): клиент зовёт `LogOn()` (нет подключения — «scheduling
 * connection») или уже на стадии `Logging on [U:…]`. До этой строки
 * `steamLoginTimeoutSeconds` не считается — клиент ещё готовит своё UI, а не
 * ждёт ответ сервера (см. `waitForSteamLogon`).
 */
export const STEAM_LOGON_ATTEMPT = /LogOn\(\) called|Logging on \[U:/;

const manifestName = (appId: number) => `appmanifest_${appId}.acf`;
/** Манифест игры в контейнере установщика. */
export const manifestPath = (appId: number) =>
  `${STEAMAPPS_DIR}/${manifestName(appId)}`;

/**
 * Каталог частично скачанных файлов целевого приложения в upper apps-слоя
 * (внутри `steamapps`, рядом с `common`): `<apps upper>/downloading/<appId>`.
 * Второй, более плавный источник процента вместе с манифестом (спека §4.3);
 * проверка на настоящей установке — Task 7. Отключить — убрать единственный
 * вызов `downloadingBytes` в `watch`.
 */
const downloadingDir = (job: Job) =>
  join(job.overlays.apps.upper, "downloading", String(job.appId));

/**
 * Сколько места занимают обычные файлы под `dir` рекурсивно — выделенные
 * блоки (`blocks * 512`), а не `size`: Steam может заранее растянуть или
 * создать разреженными файлы на весь размер, и процент прыгнул бы к 100 %.
 * Агент читает upper хоста напрямую, overlay тут ни при чём; асинхронно — та
 * же ФС, что у библиотеки, и тот же процесс может держать живые сессии (роли
 * worker+gamestore), опрос не должен блокировать его event loop. Ссылки не
 * разыменовываются (`lstat`). Каталога нет или запись не читается (гонка с
 * Steam, права) — пропускается, сбоя наружу нет.
 */
export const downloadingBytes = (dir: string): Effect.Effect<number> =>
  Effect.promise(async () => {
    const walk = async (path: string): Promise<number> => {
      let entries;
      try {
        entries = await readdirAsync(path, { withFileTypes: true });
      } catch {
        return 0;
      }
      let total = 0;
      for (const entry of entries) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) total += await walk(full);
        else if (entry.isFile()) {
          try {
            total += (await lstatAsync(full)).blocks * 512;
          } catch {
            // гонка со Steam/права — пропускаем, не валим установку
          }
        }
      }
      return total;
    };
    return walk(dir);
  });

export type DownloadingBytesShape = (dir: string) => Effect.Effect<number>;

/**
 * Как измерять `downloadingDir` — по умолчанию настоящий асинхронный обход
 * (`downloadingBytes`). Как и `FreeSpace` в `DiskSpace.ts`: тесты подменяют
 * синхронным фейком — настоящий промис внутри цикла опроса, driven
 * `TestClock`, рвёт цепочку, которой `TestClock.adjust` сам продвигает подряд
 * идущие `Effect.sleep`, и гоняется с реальным event loop не детерминированно.
 */
export const DownloadingBytes = Context.Reference<DownloadingBytesShape>(
  "@cg/agent/DownloadingBytes",
  { defaultValue: () => downloadingBytes },
);

/**
 * Заготовка манифеста: «нужно обновление, обновление начато» (`StateFlags 1026`)
 * — Steam при старте ставит игру в очередь загрузки. `installdir` Steam
 * перезапишет настоящим; `<appId>` — чтобы не зависеть от названия.
 */
export const stubManifest = (appId: number) =>
  [
    '"AppState"',
    "{",
    `\t"appid"\t\t"${appId}"`,
    '\t"Universe"\t\t"1"',
    `\t"installdir"\t\t"${appId}"`,
    '\t"StateFlags"\t\t"1026"',
    "}",
    "",
  ].join("\n");

/**
 * Поля верхнего уровня блока `"AppState" { … }` манифеста Steam (вложенные
 * блоки — `InstalledDepots`, `UserConfig` — пропускаются). Не манифест —
 * `undefined`.
 */
export const parseAppManifest = (
  text: string,
): Record<string, string> | undefined => {
  const tokens = tokenize(text);
  const head = tokens?.[0];
  if (
    tokens === undefined ||
    head?.kind !== "string" ||
    head.value.toLowerCase() !== "appstate" ||
    tokens[1]?.kind !== "open"
  )
    return undefined;
  const fields: Record<string, string> = {};
  let depth = 1;
  let index = 2;
  while (depth > 0) {
    const token = tokens[index];
    if (token === undefined || token.kind === "open") return undefined;
    if (token.kind === "close") {
      depth--;
      index++;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.kind === "close") return undefined;
    if (value.kind === "open") depth++;
    else if (depth === 1) fields[token.value] = value.value;
    index += 2;
  }
  return fields;
};

/** Неотрицательное целое из поля манифеста (байты); иначе `undefined`. */
const count = (value: string | undefined) =>
  value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;

/** Имя каталога игры в `common/`: один компонент пути. */
const isInstallDir = (name: string | undefined): name is string =>
  name !== undefined &&
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\0") &&
  Buffer.byteLength(name) <= 255;

const MANIFEST_FILE = /^appmanifest_([1-9]\d{0,9})\.acf$/;

const lstat = (path: string) => lstatSync(path, { throwIfNoEntry: false });

/** Ошибка `Effect.try` из-за отсутствующего каталога (`ENOENT`). */
const isMissing = (error: unknown) => {
  const cause = (error as { cause?: unknown } | undefined)?.cause ?? error;
  return (cause as { code?: unknown } | undefined)?.code === "ENOENT";
};

export interface Promotion {
  readonly appId: number;
  readonly dir: { readonly from: string; readonly to: string };
  readonly manifest: { readonly from: string; readonly to: string };
}

export interface PromotionPlan {
  /** Новые приложения: каталог и манифест из upper в библиотеку. */
  readonly moves: ReadonlyArray<Promotion>;
  /** Приложения, чей манифест уже в библиотеке: не трогаются. */
  readonly existing: ReadonlyArray<number>;
}

/**
 * Что перенести из upper apps-слоя (`upper`, overlay уже размонтирован) в
 * библиотеку (`lower`): каждый обычный файл `appmanifest_<id>.acf` со
 * `StateFlags 4` и тем же `appid`, которого нет в библиотеке, вместе с обычным
 * каталогом `common/<installdir>`, которого в библиотеке тоже нет. Всё прочее
 * (`compatdata`, `workshop`, `shadercache`, `Steam Controller Configs`,
 * обновления игр библиотеки, ссылки, whiteout-устройства) не переносится.
 */
export const planPromotion = (upper: string, lower: string): PromotionPlan => {
  const moves: Array<Promotion> = [];
  const existing: Array<number> = [];
  const dirs = new Set<string>();
  const entries = readdirSync(upper, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const match = MANIFEST_FILE.exec(entry.name);
    if (match === null) continue;
    const appId = Number(match[1]);
    if (lstat(join(lower, entry.name)) !== undefined) {
      existing.push(appId);
      continue;
    }
    if (!entry.isFile()) continue;
    const fields = parseAppManifest(
      readFileSync(join(upper, entry.name), "utf8"),
    );
    if (
      fields === undefined ||
      fields.appid !== match[1] ||
      fields.StateFlags !== "4"
    )
      continue;
    const installDir = fields.installdir;
    if (!isInstallDir(installDir) || dirs.has(installDir)) continue;
    const from = join(upper, "common", installDir);
    const to = join(lower, "common", installDir);
    if (lstat(from)?.isDirectory() !== true || lstat(to) !== undefined)
      continue;
    dirs.add(installDir);
    moves.push({
      appId,
      dir: { from, to },
      manifest: {
        from: join(upper, entry.name),
        to: join(lower, entry.name),
      },
    });
  }
  return { moves, existing };
};

/**
 * Перенос `rename` (upper и библиотека на одной ФС): каталог раньше манифеста —
 * Steam не увидит в библиотеке «установленную» игру без файлов.
 */
export const applyPromotion = (plan: PromotionPlan, lower: string) => {
  if (plan.moves.length > 0)
    mkdirSync(join(lower, "common"), { recursive: true });
  for (const move of plan.moves) {
    renameSync(move.dir.from, move.dir.to);
    renameSync(move.manifest.from, move.manifest.to);
  }
};

type InstallGame = Extract<AgentCommand, { _tag: "InstallGame" }>;

/**
 * Контейнер установщика: как у сессии (рабочий стол Plasma нужен клиенту
 * Steam), но без UDP-порта и без запуска игры; слои — `installLayers`.
 */
export const installSpec = (
  config: AgentConfigValues,
  command: Pick<InstallGame, "jobId" | "appId" | "userId">,
  password: string,
): ContainerSpec =>
  desktopSpec(config, {
    name: installContainerName(command.jobId),
    env: { CG_MODE: "install", PASSWD: password },
    labels: {
      [INSTALL_LABEL]: command.jobId,
      "cg.app": String(command.appId),
      [USER_LABEL]: command.userId,
    },
    udpPorts: [],
    mounts: mountsFor(installLayers(config, command.jobId)),
  });

export interface InstallerShape {
  /** `InstallGame`; возвращается сразу, установка идёт в фоне. */
  readonly install: (command: InstallGame) => Effect.Effect<void>;
  /** `CancelInstall`: контейнер и scratch удаляются, `InstallFailed`. */
  readonly cancel: (jobId: string) => Effect.Effect<void>;
  /** Идущие установки для `agent.connect.installs` (не больше одной). */
  readonly running: () => ReadonlyArray<string>;
  /** Отчёты установок в порядке возникновения. */
  readonly reports: Queue.Queue<AgentReport>;
}

/** Установку нельзя продолжать: убрать контейнер и scratch, `InstallFailed`. */
class Abort extends Data.TaggedError("InstallAbort")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

interface Job {
  readonly jobId: string;
  readonly appId: number;
  readonly userId: string;
  readonly profile: ProfileRef | null;
  /** Вход для посева (спека §5.3); `null` — оркестратор его не завёл. */
  readonly steamLogin: SteamLoginSeed | null;
  /** Сколько ждать признак входа после старта клиента (спека §5.4). */
  readonly steamLoginTimeoutSeconds: number;
  readonly name: string;
  readonly overlays: Overlays;
  /** Пришёл `CancelInstall`. */
  readonly cancelRequested: Deferred.Deferred<void>;
  /** `finishing` — игра скачана: отмена больше не принимается. */
  phase: "downloading" | "finishing";
  /** Вход §4 вписан в этот запуск (для `ProfileCommit.steamLoginSeeded` и предупреждения). */
  seeded: boolean;
}

type Services = AgentConfig | DockerClient | ProfileStore | ProfileCommitter;

const make = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const docker = yield* DockerClient;
  const freeSpace = yield* FreeSpace;
  const measureDownloading = yield* DownloadingBytes;
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<Services>();
  const withServices = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.provideContext(effect, services);
  const reports = yield* Queue.unbounded<AgentReport>();
  const emit = (report: AgentReport) =>
    Queue.offer(reports, report).pipe(Effect.asVoid);
  const failed = (jobId: string, reason: string) =>
    emit({ _tag: "InstallFailed", jobId, reason });
  let current: Job | undefined;

  /** Слои убрать; не вышло — только лог (при старте агента уберутся). */
  const cleanupLogged = (overlays: Overlays) =>
    cleanup(overlays).pipe(
      withServices,
      Effect.catchTag("OverlayError", (error) =>
        Effect.logWarning("Removing install layers failed", {
          jobId: overlays.id,
          operation: error.operation,
          error: error.message,
        }),
      ),
    );

  /** Поля манифеста цели; файла нет или он не читается — `undefined`. */
  const readManifest = (job: Job) =>
    docker.exec(job.name, ["cat", manifestPath(job.appId)]).pipe(
      Effect.map(({ exitCode, stdout }) =>
        exitCode === 0 ? parseAppManifest(stdout) : undefined,
      ),
      Effect.catchIf(isGone, (cause) =>
        Effect.fail(new Abort({ reason: installReasons.containerGone, cause })),
      ),
      Effect.catchTag("DockerError", (error: DockerError) =>
        Effect.logWarning("Reading the app manifest failed", {
          jobId: job.jobId,
          error: error.message,
        }).pipe(Effect.as(undefined)),
      ),
    );

  /**
   * Строки байтов и состояния всех `appmanifest_*.acf` в `steamapps` одним
   * exec: Steam перед целью качает зависимости (Proton, Steam Linux Runtime) в
   * их собственные манифесты. Не прочиталось — `undefined` (хода нет).
   */
  const readActivity = (job: Job) =>
    docker
      .exec(job.name, [
        "sh",
        "-c",
        `grep -sHE '"(StateFlags|BytesDownloaded|BytesToDownload|BytesStaged|BytesToStage)"' ${STEAMAPPS_DIR}/appmanifest_*.acf`,
      ])
      .pipe(
        Effect.map(({ stdout }) => stdout),
        Effect.catchTag("DockerError", (error: DockerError) =>
          Effect.logWarning("Reading app manifests failed", {
            jobId: job.jobId,
            error: error.message,
          }).pipe(Effect.as(undefined)),
        ),
      );

  /**
   * Опрос манифеста цели: этап `downloading`, как только у цели появился
   * размер загрузки, `InstallProgress` при изменении байтов загрузки, итог
   * — поля манифеста со `StateFlags 4`. Ход установки — любое изменение байтов
   * загрузки и распаковки (`BytesStaged`: после загрузки Steam распаковывает и
   * проверяет) или `StateFlags`, а также любое изменение байтов/состояния
   * других манифестов (зависимости); хода нет STALL_TIMEOUT — `Abort`.
   *
   * Процент (спека §4.3): манифест обновляется редко и скачками — вместе с
   * ним берём размер `downloadingDir` (растёт плавнее) и отдаём максимум из
   * двух, не меньше уже отданного в этой задаче (временная гонка — файлы ещё
   * не переехали в манифест/общую библиотеку — не должна дёргать полоску
   * назад). Ограничение `BytesToDownload` — последним шагом, после «не
   * меньше»: Steam может пересчитать сам `BytesToDownload` меньше прежнего, и
   * тогда отчёт должен упасть вместе с ним, а не вылезти за 100%.
   * `BytesToDownload` пока неизвестен или 0 — как раньше, прямое значение
   * манифеста.
   */
  const watch = (job: Job) =>
    Effect.gen(function* () {
      let lastBytes: string | undefined;
      let lastState: string | undefined;
      let lastActivity: string | undefined;
      let lastReported: number | undefined;
      let downloadStarted = false;
      let changedAt = yield* Clock.currentTimeMillis;
      while (true) {
        const fields = yield* readManifest(job);
        if (fields?.StateFlags === "4") return fields;
        const now = yield* Clock.currentTimeMillis;
        const manifestBytes = count(fields?.BytesDownloaded);
        const bytesTotal = count(fields?.BytesToDownload);
        if (manifestBytes !== undefined && bytesTotal !== undefined) {
          let bytesDownloaded = manifestBytes;
          if (bytesTotal > 0 && !downloadStarted) {
            downloadStarted = true;
            yield* emit({
              _tag: "InstallStage",
              jobId: job.jobId,
              stage: "downloading",
            });
          }
          if (bytesTotal > 0) {
            const downloading = yield* measureDownloading(downloadingDir(job));
            bytesDownloaded = Math.max(bytesDownloaded, downloading);
            bytesDownloaded = Math.max(bytesDownloaded, lastReported ?? 0);
            bytesDownloaded = Math.min(bytesDownloaded, bytesTotal);
            lastReported = bytesDownloaded;
          }
          const bytes = `${bytesDownloaded}/${bytesTotal}`;
          if (bytes !== lastBytes) {
            lastBytes = bytes;
            yield* emit({
              _tag: "InstallProgress",
              jobId: job.jobId,
              bytesDownloaded,
              bytesTotal,
            });
          }
        }
        if (fields !== undefined) {
          const state = [
            fields.BytesDownloaded,
            fields.BytesToDownload,
            fields.BytesStaged,
            fields.BytesToStage,
            fields.StateFlags,
          ].join("|");
          if (state !== lastState) {
            lastState = state;
            changedAt = now;
          }
        }
        const activity = yield* readActivity(job);
        if (activity !== undefined && activity !== lastActivity) {
          lastActivity = activity;
          changedAt = now;
        }
        if (now - changedAt >= Duration.toMillis(STALL_TIMEOUT))
          return yield* new Abort({ reason: installReasons.stalled });
        yield* Effect.sleep(INSTALL_POLL);
      }
    });

  /**
   * Журнал подключения после `offset` байт (журнал дописывается, а не
   * перезаписывается — старые строки шаблона клиента до этого смещения не
   * считаются); контейнера нет — `Abort(containerGone)`, иначе сбой — только
   * лог (следующий опрос попробует снова).
   */
  const readConnectionLog = (job: Job, offset: number) =>
    docker
      .exec(job.name, ["tail", "-c", `+${offset + 1}`, CONNECTION_LOG])
      .pipe(
        Effect.map(({ stdout }) => stdout),
        Effect.catchIf(isGone, (cause) =>
          Effect.fail(
            new Abort({ reason: installReasons.containerGone, cause }),
          ),
        ),
        Effect.catchTag("DockerError", (error: DockerError) =>
          Effect.logWarning("Reading the Steam connection log failed", {
            jobId: job.jobId,
            error: error.message,
          }).pipe(Effect.as("")),
        ),
      );

  /**
   * Ждёт признак входа Steam (спека §5.4, уточнено 2026-10-26 по пробе на
   * brofrong). Три фазы, считая только байты журнала подключения после
   * `offset` (старые строки шаблона клиента до старта этого контейнера не
   * считаются):
   * 1. До первых строк журнала — клиент пишет его, только закончив свой
   *    bootstrap/самообновление и начав подключаться; ждём не дольше
   *    STALL_TIMEOUT от старта (иначе `Abort(stalled)` — это не отказ во
   *    входе).
   * 2. От первых строк до строки попытки входа (`STEAM_LOGON_ATTEMPT`) — не
   *    дольше `STEAM_CLIENT_START_TIMEOUT`: на части железа UI Steam готов
   *    звать `LogOn()` только спустя ~80 с после первых строк — дольше, чем
   *    сам `steamLoginTimeoutSeconds`, который тут ещё не должен тикать.
   * 3. От строки попытки — не дольше `steamLoginTimeoutSeconds`: это и есть
   *    ожидание ответа сервера на попытку входа.
   * Истечение фазы 2 или 3 — `Abort(steamLogin)`, и если вход был вписан
   * этим запуском, предупреждение в лог (владелец узнает о поломке
   * формата). `'OK'`, замеченный в любой момент, — успех сразу, независимо
   * от фазы.
   */
  const waitForSteamLogon = (job: Job, offset: number) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      let stdout = yield* readConnectionLog(job, offset);
      while (stdout === "") {
        const now = yield* Clock.currentTimeMillis;
        if (now - startedAt >= Duration.toMillis(STALL_TIMEOUT))
          return yield* new Abort({ reason: installReasons.stalled });
        yield* Effect.sleep(INSTALL_POLL);
        stdout = yield* readConnectionLog(job, offset);
      }
      const bytesAt = yield* Clock.currentTimeMillis;
      if (STEAM_LOGON_OK.test(stdout)) return;
      const loginFailed = () =>
        Effect.gen(function* () {
          if (job.seeded)
            yield* Effect.logWarning("Seeded Steam login was not accepted", {
              jobId: job.jobId,
              userId: job.userId,
            });
          return yield* new Abort({ reason: installReasons.steamLogin });
        });
      while (!STEAM_LOGON_ATTEMPT.test(stdout)) {
        const now = yield* Clock.currentTimeMillis;
        if (now - bytesAt >= Duration.toMillis(STEAM_CLIENT_START_TIMEOUT))
          return yield* loginFailed();
        yield* Effect.sleep(INSTALL_POLL);
        stdout = yield* readConnectionLog(job, offset);
        if (STEAM_LOGON_OK.test(stdout)) return;
      }
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(INSTALL_POLL);
          if (STEAM_LOGON_OK.test(yield* readConnectionLog(job, offset)))
            return;
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(job.steamLoginTimeoutSeconds),
          orElse: loginFailed,
        }),
      );
    });

  /**
   * Слои → контейнер → профиль (нет профиля и входа — сразу `steamLogin`) →
   * посев входа (есть что сеять) → заготовка манифеста → смещение журнала →
   * старт → ждём вход Steam → загрузка. Этапы для экрана загрузки (спека §2,
   * §4.3): `preparing` сразу, `login` перед ожиданием входа, `downloading` —
   * как только Steam вошёл.
   */
  const download = (job: Job) =>
    Effect.gen(function* () {
      yield* emit({
        _tag: "InstallStage",
        jobId: job.jobId,
        stage: "preparing",
      });
      const startFailed = (cause: unknown) =>
        new Abort({ reason: installReasons.dockerStart, cause });
      yield* prepare(job.overlays).pipe(
        withServices,
        Effect.mapError(startFailed),
      );
      yield* docker
        .create(installSpec(config, job, sessionPassword()))
        .pipe(Effect.mapError(startFailed));
      // Профиль, посев входа, манифест, журнал и старт — по одному монтированию
      // volatile-слоя клиента.
      const { from, logOffset } = yield* Effect.scoped(
        Effect.gen(function* () {
          // withServices заменил бы весь контекст вместе со Scope.
          yield* holdVolumes(job.overlays).pipe(
            Effect.provideService(AgentConfig, config),
            Effect.provideService(DockerClient, docker),
            Effect.mapError(startFailed),
          );
          const from = yield* restoreProfile({
            container: job.name,
            userId: job.userId,
            profile: job.profile,
          }).pipe(
            withServices,
            Effect.mapError(
              (cause) =>
                new Abort({ reason: installReasons.profileRestore, cause }),
            ),
          );
          // Пустой дом и нечем войти — установщик без входа ждал бы QR, которого
          // никто не видит, и упал бы через STALL_TIMEOUT.
          if (from === "empty" && job.steamLogin === null)
            return yield* new Abort({ reason: installReasons.steamLogin });
          if (job.steamLogin !== null) {
            yield* seedSteamLogin({
              container: job.name,
              seed: job.steamLogin,
            }).pipe(
              withServices,
              Effect.mapError(
                (cause) =>
                  new Abort({ reason: installReasons.profileRestore, cause }),
              ),
            );
            job.seeded = true;
          }
          const mtime = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          yield* docker
            .putArchive(
              job.name,
              STEAMAPPS_DIR,
              singleFileTar(
                manifestName(job.appId),
                new TextEncoder().encode(stubManifest(job.appId)),
                { uid: 1000, gid: 1000, mode: 0o644, mtime },
              ),
            )
            .pipe(Effect.mapError(startFailed));
          // Overlay дома уже смонтирован (его lower — общий шаблон клиента):
          // журнал может содержать старые строки до старта этого контейнера.
          const logOffset = yield* docker
            .archiveSize(job.name, CONNECTION_LOG)
            .pipe(
              Effect.catchIf(isGone, () => Effect.succeed(0)),
              Effect.mapError(startFailed),
            );
          yield* docker.start(job.name).pipe(Effect.mapError(startFailed));
          return { from, logOffset };
        }),
      );
      yield* Effect.logInfo("Installer container started", {
        jobId: job.jobId,
        appId: job.appId,
        profile: from,
        steamLoginSeeded: job.seeded,
      });
      yield* emit({ _tag: "InstallStage", jobId: job.jobId, stage: "login" });
      yield* waitForSteamLogon(job, logOffset);
      // Вход принят, но до скачивания Steam ещё десятки секунд готовится
      // (данные библиотеки, общие компоненты Windows): `downloading` — когда у
      // цели появится размер загрузки (`watch`).
      yield* emit({ _tag: "InstallStage", jobId: job.jobId, stage: "library" });
      return yield* watch(job);
    });

  /**
   * Игра скачана: профиль → контейнер и тома (overlay размонтирован) → перенос
   * новых приложений → `InstallFinished` → scratch. Профиль не сохранён — только
   * лог: следующая сессия возьмёт предыдущую версию, игра в библиотеке нужнее.
   */
  const finish = (job: Job, manifest: Record<string, string>) =>
    Effect.gen(function* () {
      job.phase = "finishing";
      yield* emit({ _tag: "InstallStage", jobId: job.jobId, stage: "moving" });
      const sizeBytes = count(manifest.SizeOnDisk) ?? 0;
      const buildId = manifest.buildid ?? "";
      const saved = yield* saveProfile({
        container: job.name,
        userId: job.userId,
        baseVersion: job.profile?.version ?? null,
        steamLoginSeeded: job.seeded,
      }).pipe(withServices, Effect.result);
      if (Result.isFailure(saved))
        yield* Effect.logError("profile-unsaved", {
          jobId: job.jobId,
          userId: job.userId,
          stage: saved.failure.stage,
          error: saved.failure.message,
        });
      const stopFailed = (cause: unknown) =>
        new Abort({ reason: installReasons.stop, cause });
      yield* docker
        .stop(job.name, STOP_TIMEOUT_SEC)
        .pipe(
          Effect.andThen(docker.remove(job.name)),
          Effect.mapError(stopFailed),
        );
      yield* removeVolumes(job.overlays).pipe(
        withServices,
        Effect.mapError(stopFailed),
      );
      const { upper, lower } = job.overlays.apps;
      const promoteFailed = (cause: unknown) =>
        new Abort({ reason: installReasons.promote, cause });
      const plan = yield* Effect.try({
        try: () => planPromotion(upper, lower),
        catch: promoteFailed,
      });
      if (
        !plan.moves.some((move) => move.appId === job.appId) &&
        !plan.existing.includes(job.appId)
      )
        return yield* promoteFailed(
          `app ${job.appId} is not unpacked in the install layer`,
        );
      yield* Effect.try({
        try: () => applyPromotion(plan, lower),
        catch: promoteFailed,
      });
      yield* Effect.logInfo("Install finished", {
        jobId: job.jobId,
        appId: job.appId,
        promoted: plan.moves.map((move) => move.appId),
        alreadyInLibrary: plan.existing,
        sizeBytes,
        buildId,
        profileSaved: Result.isSuccess(saved),
      });
      // Установщик свободен до отчёта: оркестратор может сразу прислать следующую.
      if (current === job) current = undefined;
      yield* emit({
        _tag: "InstallFinished",
        jobId: job.jobId,
        sizeBytes,
        buildId,
      });
      yield* removeScratch(job.overlays).pipe(
        withServices,
        Effect.catchTag("OverlayError", (error) =>
          Effect.logWarning("Removing install scratch failed", {
            jobId: job.jobId,
            error: error.message,
          }),
        ),
      );
    });

  /** Сбой/отмена: контейнер, тома и scratch убрать (библиотеку не трогаем), `InstallFailed`. */
  const fail = (job: Job, abort: Abort) =>
    Effect.gen(function* () {
      yield* Effect.logError("Install failed", {
        jobId: job.jobId,
        appId: job.appId,
        reason: abort.reason,
        cause: abort.cause,
      });
      const removed = yield* docker.remove(job.name).pipe(
        Effect.as(true),
        Effect.catchTag("DockerError", (error) =>
          Effect.logError("Removing installer container failed", {
            jobId: job.jobId,
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
      // Контейнер не удалён — его тома смонтированы: слои не трогаем (уберёт старт агента).
      if (removed) yield* cleanupLogged(job.overlays);
      if (current === job) current = undefined;
      yield* failed(job.jobId, abort.reason);
    });

  const lifecycle = (job: Job) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.raceFirst(
        download(job).pipe(
          Effect.map((manifest) => ({ cancelled: false as const, manifest })),
        ),
        Deferred.await(job.cancelRequested).pipe(
          Effect.as({ cancelled: true as const }),
        ),
      );
      if (outcome.cancelled)
        return yield* new Abort({ reason: installReasons.cancelled });
      yield* finish(job, outcome.manifest);
    }).pipe(
      Effect.catchTag("InstallAbort", (abort) => fail(job, abort)),
      // Ошибка в коде (дефект) — тоже сбой задачи: контейнер и слои убрать,
      // оркестратору — `InstallFailed`, установщик свободен.
      Effect.catchDefect((defect) =>
        fail(
          job,
          new Abort({ reason: installReasons.unexpected, cause: defect }),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (current === job) current = undefined;
        }),
      ),
    );

  const install = (command: InstallGame) =>
    Effect.gen(function* () {
      if (
        !isValidId(command.jobId) ||
        !isValidId(command.userId) ||
        !Number.isSafeInteger(command.appId) ||
        command.appId <= 0
      ) {
        // Docker не трогаем: значения уходят в имена, тома и пути.
        yield* Effect.logError("Rejected invalid InstallGame", {
          jobId: command.jobId,
          appId: command.appId,
        });
        return yield* failed(command.jobId, installReasons.invalidCommand);
      }
      if (current !== undefined) {
        if (current.jobId === command.jobId)
          return yield* Effect.logInfo("InstallGame for the running job", {
            jobId: command.jobId,
          });
        yield* Effect.logWarning("Installer busy", {
          jobId: command.jobId,
          running: current.jobId,
        });
        return yield* failed(command.jobId, installReasons.busy);
      }
      // Игра качается в INSTALL_SCRATCH_DIR (та же ФС, что библиотека), клиент
      // Steam установщика пишет в SCRATCH_DIR: запас нужен на обеих ФС.
      const scratchRoot = Option.getOrElse(config.installScratchDir, () => "");
      for (const dir of [scratchRoot, config.scratchDir])
        if (!(yield* hasFreeSpace(freeSpace, dir, config.minFreeGb)))
          return yield* failed(command.jobId, installReasons.noSpace);
      const job: Job = {
        jobId: command.jobId,
        appId: command.appId,
        userId: command.userId,
        profile: command.profile,
        steamLogin: command.steamLogin,
        steamLoginTimeoutSeconds: command.steamLoginTimeoutSeconds,
        name: installContainerName(command.jobId),
        overlays: installLayers(config, command.jobId),
        cancelRequested: yield* Deferred.make<void>(),
        phase: "downloading",
        seeded: false,
      };
      current = job;
      yield* Effect.logInfo("InstallGame accepted", {
        jobId: job.jobId,
        appId: job.appId,
        profileVersion: job.profile?.version ?? null,
      });
      yield* Effect.forkIn(lifecycle(job), scope);
    });

  const cancel = (jobId: string) =>
    Effect.gen(function* () {
      if (!isValidId(jobId))
        return yield* Effect.logError(
          "Ignored CancelInstall with an invalid jobId",
          { jobId },
        );
      if (current?.jobId === jobId) {
        if (current.phase === "finishing")
          return yield* Effect.logInfo(
            "CancelInstall after the download finished: completing",
            { jobId },
          );
        yield* Deferred.succeed(current.cancelRequested, undefined);
        return;
      }
      // Неизвестная задача (уже закончилась или не начиналась): оркестратору
      // нужен итог — установки здесь нет.
      yield* failed(jobId, installReasons.cancelled);
    });

  /**
   * Установки прошлого запуска агента не продолжаются: контейнеры `cg.install`,
   * их тома и каталоги `<INSTALL_SCRATCH_DIR>/<jobId>` (apps) и
   * `<SCRATCH_DIR>/.install/<jobId>` (клиент) удаляются (оркестратор пометит
   * задачи failed по `installs`). Каталоги сессий `<SCRATCH_DIR>/<id>` не
   * читаются и не трогаются.
   */
  const reconcile = Effect.gen(function* () {
    const ids = new Set<string>();
    for (const container of yield* docker.listByLabel(INSTALL_LABEL)) {
      yield* Effect.logInfo("Removing leftover installer container", {
        name: container.name,
      });
      yield* docker.remove(container.name).pipe(
        Effect.catchTag("DockerError", (error) =>
          Effect.logWarning("Removing leftover installer failed", {
            name: container.name,
            error: error.message,
          }),
        ),
      );
      const id = container.labels[INSTALL_LABEL] ?? "";
      if (isValidId(id)) ids.add(id);
    }
    for (const volume of yield* docker.listVolumes(INSTALL_LABEL)) {
      const id = volume.labels[INSTALL_LABEL] ?? "";
      if (isValidId(id)) ids.add(id);
    }
    const roots = [
      Option.getOrElse(config.installScratchDir, () => ""),
      join(config.scratchDir, INSTALL_CLIENT_DIR),
    ];
    for (const root of roots) {
      const dirs = yield* Effect.try(() =>
        readdirSync(root, { withFileTypes: true }),
      ).pipe(
        Effect.catch((error) =>
          (isMissing(error)
            ? Effect.void
            : Effect.logWarning("Reading an install scratch dir failed", {
                dir: root,
                error: String(error),
              })
          ).pipe(Effect.as([])),
        ),
      );
      for (const dir of dirs)
        if (dir.isDirectory() && isValidId(dir.name)) ids.add(dir.name);
    }
    for (const id of ids) {
      yield* Effect.logInfo("Removing leftover install layers", { jobId: id });
      const overlays = installLayers(config, id);
      // Агент мог упасть посреди старта: тома держит помощник hold (иначе 409).
      yield* docker.remove(holdName(overlays)).pipe(
        Effect.catchTag("DockerError", (error) =>
          Effect.logWarning("Removing helper container failed", {
            name: holdName(overlays),
            error: error.message,
          }),
        ),
      );
      yield* cleanupLogged(overlays);
    }
  });

  yield* reconcile;

  return {
    install,
    cancel,
    running: () => (current === undefined ? [] : [current.jobId]),
    reports,
  } satisfies InstallerShape;
});

/** Агент без роли gamestore: установок не ведёт, команды — защитный отказ. */
const disabled = Effect.gen(function* () {
  const reports = yield* Queue.unbounded<AgentReport>();
  return {
    install: (command) =>
      Effect.logWarning("InstallGame on an agent without role gamestore", {
        jobId: command.jobId,
      }).pipe(
        Effect.andThen(
          Queue.offer(reports, {
            _tag: "InstallFailed",
            jobId: command.jobId,
            reason: installReasons.notGamestore,
          }),
        ),
        Effect.asVoid,
      ),
    cancel: (jobId) =>
      Effect.logWarning("CancelInstall on an agent without role gamestore", {
        jobId,
      }),
    running: () => [],
    reports,
  } satisfies InstallerShape;
});

export class Installer extends Context.Service<Installer, InstallerShape>()(
  "@cg/agent/Installer",
) {
  /**
   * С ролью gamestore — убирает установки прошлого запуска (Docker недоступен —
   * ошибка слоя) и принимает команды; без неё — только отказывает.
   */
  static readonly layer: Layer.Layer<Installer, DockerError, Services> =
    Layer.effect(
      Installer,
      Effect.gen(function* () {
        const config = yield* AgentConfig;
        return config.roles.includes("gamestore")
          ? yield* make
          : yield* disabled;
      }),
    );
}
