// Профиль пользователя в доме контейнера (сессии, установщика — Task 4):
// восстановление в созданный, ещё не запущенный контейнер и сохранение при
// остановке. Состав профиля — whitelist скрипта образа `cg-profile-pack`.
import type { ProfileRef } from "@cg/rpc";
import { Effect, Schema } from "effect";
import { AgentConfig } from "../config";
import { DockerClient, type DockerError } from "../DockerClient";
import { helperSpec, runHelper } from "../Helper";
import { extractSingleFile } from "./codec";
import { ProfileCommitter } from "./ProfileCommitter";
import { ProfileStore } from "./ProfileStore";

export const HOME_DIR = "/home/ubuntu";
/** Куда `cg-profile-pack` пишет архив профиля в контейнере. */
export const PACK_OUTPUT = "/tmp/cg-profile.tar";
export const PROFILE_PACK = "/usr/local/bin/cg-profile-pack";
export const STEAM_SHUTDOWN = "/usr/local/bin/cg-steam-shutdown";

/** Старый (MVP-2) том дома: только читается, один раз — для импорта профиля. */
export const legacyVolume = (userId: string) => `cg-home-${userId}`;

/**
 * Профиль не восстановлен/не сохранён. `stage` — шаг: `get`, `import`, `restore`
 * (восстановление); `pack`, `export`, `upload`, `commit` (сохранение).
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

/** Откуда взят дом: объект профиля, старый том или пустой (первый вход по QR). */
export type RestoredFrom = "profile" | "legacy" | "empty";

/**
 * Tar профиля из старого тома `cg-home-<userId>`: помощник образа сессии с этим
 * томом read-only в `/home/ubuntu` запускает `cg-profile-pack` (uid 1000, без
 * GPU и сети), архив забирается после его выхода. Том не изменяется.
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
      docker.getArchive(options.helperName, PACK_OUTPUT),
    ).pipe(Effect.map(extractSingleFile));
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
      }).pipe(Effect.mapError(failed("import")));
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
 * `cg-profile-pack` → архив → шифрование и загрузка → `agent.profileCommit` от
 * `baseVersion`. Отклонён (база устарела) — загруженный объект удаляется.
 * Результат — `accepted`; сбой любого шага — `ProfileError`.
 */
export const saveProfile = (options: {
  readonly container: string;
  readonly userId: string;
  readonly baseVersion: number | null;
}): Effect.Effect<
  boolean,
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

    const { exitCode } = yield* docker
      .exec(options.container, [PROFILE_PACK])
      .pipe(Effect.mapError(failed("pack")));
    if (exitCode !== 0)
      return yield* new ProfileError({
        stage: "pack",
        message: `cg-profile-pack exited with ${exitCode}`,
      });
    const tar = yield* docker
      .getArchive(options.container, PACK_OUTPUT)
      .pipe(Effect.map(extractSingleFile), Effect.mapError(failed("export")));

    const { objectKey, sizeBytes } = yield* store
      .put(options.userId, tar)
      .pipe(Effect.mapError(failed("upload")));
    const accepted = yield* committer
      .commit({
        userId: options.userId,
        baseVersion: options.baseVersion,
        objectKey,
        sizeBytes,
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
    }
    return accepted;
  });
