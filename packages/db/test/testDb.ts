// Тестовая БД: на сервере из TEST_DATABASE_URL создаётся временная база cg_test_<random>,
// к ней применяются миграции; при закрытии scope база удаляется.
import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Layer, Redacted } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { Db } from "../src/Db";
import { runMigrations } from "../src/migrate";

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
