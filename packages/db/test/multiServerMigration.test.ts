// Миграция «регионы, учётные данные серверов, библиотека игр по серверам»
// (Task 1, спека §5): библиотека (`gamestore_apps`) становится своей у
// каждого сервера, а не общей. Проверяем бэкфилл `worker_id` на реальном
// переходе схемы — накатываем миграции до предыдущей, вставляем данные в
// старую форму таблицы, затем докатываем остаток и смотрим на результат.
import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Effect, Exit, type Scope } from "effect";
import { Db, gamestoreApps, installJobs, user } from "../src/index";
import { runMigrations } from "../src/migrate";
import { DbTestUnmigrated, migrateUpTo } from "./testDb";

/** Последняя миграция, существовавшая до этой задачи. */
const PREV_MIGRATION = "20261105090640_play_segments_user_idx";

const run = <A, E>(eff: Effect.Effect<A, E, Db | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTestUnmigrated))));

/**
 * Воркер `brofrong` (роли `worker`+`gamestore`), игра 10 и строка
 * `gamestore_apps` без `worker_id` — сырым SQL, потому что колонки ещё нет
 * в БД на этом шаге, а типизированная схема пакета уже описывает итоговую
 * (после миграции) форму таблицы.
 */
const seedBeforeMigration = (db: Db["Service"]) =>
  Effect.gen(function* () {
    yield* db.execute(
      sql`insert into workers (id, public_ip, slots, roles) values ('brofrong', '203.0.113.9', 1, array['worker','gamestore'])`,
    );
    yield* db.execute(
      sql`insert into games (app_id, name) values (10, 'Test Game')`,
    );
    yield* db.execute(
      sql`insert into gamestore_apps (app_id, size_bytes, build_id) values (10, 1, 'b1')`,
    );
  });

describe("multi-server migration: gamestore_apps per worker", () => {
  it("backfills gamestore_apps.worker_id with the gamestore worker", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* migrateUpTo(PREV_MIGRATION);
        yield* seedBeforeMigration(db);
        yield* runMigrations;

        const rows = yield* db.select().from(gamestoreApps);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.appId).toBe(10);
        expect(rows[0]?.workerId).toBe("brofrong");
      }),
    ));

  it("allows the same app on two workers", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* migrateUpTo(PREV_MIGRATION);
        yield* seedBeforeMigration(db);
        yield* runMigrations;

        yield* db.execute(
          sql`insert into workers (id, public_ip, slots, roles) values ('w2', '203.0.113.10', 1, array['worker','gamestore'])`,
        );

        // (w2, 10) — другой сервер, та же игра: проходит.
        yield* db
          .insert(gamestoreApps)
          .values({ workerId: "w2", appId: 10, sizeBytes: 1, buildId: "b1" });

        // (brofrong, 10) снова — падает на PK (строка уже есть после бэкфилла).
        const duplicate = yield* Effect.exit(
          db.insert(gamestoreApps).values({
            workerId: "brofrong",
            appId: 10,
            sizeBytes: 1,
            buildId: "b1",
          }),
        );
        expect(Exit.isFailure(duplicate)).toBe(true);

        const rows = yield* db.select().from(gamestoreApps);
        expect(rows).toHaveLength(2);
      }),
    ));

  it("allows one active install job per worker and app", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* migrateUpTo(PREV_MIGRATION);
        yield* seedBeforeMigration(db);
        yield* runMigrations;

        yield* db.execute(
          sql`insert into workers (id, public_ip, slots, roles) values ('w2', '203.0.113.10', 1, array['worker','gamestore'])`,
        );
        yield* db.insert(user).values({
          id: "u1",
          name: "u1",
          email: "u1@steam.invalid",
          emailVerified: false,
        });

        yield* db.insert(installJobs).values({
          id: "job-1",
          appId: 10,
          userId: "u1",
          workerId: "brofrong",
          state: "queued",
        });

        // Вторая активная задача (brofrong, 10) — падает на новый индекс.
        const duplicate = yield* Effect.exit(
          db.insert(installJobs).values({
            id: "job-2",
            appId: 10,
            userId: "u1",
            workerId: "brofrong",
            state: "queued",
          }),
        );
        expect(Exit.isFailure(duplicate)).toBe(true);

        // Та же игра, но на другом сервере — проходит.
        const onOtherWorker = yield* Effect.exit(
          db.insert(installJobs).values({
            id: "job-3",
            appId: 10,
            userId: "u1",
            workerId: "w2",
            state: "queued",
          }),
        );
        expect(Exit.isSuccess(onOtherWorker)).toBe(true);
      }),
    ));

  it("drops orphan gamestore rows when no gamestore worker exists", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* migrateUpTo(PREV_MIGRATION);
        // Нет ни одного воркера вообще — бэкфиллу некого назначить.
        yield* db.execute(
          sql`insert into games (app_id, name) values (20, 'Orphan Game')`,
        );
        yield* db.execute(
          sql`insert into gamestore_apps (app_id, size_bytes, build_id) values (20, 1, 'b1')`,
        );
        yield* runMigrations;

        const rows = yield* db.select().from(gamestoreApps);
        expect(rows).toHaveLength(0);
      }),
    ));
});
