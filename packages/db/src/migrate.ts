// Миграции схемы: SQL из packages/db/migrations (генерирует `bunx drizzle-kit generate`).
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Effect, Schema } from "effect";
import { Db } from "./Db";

/** Абсолютный путь к папке миграций пакета. */
export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export class MigrationError extends Schema.TaggedError<MigrationError>()(
  "MigrationError",
  {
    cause: Schema.Defect(),
  },
) {}

/** Применяет все ещё не применённые миграции к БД из сервиса Db. */
export const runMigrations: Effect.Effect<void, MigrationError, Db> =
  Effect.gen(function* () {
    const db = yield* Db;
    // migrate() читает файлы миграций синхронно — ошибки чтения тоже превращаем в MigrationError.
    const migration = yield* Effect.try({
      try: () => migrate(db, { migrationsFolder }),
      catch: (cause) => new MigrationError({ cause }),
    });
    yield* migration.pipe(
      Effect.mapError((cause) => new MigrationError({ cause })),
    );
  });
