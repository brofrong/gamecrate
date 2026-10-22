import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Exit, Queue } from "effect";
import { Db, games, installJobs, sessions, user } from "../src/index";
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

describe("install_jobs", () => {
  it("second active install job for an app violates unique index", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);

        yield* db
          .insert(installJobs)
          .values({ id: crypto.randomUUID(), appId: 570, userId: "u1" });

        const result = yield* db
          .insert(installJobs)
          .values({ id: crypto.randomUUID(), appId: 570, userId: "u1" })
          .pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
      }),
    ));

  it("done job does not block a new job for the app", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);

        yield* db.insert(installJobs).values({
          id: crypto.randomUUID(),
          appId: 570,
          userId: "u1",
          state: "done",
        });
        yield* db
          .insert(installJobs)
          .values({ id: crypto.randomUUID(), appId: 570, userId: "u1" });

        const rows = yield* db.select().from(installJobs);
        expect(rows).toHaveLength(2);
      }),
    ));

  it("install job progress update notifies its installing sessions", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertGame(db);
        const jobId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();

        yield* db
          .insert(installJobs)
          .values({ id: jobId, appId: 570, userId: "u1", state: "running" });
        yield* db.insert(sessions).values({
          id: sessionId,
          userId: "u1",
          appId: 570,
          state: "installing",
          installJobId: jobId,
        });

        // Scoped explicitly, как в sessions.test.ts: слушатель должен остановиться
        // и отпустить соединение раньше, чем временная база удалится.
        yield* Effect.gen(function* () {
          const queue = yield* db.$client.listen("session_changed");

          yield* db
            .update(installJobs)
            .set({ bytesDownloaded: 10, bytesTotal: 100 })
            .where(eq(installJobs.id, jobId));
          const notification = yield* Queue.take(queue).pipe(
            Effect.timeout("2 seconds"),
          );
          expect(notification.payload).toBe(sessionId);
        }).pipe(Effect.scoped);
      }),
    ));
});
