// Запись входа в Steam (спека §4/§5.3) в дом созданного, ещё не запущенного
// контейнера: `applyLoginSeed` (Task 2) собирает четыре файла из текущего
// содержимого (нет файла — пропуск, начинаем с пустого) и посеянного входа,
// один `putArchive` кладёт их в `/home/ubuntu` с правами и владельцем, которых
// ждёт клиент Steam. Нечитаемый файл — предупреждение в лог; `config.vdf` тогда
// не трогаем (в нём и прочие настройки клиента), остальные три — с нуля.
// Там же — параметры запуска игры (`LaunchOptions` в `localconfig.vdf`, спека
// 2026-10-29 §4.2): обёртка `cg-game-exit` до старта Steam и её снятие перед
// сохранением профиля.
import type { SteamLoginSeed } from "@cg/rpc";
import { Clock, Data, Effect, Redacted } from "effect";
import { DockerClient, DockerError, isGone } from "../DockerClient";
import { extractSingleFile, filesTar, ProfileCorrupt } from "../profile/codec";
import { HOME_DIR } from "../profile/HomeProfile";
import { applyLoginSeed, clearLogin, LOGIN_FILES } from "./loginSeed";
import { formatVdf, getPath, parseVdf, setPath } from "./vdf";

/**
 * Посев входа не удался (чтение или запись файлов в контейнере). `message`
 * собран из кодов/путей Docker и причин повреждения архива — токен и имя
 * аккаунта в него никогда не попадают.
 */
export class SeedError extends Data.TaggedError("SeedError")<{
  readonly message: string;
}> {}

/** Имя записи в tar для файла по пути `relPath` (Docker отдаёт только basename). */
const entryName = (relPath: string) =>
  relPath.slice(relPath.lastIndexOf("/") + 1);

/** Каталоги-родители четырёх файлов входа (спека §5.3: права — как у профиля). */
const PARENT_DIRS = [
  ".local",
  ".local/share",
  ".local/share/Steam",
  ".local/share/Steam/config",
  ".steam",
] as const;

/** Владелец всех записей архива (пользователь `ubuntu` в контейнере). */
const OWNER = { uid: 1000, gid: 1000 } as const;

type LoginFile = keyof typeof LOGIN_FILES;

/** `DockerError`/повреждённый архив → `SeedError`, без содержимого файлов в сообщении. */
const toSeedError = (error: DockerError | ProfileCorrupt): SeedError =>
  error._tag === "DockerError"
    ? new SeedError({
        message: `${error.operation} failed${
          error.status === undefined ? "" : ` (${error.status})`
        }: ${error.message}`,
      })
    : new SeedError({
        message: `unexpected file content: ${error.reason}`,
      });

/** Текст файла дома контейнера; нет файла — `undefined`. */
const readHomeFile = (container: string, relPath: string) =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    return yield* docker.getArchive(container, `${HOME_DIR}/${relPath}`).pipe(
      Effect.map((tar): Uint8Array | undefined => tar),
      Effect.catchIf(isGone, () => Effect.succeed(undefined)),
      Effect.flatMap((tar) =>
        tar === undefined
          ? Effect.succeed(undefined)
          : extractSingleFile(tar, entryName(relPath)).pipe(
              Effect.map((bytes) => new TextDecoder().decode(bytes)),
            ),
      ),
    );
  });

/**
 * Читает четыре файла входа из `container` (нет файла — не ошибка, пустая
 * запись; есть, но не разбирается — попадает в `current` как есть, ключ — в
 * `unreadable`, и в лог уходит предупреждение с именем файла, не содержимым).
 * Общее чтение для `seedSteamLogin` и `clearSteamLogin`.
 */
const readLoginFiles = (
  container: string,
): Effect.Effect<
  {
    readonly current: Partial<Record<LoginFile, string>>;
    readonly unreadable: ReadonlySet<LoginFile>;
  },
  SeedError,
  DockerClient
> =>
  Effect.gen(function* () {
    const keys = Object.keys(LOGIN_FILES) as Array<LoginFile>;
    const current: Partial<Record<LoginFile, string>> = {};
    const unreadable = new Set<LoginFile>();
    for (const key of keys) {
      const text = yield* readHomeFile(container, LOGIN_FILES[key]);
      if (text === undefined) continue;
      current[key] = text;
      if (parseVdf(text) === undefined) {
        unreadable.add(key);
        yield* Effect.logWarning("Steam login file unreadable", { file: key });
      }
    }
    return { current, unreadable };
  }).pipe(Effect.mapError(toSeedError));

/**
 * Вписывает вход §4 в `container` (созданный, не запущенный): читает четыре
 * файла (нет файла — не ошибка, начинаем с пустого дерева), собирает их
 * `applyLoginSeed` и кладёт одним архивом в `/home/ubuntu` — каталоги-родители
 * 0700, файлы 0600, владелец 1000:1000. Файл есть, но не разбирается —
 * `logWarning` с ключом файла (не содержимым); нечитаемый `config.vdf` в архив
 * не попадает и остаётся как был, остальные пересобираются с нуля.
 */
