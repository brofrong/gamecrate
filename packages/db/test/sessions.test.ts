import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option, Queue } from "effect";
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

  it("held slot blocks the same worker slot even when the session failed", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertUser(db, "u2");
        yield* insertGame(db);
        yield* db
          .insert(workers)
          .values({ id: "brofrong", publicIp: "37.153.14.138", slots: 1 });

        // Сессия провалилась, но контейнер мог ещё работать: slotReleasedAt
        // не выставлен, слот всё ещё занят.
        yield* db.insert(sessions).values({
          id: crypto.randomUUID(),
          userId: "u1",
          appId: 570,
          workerId: "brofrong",
          slot: 0,
          state: "failed",
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

  it("released slot can be reused", () =>
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
          state: "failed",
          slotReleasedAt: new Date(),
        });

        yield* db.insert(sessions).values({
          id: crypto.randomUUID(),
          userId: "u2",
          appId: 570,
          workerId: "brofrong",
          slot: 0,
          state: "playing",
        });

        const rows = yield* db.select().from(sessions);
        expect(rows).toHaveLength(2);
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

  it("heartbeat-only update does not notify, a state change does", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);
        const id = crypto.randomUUID();

        yield* Effect.gen(function* () {
          const queue = yield* db.$client.listen("session_changed");
          yield* db.insert(sessions).values({ id, userId: "u1", appId: 570 });
          expect(
            (yield* Queue.take(queue).pipe(Effect.timeout("2 seconds")))
              .payload,
          ).toBe(id);

          // Heartbeat браузера и агента: только отметки времени.
          const now = new Date();
          yield* db
            .update(sessions)
            .set({ clientSeenAt: now, lastInputAt: now, agentSeenAt: now })
            .where(eq(sessions.id, id));
          // Тот же state ещё раз — значение не изменилось, уведомлять не о чем.
          yield* db
            .update(sessions)
            .set({ state: "queued", agentSeenAt: new Date() })
            .where(eq(sessions.id, id));
          const silent = yield* Queue.take(queue).pipe(
            Effect.timeoutOption("500 millis"),
          );
          expect(Option.isNone(silent)).toBe(true);

          for (const patch of [
            { state: "starting" as const },
            { streamUrl: "http://cg-session-x:8080" },
            { failReason: "x" },
            { stopRequestedAt: new Date() },
          ]) {
            yield* db.update(sessions).set(patch).where(eq(sessions.id, id));
            const notification = yield* Queue.take(queue).pipe(
              Effect.timeout("2 seconds"),
            );
            expect(notification.payload).toBe(id);
          }
        }).pipe(Effect.scoped);
      }),
    ));

  it("stage change emits session_changed", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);
        const id = crypto.randomUUID();

        yield* Effect.gen(function* () {
          const queue = yield* db.$client.listen("session_changed");
          yield* db.insert(sessions).values({ id, userId: "u1", appId: 570 });
          expect(
            (yield* Queue.take(queue).pipe(Effect.timeout("2 seconds")))
              .payload,
          ).toBe(id);

          yield* db
            .update(sessions)
            .set({ stage: "login" })
            .where(eq(sessions.id, id));
          const stageNotification = yield* Queue.take(queue).pipe(
            Effect.timeout("2 seconds"),
          );
          expect(stageNotification.payload).toBe(id);

          // Тот же stage ещё раз — значение не изменилось, уведомлять не о чем.
          yield* db
            .update(sessions)
            .set({ stage: "login" })
            .where(eq(sessions.id, id));
          const silent = yield* Queue.take(queue).pipe(
            Effect.timeoutOption("500 millis"),
          );
          expect(Option.isNone(silent)).toBe(true);
        }).pipe(Effect.scoped);
      }),
    ));
});
