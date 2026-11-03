// Блок «Недавние» на главной /app: последняя не-failed сессия на игру,
// продолжительность из закрытых play_segments — тест RecentRepo через RPC.
import { describe, expect, it } from "bun:test";
import { Db, games, playSegments, sessions, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, LibraryRpcs } from "@cg/rpc";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { OwnGameCatalog } from "../src/library/OwnGameCatalog";
import { LibraryRpcHandlers } from "../src/library/rpc";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamApi } from "../src/steam/SteamApi";
import { SteamStoreApi } from "../src/steam/SteamStoreApi";

const recentUser: CurrentUserShape = {
  id: "u-recent",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
};

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.succeed(Option.some(recentUser)),
});

// `getOwnedGames`/`fetchTier` не вызываются: у `recentUser` нет `steamId`. Заглушки
// нужны только чтобы удовлетворить тип окружения хендлера `library.list`.
const steamLayer = Layer.succeed(
  SteamApi,
  SteamApi.of({
    getOwnedGames: () => Effect.die("not used in recent tests"),
    getAchievementSchema: () => Effect.die("not used in recent tests"),
    getPlayerAchievements: () => Effect.die("not used in recent tests"),
  }),
);
const protonLayer = Layer.succeed(
  ProtonDb,
  ProtonDb.of({ fetchTier: () => Effect.die("not used in recent tests") }),
);

const storeLayer = Layer.succeed(
  SteamStoreApi,
  SteamStoreApi.of({
    fetchDetails: () => Effect.die("not used in recent tests"),
  }),
);

const env = Layer.mergeAll(LibraryRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(
    Layer.mergeAll(
      steamLayer,
      protonLayer,
      storeLayer,
      OwnGameCatalog.fromManifests([]),
    ),
  ),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));

const insertUser = (db: Db["Service"], id: string = recentUser.id) =>
  db.insert(user).values({ id, name: "Игрок", email: `${id}@example.test` });

const insertGames = (db: Db["Service"], appIds: ReadonlyArray<number>) =>
  db
    .insert(games)
    .values(appIds.map((appId) => ({ appId, name: `Game ${appId}` })));

const client = RpcTest.makeClient(LibraryRpcs);

describe("library.recent", () => {
  it("returns the three latest distinct games, newest first, with duration from segments", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        // appId 1 = B, 2 = A, 3 = C, 4 = D.
        yield* insertGames(db, [1, 2, 3, 4]);

        // B: единственная (самая старая) сессия — не попадёт в топ-3.
        yield* db.insert(sessions).values({
          id: "s-b",
          userId: recentUser.id,
          appId: 1,
          state: "ended",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          endedAt: new Date("2026-01-01T00:05:00Z"),
        });
        // A: старая сессия и новая — в ответе A учитывается один раз, по новой.
        yield* db.insert(sessions).values({
          id: "s-a-old",
          userId: recentUser.id,
          appId: 2,
          state: "ended",
          createdAt: new Date("2026-01-02T00:00:00Z"),
          endedAt: new Date("2026-01-02T00:05:00Z"),
        });
        yield* db.insert(sessions).values({
          id: "s-a-new",
          userId: recentUser.id,
          appId: 2,
          state: "ended",
          createdAt: new Date("2026-01-03T00:00:00Z"),
          endedAt: new Date("2026-01-03T01:00:00Z"),
        });
        // Закрытые отрезки новой сессии A: 25 + 10 = 35 минут.
        yield* db.insert(playSegments).values([
          {
            sessionId: "s-a-new",
            userId: recentUser.id,
            appId: 2,
            startedAt: new Date("2026-01-03T00:00:00Z"),
            endedAt: new Date("2026-01-03T00:25:00Z"),
            billable: true,
            open: false,
          },
          {
            sessionId: "s-a-new",
            userId: recentUser.id,
            appId: 2,
            startedAt: new Date("2026-01-03T00:30:00Z"),
            endedAt: new Date("2026-01-03T00:40:00Z"),
            billable: true,
            open: false,
          },
        ]);
        // C.
        yield* db.insert(sessions).values({
          id: "s-c",
          userId: recentUser.id,
          appId: 3,
          state: "ended",
          createdAt: new Date("2026-01-04T00:00:00Z"),
          endedAt: new Date("2026-01-04T00:10:00Z"),
        });
        // D: самая свежая.
        yield* db.insert(sessions).values({
          id: "s-d",
          userId: recentUser.id,
          appId: 4,
          state: "ended",
          createdAt: new Date("2026-01-05T00:00:00Z"),
          endedAt: new Date("2026-01-05T00:02:00Z"),
        });

        return yield* (yield* client)["library.recent"]();
      }),
    );

    expect(entries.map((e) => e.appId)).toEqual([4, 3, 2]);
    const a = entries.find((e) => e.appId === 2);
    expect(a?.name).toBe("Game 2");
    expect(a?.lastDurationMinutes).toBe(35);
    expect(a?.lastPlayedAt).toBe(
      new Date("2026-01-03T01:00:00Z").toISOString(),
    );
  });

  it("failed sessions are ignored, running session counts with duration so far", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        yield* insertGames(db, [10, 11]);

        // Game 10: старая завершённая сессия, затем более новая failed —
        // failed игнорируется, в ответе должна быть именно старая сессия.
        yield* db.insert(sessions).values({
          id: "s-x-ended",
          userId: recentUser.id,
          appId: 10,
          state: "ended",
          createdAt: new Date("2020-01-01T00:00:00Z"),
          endedAt: new Date("2020-01-01T00:05:00Z"),
        });
        yield* db.insert(sessions).values({
          id: "s-x-failed",
          userId: recentUser.id,
          appId: 10,
          state: "failed",
          createdAt: new Date("2030-01-01T00:00:00Z"),
        });

        // Game 11: сейчас идёт сессия, без закрытых отрезков —
        // длительность считается от created_at до «сейчас».
        const createdAt = new Date(Date.now() - 5 * 60_000);
        yield* db.insert(sessions).values({
          id: "s-y-running",
          userId: recentUser.id,
          appId: 11,
          state: "playing",
          createdAt,
        });

        return yield* (yield* client)["library.recent"]();
      }),
    );

    expect(entries.map((e) => e.appId)).toEqual([11, 10]);
    const x = entries.find((e) => e.appId === 10);
    expect(x?.lastPlayedAt).toBe(
      new Date("2020-01-01T00:05:00Z").toISOString(),
    );
    const y = entries.find((e) => e.appId === 11);
    expect(y?.lastDurationMinutes).toBeGreaterThanOrEqual(5);
    expect(y?.lastDurationMinutes).toBeLessThan(6);
  });

  it("a game removed from the user's library still appears by games.name", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        yield* insertGames(db, [20]);
        // Игра есть в `games` (нужна для FK сессии), но строки в `user_games` нет —
        // игру убрали из библиотеки.
        yield* db.insert(sessions).values({
          id: "s-removed",
          userId: recentUser.id,
          appId: 20,
          state: "ended",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          endedAt: new Date("2026-01-01T00:05:00Z"),
        });

        return yield* (yield* client)["library.recent"]();
      }),
    );

    expect(entries.length).toBe(1);
    expect(entries[0]?.appId).toBe(20);
    expect(entries[0]?.name).toBe("Game 20");
  });

  it("empty when the user has no sessions", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        return yield* (yield* client)["library.recent"]();
      }),
    );
    expect(entries).toEqual([]);
  });
});