export const seedSteamLogin = (options: {
  readonly container: string;
  readonly seed: SteamLoginSeed;
}): Effect.Effect<void, SeedError, DockerClient> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    const { current, unreadable } = yield* readLoginFiles(options.container);

    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const files = applyLoginSeed(
      current,
      {
        accountName: Redacted.value(options.seed.accountName),
        steamId: options.seed.steamId,
        token: Redacted.value(options.seed.refreshToken),
      },
      now,
    );

    const keys = Object.keys(LOGIN_FILES) as Array<LoginFile>;
    const encoder = new TextEncoder();
    const tar = filesTar(
      [
        ...PARENT_DIRS.map((path) => ({ path, mode: 0o700 })),
        ...keys
          .filter((key) => !(key === "config" && unreadable.has(key)))
          .map((key) => ({
            path: LOGIN_FILES[key],
            data: encoder.encode(files[key]),
            mode: 0o600,
          })),
      ],
      { ...OWNER, mtime: now },
    );
    yield* docker
      .putArchive(options.container, HOME_DIR, tar)
      .pipe(Effect.mapError(toSeedError));
  });

/**
 * Стирает вход §4 из `container`: читает те же четыре файла, что
 * `seedSteamLogin` (нечитаемый — предупреждение в лог с ключом файла, без
 * содержимого), чистит их `clearLogin` (нечитаемые `localVdf`/`loginUsers`/
 * `registry` всё равно пересобираются с нуля — в них мог остаться токен,
 * который наш парсер не распознал; нечитаемый `config.vdf` не трогается) и
 * кладёт изменённые одним архивом — те же права и владелец, что при посеве.
 * Файлов входа в контейнере нет — `putArchive` не вызывается.
 */
export const clearSteamLogin = (options: {
  readonly container: string;
}): Effect.Effect<void, SeedError, DockerClient> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    const { current } = yield* readLoginFiles(options.container);
    const cleared = Object.entries(clearLogin(current)) as Array<
      [LoginFile, string]
    >;
    if (cleared.length === 0) return;

    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const encoder = new TextEncoder();
    const tar = filesTar(
      [
        ...PARENT_DIRS.map((path) => ({ path, mode: 0o700 })),
        ...cleared.map(([key, text]) => ({
          path: LOGIN_FILES[key],
          data: encoder.encode(text),
          mode: 0o600,
        })),
      ],
      { ...OWNER, mtime: now },
    );
    yield* docker
      .putArchive(options.container, HOME_DIR, tar)
      .pipe(Effect.mapError(toSeedError));
  });

/**
 * Обёртка процесса игры в образе сессии (спека 2026-10-29 §4.2): пишет код
 * выхода игры в `/tmp/cg-game-exit`.
 */
export const GAME_EXIT_WRAPPER = "/usr/local/bin/cg-game-exit";
const WRAPPER_PREFIX = `${GAME_EXIT_WRAPPER} `;
const COMMAND = "%command%";

/**
 * Параметры запуска игры с обёрткой в начале: параметры игрока с `%command%`
 * — после обёртки как есть, без него (Steam дописывает их в конец команды) —
 * после `%command%`. Уже с обёрткой (прошлое снятие не удалось) — как есть.
 */
export const wrapLaunchOptions = (original: string | undefined): string => {
  const options = original ?? "";
  if (options.startsWith(WRAPPER_PREFIX)) return options;
  if (options.includes(COMMAND)) return `${WRAPPER_PREFIX}${options}`;
  return options === ""
    ? `${WRAPPER_PREFIX}${COMMAND}`
    : `${WRAPPER_PREFIX}${COMMAND} ${options}`;
};

/**
 * Обратное `wrapLaunchOptions`: исходные параметры игрока; без обёртки —
 * `undefined` (трогать нечего). Без памяти о записанном (переживает
 * перезапуск агента), поэтому `%command% -x` игрока вернётся как `-x` — для
 * Steam это те же параметры.
 */
export const unwrapLaunchOptions = (value: string): string | undefined => {
  if (!value.startsWith(WRAPPER_PREFIX)) return undefined;
  const rest = value.slice(WRAPPER_PREFIX.length);
  if (rest === COMMAND) return "";
  const tail = rest.startsWith(`${COMMAND} `)
    ? rest.slice(COMMAND.length + 1)
    : undefined;
  return tail !== undefined && !tail.includes(COMMAND) ? tail : rest;
};

/** SteamID64 → номер аккаунта (каталог `userdata/<accountId>`). */
const STEAM_ID64_BASE = 76561197960265728n;

const USERDATA_DIR = ".local/share/Steam/userdata";
/** Каталоги-родители `localconfig.vdf` до `userdata` включительно. */
const USERDATA_PARENTS = [
  ".local",
  ".local/share",
  ".local/share/Steam",
  USERDATA_DIR,
] as const;
const localConfigPath = (accountId: string) =>
  `${USERDATA_DIR}/${accountId}/config/localconfig.vdf`;
