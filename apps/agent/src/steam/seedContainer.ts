// Запись входа в Steam (спека §4/§5.3) в дом созданного, ещё не запущенного
// контейнера: `applyLoginSeed` (Task 2) собирает четыре файла из текущего
// содержимого (нет файла — пропуск, начинаем с пустого) и посеянного входа,
// один `putArchive` кладёт их в `/home/ubuntu` с правами и владельцем, которых
// ждёт клиент Steam. Нечитаемый файл — предупреждение в лог; `config.vdf` тогда
// не трогаем (в нём и прочие настройки клиента), остальные три — с нуля.
import type { SteamLoginSeed } from "@cg/rpc";
import { Clock, Data, Effect, Redacted } from "effect";
import { DockerClient, DockerError, isGone } from "../DockerClient";
import { extractSingleFile, filesTar, ProfileCorrupt } from "../profile/codec";
import { HOME_DIR } from "../profile/HomeProfile";
import { applyLoginSeed, clearLogin, LOGIN_FILES } from "./loginSeed";
import { parseVdf } from "./vdf";

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
    const docker = yield* DockerClient;

    /** Текущее содержимое файла входа; файла нет — `undefined` (не ошибка). */
    const readLoginFile = (relPath: string) =>
      docker.getArchive(container, `${HOME_DIR}/${relPath}`).pipe(
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

    const keys = Object.keys(LOGIN_FILES) as Array<LoginFile>;
    const current: Partial<Record<LoginFile, string>> = {};
    const unreadable = new Set<LoginFile>();
    for (const key of keys) {
      const text = yield* readLoginFile(LOGIN_FILES[key]);
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
 * Стирает вход §4 из `container` (спека admin-part3 §Task2): читает те же
 * четыре файла, что `seedSteamLogin`, оставляет только те, что есть и
 * разбираются (`clearLogin`), и кладёт изменённые одним архивом — те же права
 * и владелец, что при посеве. Файлов входа в контейнере нет (или ни один не
 * разобрался) — `putArchive` не вызывается.
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
