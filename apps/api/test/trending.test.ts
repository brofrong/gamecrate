// Блок «В тренде» на главной /app: сейчас играют (живые сессии) и за неделю
// (разные пользователи за 7 суток) — тест TrendingRepo через RPC.
import { describe, expect, it } from "bun:test";
import { Db, games, sessions, user, userGames } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, LibraryRpcs } from "@cg/rpc";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { LibraryRpcHandlers } from "../src/library/rpc";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamApi } from "../src/steam/SteamApi";

const trendingUser: CurrentUserShape = {
  id: "u-trending",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
};

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.succeed(Option.some(trendingUser)),
});

// `getOwnedGames`/`fetchTier` не вызываются: у `trendingUser` нет `steamId`. Заглушки
// нужны только чтобы удовлетворить тип окружения хендлера `library.list`.
const steamLayer = Layer.succeed(
  SteamApi,
  SteamApi.of({
    getOwnedGames: () => Effect.die("not used in trending tests"),
    getAchievementSchema: () => Effect.die("not used in trending tests"),
    getPlayerAchievements: () => Effect.die("not used in trending tests"),
  }),
);
const protonLayer = Layer.succeed(
  ProtonDb,
  ProtonDb.of({ fetchTier: () => Effect.die("not used in trending tests") }),
);

const env = Layer.mergeAll(LibraryRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(Layer.mergeAll(steamLayer, protonLayer)),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));

const insertUser = (db: Db["Service"], id: string) =>
  db.insert(user).values({ id, name: "Игрок", email: `${id}@example.test` });

const insertGames = (db: Db["Service"], appIds: ReadonlyArray<number>) =>
  db
    .insert(games)
    .values(appIds.map((appId) => ({ appId, name: `Game ${appId}` })));

const client = RpcTest.makeClient(LibraryRpcs);

describe("library.trending", () => {
  it("now counts live sessions across users, week counts distinct users, sorted by players then name", async () => {
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, trendingUser.id);
        yield* insertUser(db, "u-1");
        yield* insertUser(db, "u-2");
        yield* insertUser(db, "u-3");
        yield* insertUser(db, "u-4");
        // X = 100, Y = 101, Z = 102.
        yield* insertGames(db, [100, 101, 102]);

        // X: 2 живые сессии (2 юзера) — now players = 2.
        yield* db.insert(sessions).values({
          id: "s-x-live-1",
          userId: "u-1",
          appId: 100,
          state: "playing",
          createdAt: new Date(Date.now() - 60 * 60_000),
        });
        yield* db.insert(sessions).values({
          id: "s-x-live-2",
          userId: "u-2",
          appId: 100,
          state: "playing",
          createdAt: new Date(Date.now() - 30 * 60_000),
        });
        // X: + 1 ended за неделю, тот же юзер u-1 — week distinct остаётся 2.
        yield* db.insert(sessions).values({
          id: "s-x-ended",
          userId: "u-1",
          appId: 100,
          state: "ended",
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
          endedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000 + 5 * 60_000),
        });

        // Y: 1 юзер (u-3) с 5 ended сессиями за неделю — week players = 1,
        // нет живых сессий — не попадает в now.
        for (let i = 0; i < 5; i++) {
          yield* db.insert(sessions).values({
            id: `s-y-${i}`,
            userId: "u-3",
            appId: 101,
            state: "ended",
            createdAt: new Date(Date.now() - (i + 1) * 24 * 60 * 60_000),
            endedAt: new Date(
              Date.now() - (i + 1) * 24 * 60 * 60_000 + 5 * 60_000,
            ),
          });
        }

        // Z: сессия 8 дней назад (вне недели), ended — нигде не попадает.
        yield* db.insert(sessions).values({
          id: "s-z",
          userId: "u-4",
          appId: 102,
          state: "ended",
          createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
          endedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000 + 5 * 60_000),
        });

        return yield* (yield* client)["library.trending"]();
      }),
    );

    expect(
      view.now.map((e) => ({ appId: e.appId, players: e.players })),
    ).toEqual([{ appId: 100, players: 2 }]);
    expect(
      view.week.map((e) => ({ appId: e.appId, players: e.players })),
    ).toEqual([
      { appId: 100, players: 2 },
      { appId: 101, players: 1 },
    ]);
  });

  it("inLibrary is true only for games the current user owns", async () => {
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, trendingUser.id);
        yield* insertUser(db, "u-owner-1");
        yield* insertUser(db, "u-owner-2");
        yield* insertGames(db, [200, 201]);
        yield* db
          .insert(userGames)
          .values({ userId: trendingUser.id, appId: 200, playtimeMinutes: 0 });

        // Разные пользователи — частичный уникальный индекс допускает только
        // одну активную сессию на пользователя.
        yield* db.insert(sessions).values({
          id: "s-owned-live",
          userId: "u-owner-1",
          appId: 200,
          state: "playing",
          createdAt: new Date(),
        });
        yield* db.insert(sessions).values({
          id: "s-notowned-live",
          userId: "u-owner-2",
          appId: 201,
          state: "playing",
          createdAt: new Date(),
        });

        return yield* (yield* client)["library.trending"]();
      }),
    );

    const owned = view.now.find((e) => e.appId === 200);
    const notOwned = view.now.find((e) => e.appId === 201);
    expect(owned?.inLibrary).toBe(true);
    expect(notOwned?.inLibrary).toBe(false);
  });

  it("limits each list to 12", async () => {
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, trendingUser.id);
        const appIds = Array.from({ length: 15 }, (_, i) => 300 + i);
        yield* insertGames(db, appIds);
        // Отдельный пользователь на сессию — частичный уникальный индекс
        // допускает только одну активную сессию на пользователя.
        for (const appId of appIds) {
          const userId = `u-many-${appId}`;
          yield* insertUser(db, userId);
          yield* db.insert(sessions).values({
            id: `s-many-${appId}`,
            userId,
            appId,
            state: "playing",
            createdAt: new Date(),
          });
        }

        return yield* (yield* client)["library.trending"]();
      }),
    );

    expect(view.now.length).toBe(12);
    expect(view.week.length).toBe(12);
  });

  it("works for a user without Steam", async () => {
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, trendingUser.id);
        yield* insertUser(db, "u-other");
        yield* insertGames(db, [400]);
        yield* db.insert(sessions).values({
          id: "s-other-live",
          userId: "u-other",
          appId: 400,
          state: "playing",
          createdAt: new Date(),
        });

        return yield* (yield* client)["library.trending"]();
      }),
    );

    expect(trendingUser.steamId).toBeNull();
    expect(view.now.every((e) => !e.inLibrary)).toBe(true);
    expect(view.week.every((e) => !e.inLibrary)).toBe(true);
  });
});
