import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Exit, Queue } from "effect";
import { Db, games, sessions, user, workers } from "../src/index";
import { DbTest } from "./testDb";

const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTest))));

const insertUser = (db: Db["Service"], id: string) =>
  db.insert(user).values({
    id,
    name: "n",
    email: `${id}@steam.invalid`,
    emailVerified: false,
  });

const insertGame = (db: Db["Service"]) =>
  db.insert(games).values({ appId: 570, name: "Dota 2" });

describe("sessions", () => {
  it("second active session for a user violates unique index", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);

        yield* db
          .insert(sessions)
          .values({ id: crypto.randomUUID(), userId: "u1", appId: 570 });

        const result = yield* db
          .insert(sessions)
          .values({ id: crypto.randomUUID(), userId: "u1", appId: 570 })
          .pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
      }),
    ));

  it("ended session does not block a new one", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);

        yield* db.insert(sessions).values({
          id: crypto.randomUUID(),
          userId: "u1",
          appId: 570,
          state: "ended",
        });
        yield* db
          .insert(sessions)
          .values({ id: crypto.randomUUID(), userId: "u1", appId: 570 });

        const rows = yield* db.select().from(sessions);
        expect(rows).toHaveLength(2);
      }),
    ));

  it("same worker slot cannot host two active sessions", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertUser(db, "u2");
        yield* insertGame(db);
        yield* db
          .insert(workers)
          .values({ id: "brofrong", publicIp: "37.153.14.138", slots: 1 });

        yield* db.insert(sessions).values({
          id: crypto.randomUUID(),
          userId: "u1",
          appId: 570,
          workerId: "brofrong",
          slot: 0,
          state: "playing",
        });

        const result = yield* db
          .insert(sessions)
          .values({
            id: crypto.randomUUID(),
            userId: "u2",
            appId: 570,
            workerId: "brofrong",
            slot: 0,
            state: "playing",
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
      }),
    ));

  it("update of a session emits pg_notify session_changed", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);
        const id = crypto.randomUUID();

        // Scoped explicitly (not left on the test's ambient scope): the
        // listener must stop and release its connection before the temporary
        // database is dropped at teardown, or the DROP hangs.
        yield* Effect.gen(function* () {
          const queue = yield* db.$client.listen("session_changed");

          yield* db.insert(sessions).values({ id, userId: "u1", appId: 570 });
          const insertNotification = yield* Queue.take(queue).pipe(
            Effect.timeout("2 seconds"),
          );
          expect(insertNotification.payload).toBe(id);

          yield* db
            .update(sessions)
            .set({ state: "starting" })
            .where(eq(sessions.id, id));
          const updateNotification = yield* Queue.take(queue).pipe(
            Effect.timeout("2 seconds"),
          );
          expect(updateNotification.payload).toBe(id);
        }).pipe(Effect.scoped);
      }),
    ));
});
