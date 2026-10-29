// Профиль пользователя в доме контейнера (сессии, установщика — Task 4):
// восстановление в созданный, ещё не запущенный контейнер и сохранение при
// остановке. Состав профиля — whitelist скрипта образа `cg-profile-pack`.
import type { ProfileRef } from "@cg/rpc";
import { Duration, Effect, Schema } from "effect";
import { AgentConfig } from "../config";
import { DockerClient, DockerError } from "../DockerClient";
import { helperSpec, runHelper } from "../Helper";
import { extractSingleFile, type ProfileCorrupt } from "./codec";
import { ProfileCommitter } from "./ProfileCommitter";
import { ProfileStore } from "./ProfileStore";

export const HOME_DIR = "/home/ubuntu";
/** Куда `cg-profile-pack` пишет архив профиля в контейнере. */
export const PACK_OUTPUT = "/tmp/cg-profile.tar";
/** Имя записи в tar, который Docker отдаёт для `PACK_OUTPUT`. */
const PACK_ENTRY = "cg-profile.tar";
export const PROFILE_PACK = "/usr/local/bin/cg-profile-pack";
export const STEAM_SHUTDOWN = "/usr/local/bin/cg-steam-shutdown";
/**
 * Таймаут упаковки профиля и выгрузки архива из контейнера: большой дом
 * (`.config`, сохранения Proton) не укладывается в обычные 60 с запроса.
 */
export const PACK_TIMEOUT = Duration.minutes(10);

/**
 * Предел упакованного профиля (`/tmp/cg-profile.tar`): агент держит архив в
 * памяти несколько раз (выгрузка, gzip, шифрование) при `mem_limit` 1g.
 * Больше — архив не загружается: сохранение не удалось (контейнер остаётся,
 * `profile-unsaved`), импорт старого тома — сбой запуска.
 */
export const PROFILE_MAX_BYTES = 200 * 1024 * 1024;

const MiB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0);

/**
 * Размер `PACK_OUTPUT` в `container` (и в остановленном) до его выгрузки; больше
 * `PROFILE_MAX_BYTES` — `ProfileError` шага `size` с размером в сообщении.
 */
const checkPackedSize = (container: string) =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    const size = yield* docker
      .archiveSize(container, PACK_OUTPUT)
      .pipe(Effect.mapError(failed("size")));
    if (size > PROFILE_MAX_BYTES)
      return yield* new ProfileError({
        stage: "size",
        message: `profile archive is ${size} bytes (${MiB(size)} MiB), limit ${MiB(PROFILE_MAX_BYTES)} MiB`,
      });
    return size;
  });

/** Старый (MVP-2) том дома: только читается, один раз — для импорта профиля. */
export const legacyVolume = (userId: string) => `cg-home-${userId}`;

/**
 * Профиль не восстановлен/не сохранён. `stage` — шаг: `get`, `import`, `restore`
 * (восстановление); `pack`, `export`, `upload`, `commit` (сохранение); `size` —
 * архив больше `PROFILE_MAX_BYTES` (и при импорте, и при сохранении).
 */
export class ProfileError extends Schema.TaggedError<ProfileError>()(
  "ProfileError",
  {
    stage: Schema.String,
    message: Schema.String,
  },
) {}

const failed =
  (stage: string) =>
  (error: { readonly message: string }): ProfileError =>
    new ProfileError({ stage, message: error.message });

/** Архив профиля из `GET /archive` не тот (`ProfileCorrupt`) — как ошибка Docker. */
const unpack = (tar: Uint8Array) =>
  extractSingleFile(tar, PACK_ENTRY).pipe(
    Effect.mapError(
      (error: ProfileCorrupt) =>
        new DockerError({ operation: "getArchive", message: error.reason }),
    ),
  );

/** Откуда взят дом: объект профиля, старый том или пустой (первый вход по QR). */
export type RestoredFrom = "profile" | "legacy" | "empty";

/**
 * Tar профиля из старого тома `cg-home-<userId>`: помощник образа сессии с этим
 * томом read-only в `/home/ubuntu` запускает `cg-profile-pack` (uid 1000, без
 * GPU и сети), архив забирается после его выхода (больше `PROFILE_MAX_BYTES` —
 * `ProfileError` шага `size`, не загружается). Том не изменяется.
 */
export const importLegacy = (options: {
  readonly userId: string;
  readonly helperName: string;
}) =>
  Effect.gen(function* () {
    const config = yield* AgentConfig;
    const docker = yield* DockerClient;
    return yield* runHelper(
      helperSpec(config, {
        name: options.helperName,
        kind: "import",
        user: "1000",
        entrypoint: [PROFILE_PACK],
        env: { HOME: HOME_DIR },
        mounts: [
          {
            volume: legacyVolume(options.userId),
            target: HOME_DIR,
            readOnly: true,
          },
        ],
      }),
      checkPackedSize(options.helperName).pipe(
        Effect.andThen(
          docker.getArchive(options.helperName, PACK_OUTPUT, {
            timeout: PACK_TIMEOUT,
          }),
        ),
      ),
    ).pipe(Effect.flatMap(unpack));
  });

