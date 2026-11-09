// Тестовая БД: на сервере из TEST_DATABASE_URL создаётся временная база cg_test_<random>,
// к ней применяются миграции; при закрытии scope база удаляется.
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Config, Effect, Layer, Redacted, type Scope } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { Db } from "../src/Db";
import {
  MigrationError,
  migrationsFolder,
  runMigrations,
} from "../src/migrate";

/** URL сервера (служебная БД) и URL временной тестовой базы. */
const withDatabase = (
  serverUrl: Redacted.Redacted<string>,
  database: string,
) => {
  const url = new URL(Redacted.value(serverUrl));
  url.pathname = `/${database}`;
  return Redacted.make(url.toString());
};

/** Создаёт временную базу и удаляет её при закрытии scope. Возвращает URL базы. */
const temporaryDatabase = Effect.gen(function* () {
  const serverUrl = yield* Config.Redacted("TEST_DATABASE_URL");
  const database = `cg_test_${crypto.randomUUID().replaceAll("-", "")}`;
  // Имя состоит только из [a-z0-9_], поэтому его можно подставить в DDL как есть.
  const admin = yield* PgClient.make({ url: serverUrl, maxConnections: 1 });
  yield* Effect.acquireRelease(
    admin.unsafe(`CREATE DATABASE "${database}"`),
    () =>
      admin
        .unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
        .pipe(Effect.orDie),
  );
  return withDatabase(serverUrl, database);
}).pipe(Effect.provide(Reactivity.layer));

/** PgClient к временной базе; закрывается раньше, чем база удаляется. */
const TestPgClient = PgClient.layerFrom(
  Effect.gen(function* () {
    const url = yield* temporaryDatabase;
    return yield* PgClient.make({ url });
  }),
);

/** Db на чистой мигрированной временной базе. Ошибки подготовки — дефекты. */
export const DbTest: Layer.Layer<Db> = Layer.effectDiscard(runMigrations).pipe(
  Layer.provideMerge(Db.layerFromPgClient),
  Layer.provide(TestPgClient),
  Layer.orDie,
);

/**
 * Db на чистой временной базе без единой миграции — тест сам решает, когда
 * и какие миграции прогнать (`migrateUpTo`, затем `runMigrations` на
 * остаток), чтобы проверить поведение миграции с бэкфиллом на промежуточном
 * состоянии схемы.
 */
export const DbTestUnmigrated: Layer.Layer<Db> = Db.layerFromPgClient.pipe(
  Layer.provide(TestPgClient),
  Layer.orDie,
);

/**
 * Прогоняет миграции только до каталога `name` включительно (сортировка по
 * имени, как в `readMigrationFiles` самого drizzle). Копирует нужные
 * каталоги во временную папку и чистит её по выходу из scope — отдельная
 * папка нужна, потому что drizzle сканирует всю `migrationsFolder` целиком.
 * Таблица `__drizzle_migrations` общая с `runMigrations`, так что второй
 * прогон (на полной папке) применит только то, что ещё не применено.
 */
export const migrateUpTo = (
  name: string,
): Effect.Effect<void, MigrationError, Db | Scope.Scope> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const dir = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const tmp = mkdtempSync(join(tmpdir(), "cg-migrations-"));
        for (const sub of readdirSync(migrationsFolder).sort()) {
          if (sub <= name) {
            cpSync(join(migrationsFolder, sub), join(tmp, sub), {
              recursive: true,
            });
          }
        }
        return tmp;
      }),
      (tmp) => Effect.sync(() => rmSync(tmp, { recursive: true, force: true })),
    );
    const migration = yield* Effect.try({
      try: () => migrate(db, { migrationsFolder: dir }),
      catch: (cause) => new MigrationError({ cause }),
    });
    yield* migration.pipe(
      Effect.mapError((cause) => new MigrationError({ cause })),
    );
  });
