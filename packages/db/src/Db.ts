// Effect-сервис Db: Drizzle Effect-БД (drizzle-orm/effect-postgres) поверх @effect/sql-pg.
import { PgClient } from "@effect/sql-pg";
import {
  makeWithDefaults,
  type EffectPgDatabase,
} from "drizzle-orm/effect-postgres";
import { Config, Context, Layer } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/** Drizzle-БД для запросов: `yield* db.select().from(user)` и т. п. */
export type Database = EffectPgDatabase & {
  readonly $client: PgClient.PgClient;
};

export class Db extends Context.Service<Db, Database>()("@cg/db/Db") {
  /** Db поверх уже предоставленного PgClient (например, временной тестовой БД). */
  static readonly layerFromPgClient: Layer.Layer<Db, never, PgClient.PgClient> =
    Layer.effect(Db, makeWithDefaults());

  /** Боевой слой: пул соединений к `DATABASE_URL`. */
  static readonly layer: Layer.Layer<Db, Config.ConfigError | SqlError> =
    Db.layerFromPgClient.pipe(
      Layer.provide(
        PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }),
      ),
    );
}
