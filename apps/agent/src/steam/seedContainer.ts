// Запись входа в Steam (спека §4/§5.3) в дом созданного, ещё не запущенного
// контейнера: `applyLoginSeed` (Task 2) собирает четыре файла из текущего
// содержимого (нет файла — пропуск, начинаем с пустого) и посеянного входа,
// один `putArchive` кладёт их в `/home/ubuntu` с правами и владельцем, которых
// ждёт клиент Steam.
import type { SteamLoginSeed } from "@cg/rpc";
import { Clock, Data, Effect, Redacted } from "effect";
import { DockerClient, isGone } from "../DockerClient";
import { extractSingleFile, filesTar } from "../profile/codec";
import { HOME_DIR } from "../profile/HomeProfile";
import { applyLoginSeed, LOGIN_FILES } from "./loginSeed";

/**
 * Посев входа не удался (чтение или запись файлов в контейнере). `message`
 * собран из кодов/путей Docker и причин повреждения архива — токен и имя
 * аккаунта в него никогда не попадают.
 */
export class SeedError extends Data.TaggedError("SeedError")<{
  readonly message: string;
}> {}

/** Имя записи в tar для файла по пути `relPath` (Docker отдаёт только basename). */
const entryName = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1);

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

/**
 * Вписывает вход §4 в `container` (созданный, не запущенный): читает четыре
 * файла (нет файла — не ошибка, начинаем с пустого дерева), собирает их
 * `applyLoginSeed` и кладёт одним архивом в `/home/ubuntu` — каталоги-родители
 * 0700, файлы 0600, владелец 1000:1000.
 */
export const seedSteamLogin = (options: {
  readonly container: string;
  readonly seed: SteamLoginSeed;
}): Effect.Effect<void, SeedError, DockerClient> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;

    /** Текущее содержимое файла входа; файла нет — `undefined` (не ошибка). */
    const readLoginFile = (relPath: string) =>
      docker.getArchive(options.container, `${HOME_DIR}/${relPath}`).pipe(
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

    const current: Partial<Record<keyof typeof LOGIN_FILES, string>> = {};
    for (const key of Object.keys(LOGIN_FILES) as Array<
      keyof typeof LOGIN_FILES
    >) {
      const text = yield* readLoginFile(LOGIN_FILES[key]);
      if (text !== undefined) current[key] = text;
    }

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

    const encoder = new TextEncoder();
    const tar = filesTar(
      [
        ...PARENT_DIRS.map((path) => ({ path, mode: 0o700 })),
        ...(Object.keys(LOGIN_FILES) as Array<keyof typeof LOGIN_FILES>).map(
          (key) => ({
            path: LOGIN_FILES[key],
            data: encoder.encode(files[key]),
            mode: 0o600,
          }),
        ),
      ],
      { ...OWNER, mtime: now },
    );
    yield* docker.putArchive(options.container, HOME_DIR, tar);
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "DockerError"
        ? new SeedError({
            message: `${error.operation} failed${
              error.status === undefined ? "" : ` (${error.status})`
            }: ${error.message}`,
          })
        : new SeedError({
            message: `unexpected file content: ${error.reason}`,
          }),
    ),
  );