const launchOptionsPath = (appId: number) => [
  "UserLocalConfigStore",
  "Software",
  "Valve",
  "Steam",
  "apps",
  String(appId),
  "LaunchOptions",
];

/** Аккаунты Steam из `loginusers.vdf` контейнера (номера `userdata/<id>`). */
const accountIds = (container: string) =>
  Effect.gen(function* () {
    const text = yield* readHomeFile(container, LOGIN_FILES.loginUsers);
    const users = getPath(text === undefined ? undefined : parseVdf(text), [
      "users",
    ]);
    if (users === undefined || typeof users === "string") return [];
    return users
      .map((user) => user.key)
      .filter((steamId) => /^\d{17}$/.test(steamId))
      .map((steamId) => BigInt(steamId) - STEAM_ID64_BASE)
      .filter((id) => id > 0n && id < 2n ** 32n)
      .map(String);
  });

/**
 * Меняет `LaunchOptions` игры `appId` в `localconfig.vdf` каждого аккаунта из
 * `loginusers.vdf` контейнера: `change` получает текущее значение (нет файла
 * или ключа — `undefined`) и возвращает новое; `undefined` — не трогать.
 * Изменённые файлы — одним архивом (каталоги-родители 0700, файл 0600,
 * владелец 1000:1000); нечитаемый файл — предупреждение, не переписывается.
 */
const updateLaunchOptions = (
  container: string,
  appId: number,
  change: (current: string | undefined) => string | undefined,
): Effect.Effect<void, SeedError, DockerClient> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    const path = launchOptionsPath(appId);
    const changed: Array<{
      readonly accountId: string;
      readonly text: string;
    }> = [];
    for (const accountId of yield* accountIds(container)) {
      const text = yield* readHomeFile(container, localConfigPath(accountId));
      const tree = text === undefined ? [] : parseVdf(text);
      if (tree === undefined) {
        yield* Effect.logWarning("Steam localconfig.vdf unreadable", {
          accountId,
        });
        continue;
      }
      const current = getPath(tree, path);
      const next = change(typeof current === "string" ? current : undefined);
      if (next === undefined) continue;
      changed.push({ accountId, text: formatVdf(setPath(tree, path, next)) });
    }
    if (changed.length === 0) return;

    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const encoder = new TextEncoder();
    const tar = filesTar(
      [
        ...USERDATA_PARENTS.map((path) => ({ path, mode: 0o700 })),
        ...changed.flatMap(({ accountId, text }) => [
          { path: `${USERDATA_DIR}/${accountId}`, mode: 0o700 },
          { path: `${USERDATA_DIR}/${accountId}/config`, mode: 0o700 },
          {
            path: localConfigPath(accountId),
            data: encoder.encode(text),
            mode: 0o600,
          },
        ]),
      ],
      { ...OWNER, mtime: now },
    );
    yield* docker.putArchive(container, HOME_DIR, tar);
  }).pipe(Effect.mapError(toSeedError));

/**
 * Ставит обёртку `cg-game-exit` в параметры запуска игры `appId` (спека
 * 2026-10-29 §4.2) в созданном, не запущенном `container`: в
 * `localconfig.vdf` каждого аккаунта из `loginusers.vdf` (нет файла —
 * создаётся). Параметры игрока остаются после обёртки; снимает их
 * `clearLaunchOptions` перед сохранением профиля. В образе нет обёртки —
 * предупреждение, а обёртка, оставшаяся в параметрах от прошлых сессий,
 * снимается (как `clearLaunchOptions`): откат образа безопасно выключает
 * обёртку, иначе Steam не запустил бы игру вовсе.
 */
export const setLaunchOptions = (options: {
  readonly container: string;
  readonly appId: number;
}): Effect.Effect<void, SeedError, DockerClient> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    // Образ без обёртки (собран до неё): с ней в параметрах Steam не запустил
    // бы игру вовсе.
    const inImage = yield* docker
      .archiveSize(options.container, GAME_EXIT_WRAPPER)
      .pipe(
        Effect.as(true),
        Effect.catchIf(isGone, () => Effect.succeed(false)),
        Effect.mapError(toSeedError),
      );
    if (!inImage) {
      yield* Effect.logWarning("Session image has no cg-game-exit", {
        container: options.container,
      });
      return yield* updateLaunchOptions(
        options.container,
        options.appId,
        (current) =>
          current === undefined ? undefined : unwrapLaunchOptions(current),
      );
    }
    yield* updateLaunchOptions(options.container, options.appId, (current) => {
      const wrapped = wrapLaunchOptions(current);
      return wrapped === current ? undefined : wrapped;
    });
  });

/**
 * Снимает обёртку `setLaunchOptions` (Steam уже закрыт): параметры запуска
 * игры `appId` — снова исходные параметры игрока, чтобы обёртка не попала в
 * его профиль. Без обёртки — файл не трогается.
 */
export const clearLaunchOptions = (options: {
  readonly container: string;
  readonly appId: number;
}): Effect.Effect<void, SeedError, DockerClient> =>
  updateLaunchOptions(options.container, options.appId, (current) =>
    current === undefined ? undefined : unwrapLaunchOptions(current),
  );
