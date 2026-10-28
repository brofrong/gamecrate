import { describe, expect, it } from "bun:test";
import { Db, profiles, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import type { SteamLoginSeed } from "@cg/rpc";
import { eq, sql } from "drizzle-orm";
import { Effect, Logger, Redacted, References } from "effect";
import { applyProfileCommit } from "../src/http";
import * as SessionRepo from "../src/SessionRepo";
import { SteamLoginSeeds } from "../src/SteamLoginSeeds";

const run = <A, E>(body: Effect.Effect<A, E, Db | SteamLoginSeeds>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(DbTest),
      Effect.provide(SteamLoginSeeds.layer),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );

const makeSeed = (refreshToken: string): SteamLoginSeed => ({
  accountName: Redacted.make("steamuser"),
  steamId: "76561198000000000",
  refreshToken: Redacted.make(refreshToken),
});

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

  it("accepted seeded commit clears the pending login", () =>
    run(
      Effect.gen(function* () {
        yield* seedUser("u1");
        const seeds = yield* SteamLoginSeeds;
        const seed = makeSeed("t1");
        yield* seeds.put("u1", seed);

        const result = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: null,
            objectKey: "profiles/u1/a.cgp",
            sizeBytes: 10,
            steamLoginSeeded: true,
          },
          "w1",
        );
        expect(result).toEqual({ accepted: true });
        expect(yield* seeds.get("u1")).toBeNull();
      }),
    ));

  it("rejected or unseeded commit keeps it", () =>
    run(
      Effect.gen(function* () {
        yield* seedUser("u1");
        const seeds = yield* SteamLoginSeeds;
        const seed = makeSeed("t1");
        yield* seeds.put("u1", seed);

        // Отклонённый коммит (устаревшая база) вход не трогает.
        const rejected = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: 5,
            objectKey: "profiles/u1/x.cgp",
            sizeBytes: 1,
            steamLoginSeeded: true,
          },
          "w1",
        );
        expect(rejected).toEqual({ accepted: false });
        expect(yield* seeds.get("u1")).toBe(seed);

        // Принятый, но не посеянный коммит — тоже не трогает.
        const unseeded = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: null,
            objectKey: "profiles/u1/y.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
          },
          "w1",
        );
        expect(unseeded).toEqual({ accepted: true });
        expect(yield* seeds.get("u1")).toBe(seed);
      }),
    ));

  it("accepted commit with the echo clears the reset", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedUser("u1");
        const T = new Date("2026-10-28T10:00:00.123Z");
        const T2 = new Date("2026-10-28T11:00:00.456Z");
        const setReset = (at: Date | null) =>
          db
            .update(user)
            .set({ steamLoginResetAt: at })
            .where(eq(user.id, "u1"));

        // Отклонённый коммит с эхом T пометку не снимает.
        yield* setReset(T);
        const rejected = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: 5,
            objectKey: "profiles/u1/x.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
            steamLoginResetAt: T.toISOString(),
          },
          "w1",
        );
        expect(rejected).toEqual({ accepted: false });
        expect(yield* SessionRepo.steamLoginResetAt("u1")).toEqual(T);

        // Принятый коммит без эха (агент не стирал вход) пометку не снимает.
        const plain = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: null,
            objectKey: "profiles/u1/a.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
          },
          "w1",
        );
        expect(plain).toEqual({ accepted: true });
        expect(yield* SessionRepo.steamLoginResetAt("u1")).toEqual(T);

        // Принятый коммит с эхом T — снята.
        const cleared = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: 1,
            objectKey: "profiles/u1/b.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
            steamLoginResetAt: T.toISOString(),
          },
          "w1",
        );
        expect(cleared).toEqual({ accepted: true });
        expect(yield* SessionRepo.steamLoginResetAt("u1")).toBeNull();

        // Админ сбросил ещё раз (T2 > T), запоздалый коммит с эхом T — остаётся T2.
        yield* setReset(T2);
        const stale = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: 2,
            objectKey: "profiles/u1/c.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
            steamLoginResetAt: T.toISOString(),
          },
          "w1",
        );
        expect(stale).toEqual({ accepted: true });
        expect(yield* SessionRepo.steamLoginResetAt("u1")).toEqual(T2);
        expect(yield* SessionRepo.clearSteamLoginReset("u1", T)).toBe(false);
        expect(yield* SessionRepo.clearSteamLoginReset("u1", T2)).toBe(true);
        expect(yield* SessionRepo.steamLoginResetAt("u1")).toBeNull();
      }),
    ));

  it("M3: clears a mark stored with microsecond precision when the echo matches its millisecond truncation", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedUser("u1");
        // Запись с микросекундами — как если бы пометку поставили руками
        // (`now()` в SQL), а не агент (JS `Date`, точность — миллисекунды).
        yield* db.execute(
          sql`update "user" set steam_login_reset_at = ${"2026-10-28 10:00:00.123456+00"}::timestamptz where id = ${"u1"}`,
        );
        // Эхо агента — то же мгновение, усечённое до миллисекунд.
        const echo = new Date("2026-10-28T10:00:00.123Z");
        expect(yield* SessionRepo.clearSteamLoginReset("u1", echo)).toBe(true);
        expect(yield* SessionRepo.steamLoginResetAt("u1")).toBeNull();
      }),
    ));

  it("logs whether the commit was seeded and cleared the pending login", async () => {
    const logged: Array<ReadonlyArray<unknown>> = [];
    const capture = Logger.make(({ message }) => {
      logged.push(Array.isArray(message) ? message : [message]);
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedUser("u1");
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("t1"));
        // Устаревшая база: отклонён, вход не убран.
        yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: 5,
            objectKey: "profiles/u1/x.cgp",
            sizeBytes: 1,
            steamLoginSeeded: true,
          },
          "w1",
        );
        // Принят и посеян: вход убран.
        yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: null,
            objectKey: "profiles/u1/a.cgp",
            sizeBytes: 10,
            steamLoginSeeded: true,
          },
          "w1",
        );
        // Принят с эхом сброса: пометка снята (в логе — только флаг).
        const resetAt = new Date("2026-10-28T10:00:00.000Z");
        const db = yield* Db;
        yield* db
          .update(user)
          .set({ steamLoginResetAt: resetAt })
          .where(eq(user.id, "u1"));
        yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: 1,
            objectKey: "profiles/u1/b.cgp",
            sizeBytes: 10,
            steamLoginSeeded: false,
            steamLoginResetAt: resetAt.toISOString(),
          },
          "w1",
        );
      }).pipe(
        Effect.provide(DbTest),
        Effect.provide(SteamLoginSeeds.layer),
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      ),
    );
    const commits = logged
      .filter((message) => message[0] === "Profile commit")
      .map((message) => message[1]);
    expect(commits).toEqual([
      {
        userId: "u1",
        baseVersion: 5,
        accepted: false,
        steamLoginSeeded: true,
        seedCleared: false,
        steamLoginResetCleared: false,
        workerId: "w1",
      },
      {
        userId: "u1",
        baseVersion: null,
        accepted: true,
        steamLoginSeeded: true,
        seedCleared: true,
        steamLoginResetCleared: false,
        workerId: "w1",
      },
      {
        userId: "u1",
        baseVersion: 1,
        accepted: true,
        steamLoginSeeded: false,
        seedCleared: false,
        steamLoginResetCleared: true,
        workerId: "w1",
      },
    ]);
  });

  it("M2: a failed clear of the reset mark warns but the accepted commit still stands", async () => {
    const logged: Array<ReadonlyArray<unknown>> = [];
    const capture = Logger.make(({ logLevel, message }) => {
      logged.push([logLevel, ...(Array.isArray(message) ? message : [message])]);
    });
    const resetAt = new Date("2026-10-28T10:00:00.000Z");
    const { result, resetAfter } = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedUser("u1");
        const db = yield* Db;
        yield* db
          .update(user)
          .set({ steamLoginResetAt: resetAt })
          .where(eq(user.id, "u1"));
        // `clearSteamLoginReset` снимает пометку через `db.update(user)`:
        // подменяем только эту ветку, чтобы она падала дефектом, как при
        // реальном сбое БД, не трогая `commitProfile` (`db.update(profiles)`/
        // `insert`), которому полагается пройти как обычно.
        const real = yield* Db;
        const sabotaged = new Proxy(real, {
          get(target, prop, _receiver) {
            if (prop === "update")
              return (table: unknown) =>
                table === user
                  ? {
                      set: () => ({
                        where: () => ({
                          returning: () =>
                            Effect.die(new Error("simulated DB failure")),
                        }),
                      }),
                    }
                  : target.update(table as never);
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as typeof real;
        const result = yield* applyProfileCommit(
          {
            userId: "u1",
            baseVersion: null,
            objectKey: "profiles/u1/a.cgp",
            sizeBytes: 1,
            steamLoginSeeded: false,
            steamLoginResetAt: resetAt.toISOString(),
          },
          "w1",
        ).pipe(Effect.provideService(Db, sabotaged));
        // Снятие провалилось дефектом внутри `applyProfileCommit` — не наружу:
        // если бы это пробросило дефект, `Effect.runPromise` сам упал бы здесь.
        const resetAfter = yield* SessionRepo.steamLoginResetAt("u1");
        return { result, resetAfter };
      }).pipe(
        Effect.provide(DbTest),
        Effect.provide(SteamLoginSeeds.layer),
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "All"),
      ),
    );
    // Коммит принят — агент не узнаёт об отказе снятия пометки.
    expect(result).toEqual({ accepted: true });
    // Пометка осталась (снятие провалилось) — следующий коммит с тем же
    // эхом снимет её (`lte`, fail-safe).
    expect(resetAfter).not.toBeNull();
    const warning = logged.find(
      (line) => line[1] === "Clearing Steam login reset mark failed, commit stays accepted",
    );
    expect(warning?.[0]).toBe("Warn");
    const detail = warning?.[2] as Record<string, unknown> | undefined;
    expect(detail?.userId).toBe("u1");
    expect(detail?.workerId).toBe("w1");
    // Никаких секретов (вход Steam) в предупреждении нет.
    expect(JSON.stringify(detail)).not.toContain("steamuser");
  });
});