/**
 * Кладёт профиль в созданный (не запущенный) `container`: объект
 * `profile.objectKey`; профиля нет, но есть старый том — импорт из него; иначе
 * ничего (пустой дом). Помощник импорта — `<container>-import`.
 */
export const restoreProfile = (options: {
  readonly container: string;
  readonly userId: string;
  readonly profile: ProfileRef | null;
}): Effect.Effect<
  RestoredFrom,
  ProfileError,
  AgentConfig | DockerClient | ProfileStore
> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    const store = yield* ProfileStore;
    let tar: Uint8Array;
    let from: RestoredFrom;
    if (options.profile !== null) {
      tar = yield* store
        .get(options.profile.objectKey)
        .pipe(Effect.mapError(failed("get")));
      from = "profile";
    } else {
      const legacy = yield* docker
        .volumeExists(legacyVolume(options.userId))
        .pipe(Effect.mapError(failed("import")));
      if (!legacy) return "empty";
      tar = yield* importLegacy({
        userId: options.userId,
        helperName: `${options.container}-import`,
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "ProfileError" ? error : failed("import")(error),
        ),
      );
      from = "legacy";
    }
    yield* docker
      .putArchive(options.container, HOME_DIR, tar)
      .pipe(Effect.mapError(failed("restore")));
    return from;
  });

/**
 * Снимает профиль с запущенного `container` и фиксирует новую версию: Steam
 * закрывается штатно (`cg-steam-shutdown`; не вышло — только предупреждение),
 * `cg-profile-pack` → размер (не больше `PROFILE_MAX_BYTES`) → архив →
 * шифрование и загрузка → `agent.profileCommit` от
 * `baseVersion`. Отклонён (база устарела) — загруженный объект удаляется, и это
 * тоже `ProfileError` (шаг `commit`): прогресс сессии не сохранён, её контейнер
 * нужно оставить, как при любом другом сбое (`profile-unsaved`).
 */
export const saveProfile = (options: {
  readonly container: string;
  readonly userId: string;
  readonly baseVersion: number | null;
  /** Вход в Steam §4 был вписан в этот запуск (Task 3, `seedSteamLogin`). */
  readonly steamLoginSeeded: boolean;
  /**
   * Момент сброса входа Steam админом (`steamLoginResetAt` команды), если
   * агент стёр вход в этом запуске (`clearSteamLogin`, admin-part3 Task 2);
   * нет — стирания не было, поле в коммит не попадает.
   */
  readonly steamLoginResetAt?: string;
  /**
   * Шаг между закрытием Steam и упаковкой профиля (сессия: снять обёртку
   * `cg-game-exit` с параметров запуска игры); его сбои он обрабатывает сам.
   */
  readonly beforePack?: Effect.Effect<void, never, DockerClient>;
}): Effect.Effect<
  void,
  ProfileError,
  DockerClient | ProfileStore | ProfileCommitter
> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    const store = yield* ProfileStore;
    const committer = yield* ProfileCommitter;
    const log = { container: options.container, userId: options.userId };

    yield* docker.exec(options.container, [STEAM_SHUTDOWN]).pipe(
      Effect.flatMap(({ exitCode }) =>
        exitCode === 0
          ? Effect.void
          : Effect.logWarning("Steam did not shut down cleanly", {
              ...log,
              exitCode,
            }),
      ),
      Effect.catchTag("DockerError", (error: DockerError) =>
        Effect.logWarning("Steam shutdown failed", {
          ...log,
          error: error.message,
        }),
      ),
    );

    if (options.beforePack !== undefined) yield* options.beforePack;

    const { exitCode } = yield* docker
      .exec(options.container, [PROFILE_PACK], { timeout: PACK_TIMEOUT })
      .pipe(Effect.mapError(failed("pack")));
    if (exitCode !== 0)
      return yield* new ProfileError({
        stage: "pack",
        message: `cg-profile-pack exited with ${exitCode}`,
      });
    yield* checkPackedSize(options.container);
    const tar = yield* docker
      .getArchive(options.container, PACK_OUTPUT, { timeout: PACK_TIMEOUT })
      .pipe(Effect.flatMap(unpack), Effect.mapError(failed("export")));

    const { objectKey, sizeBytes } = yield* store
      .put(options.userId, tar)
      .pipe(Effect.mapError(failed("upload")));
    const accepted = yield* committer
      .commit({
        userId: options.userId,
        baseVersion: options.baseVersion,
        objectKey,
        sizeBytes,
        steamLoginSeeded: options.steamLoginSeeded,
        ...(options.steamLoginResetAt !== undefined
          ? { steamLoginResetAt: options.steamLoginResetAt }
          : {}),
      })
      .pipe(Effect.mapError(failed("commit")));
    if (!accepted) {
      yield* Effect.logWarning("Profile commit rejected: stale base version", {
        ...log,
        baseVersion: options.baseVersion,
      });
      yield* store.remove(objectKey).pipe(
        Effect.catchTag("ProfileStoreError", (error) =>
          Effect.logWarning("Removing rejected profile object failed", {
            ...log,
            objectKey,
            error: error.message,
          }),
        ),
      );
      return yield* new ProfileError({
        stage: "commit",
        message: "rejected: stale base version",
      });
    }
  });
