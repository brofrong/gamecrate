// Свободное место на ФС scratch: сессии и установки пишут upper-слои на общий
// диск хоста, поэтому перед стартом агент проверяет запас (`MIN_FREE_GB`).
import { statfs } from "node:fs/promises";
import { Context, Effect, Schema } from "effect";

/** `statfs` каталога не удался. */
export class DiskSpaceError extends Schema.TaggedError<DiskSpaceError>()(
  "DiskSpaceError",
  {
    dir: Schema.String,
    message: Schema.String,
  },
) {}

export type FreeSpaceShape = (
  dir: string,
) => Effect.Effect<number, DiskSpaceError>;

/** Байты, доступные непривилегированному пользователю на ФС `dir` (`statfs`). */
export const statfsFreeBytes: FreeSpaceShape = (dir) =>
  Effect.tryPromise({
    try: async () => {
      const stats = await statfs(dir);
      return stats.bavail * stats.bsize;
    },
    catch: (cause) =>
      new DiskSpaceError({
        dir,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/** Как мерить свободное место (по умолчанию — `statfs`; тесты подменяют). */
export const FreeSpace = Context.Reference<FreeSpaceShape>(
  "@cg/agent/FreeSpace",
  { defaultValue: () => statfsFreeBytes },
);

const GiB = 1024 * 1024 * 1024;

/**
 * Хватает ли места на ФС `dir`: свободно не меньше `minFreeGb` ГиБ. Мало —
 * `false` и ошибка в логе; измерить не удалось — предупреждение и `true` (сбой
 * `statfs` не должен останавливать все запуски).
 */
export const hasFreeSpace = (
  freeSpace: FreeSpaceShape,
  dir: string,
  minFreeGb: number,
): Effect.Effect<boolean> =>
  freeSpace(dir).pipe(
    Effect.flatMap((freeBytes) =>
      freeBytes >= minFreeGb * GiB
        ? Effect.succeed(true)
        : Effect.logError("Not enough free disk space", {
            dir,
            freeGb: Number((freeBytes / GiB).toFixed(1)),
            minFreeGb,
          }).pipe(Effect.as(false)),
    ),
    Effect.catchTag("DiskSpaceError", (error) =>
      Effect.logWarning("Measuring free disk space failed", {
        dir: error.dir,
        error: error.message,
      }).pipe(Effect.as(true)),
    ),
  );
