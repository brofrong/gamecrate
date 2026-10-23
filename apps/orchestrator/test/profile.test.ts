import { describe, expect, it } from "bun:test";
import { Db, profiles, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { eq } from "drizzle-orm";
import { Effect, References } from "effect";
import * as SessionRepo from "../src/SessionRepo";

const run = <A, E>(body: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(DbTest),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );

const seedUser = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(user).values({
      id,
      name: id,
      email: `${id}@steam.invalid`,
      emailVerified: false,
    });
  });

const profileRow = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({
        version: profiles.version,
        objectKey: profiles.objectKey,
        sizeBytes: profiles.sizeBytes,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    return row;
  });

describe("profile commit", () => {
  it("first profile commit with null base is accepted as version 1", () =>
    run(
      Effect.gen(function* () {
        yield* seedUser("u1");
        expect(yield* SessionRepo.profileOf("u1")).toBeNull();

        const first = yield* SessionRepo.commitProfile({
          userId: "u1",
          baseVersion: null,
          objectKey: "profiles/u1/a.cgp",
          sizeBytes: 7_000_000,
          steamLoginSeeded: false,
        });
        expect(first).toEqual({ accepted: true });
        expect(yield* profileRow("u1")).toEqual({
          version: 1,
          objectKey: "profiles/u1/a.cgp",
          sizeBytes: 7_000_000,
        });
        expect(yield* SessionRepo.profileOf("u1")).toEqual({
          version: 1,
          objectKey: "profiles/u1/a.cgp",
        });

        // Второй «первый» коммит (параллельный импорт) не перезаписывает профиль.
        const again = yield* SessionRepo.commitProfile({
          userId: "u1",
          baseVersion: null,
          objectKey: "profiles/u1/b.cgp",
          sizeBytes: 1,
          steamLoginSeeded: false,
        });
        expect(again).toEqual({ accepted: false });
        expect((yield* profileRow("u1"))?.objectKey).toBe("profiles/u1/a.cgp");
      }),
    ));

  it("profile commit rejects stale base", () =>
    run(
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* SessionRepo.commitProfile({
          userId: "u1",
          baseVersion: null,
          objectKey: "profiles/u1/v1.cgp",
          sizeBytes: 100,
          steamLoginSeeded: false,
        });

        const second = yield* SessionRepo.commitProfile({
          userId: "u1",
          baseVersion: 1,
          objectKey: "profiles/u1/v2.cgp",
          sizeBytes: 200,
          steamLoginSeeded: false,
        });
        expect(second).toEqual({ accepted: true });
        expect(yield* profileRow("u1")).toEqual({
          version: 2,
          objectKey: "profiles/u1/v2.cgp",
          sizeBytes: 200,
        });

        // Та же базовая версия ещё раз — устарела, новый профиль цел.
        const stale = yield* SessionRepo.commitProfile({
          userId: "u1",
          baseVersion: 1,
          objectKey: "profiles/u1/stale.cgp",
          sizeBytes: 300,
          steamLoginSeeded: false,
        });
        expect(stale).toEqual({ accepted: false });
        // Базовая версия из будущего и профиль, которого нет, — тоже отказ.
        expect(
          yield* SessionRepo.commitProfile({
            userId: "u1",
            baseVersion: 5,
            objectKey: "profiles/u1/future.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
          }),
        ).toEqual({ accepted: false });
        yield* seedUser("u2");
        expect(
          yield* SessionRepo.commitProfile({
            userId: "u2",
            baseVersion: 1,
            objectKey: "profiles/u2/x.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
          }),
        ).toEqual({ accepted: false });
        expect(yield* profileRow("u2")).toBeUndefined();
        expect(yield* profileRow("u1")).toEqual({
          version: 2,
          objectKey: "profiles/u1/v2.cgp",
          sizeBytes: 200,
        });
      }),
    ));
});
