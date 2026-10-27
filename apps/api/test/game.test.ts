// `library.game` — страница игры (спека 2026-10-27 §4): кэш Steam Store на 7 суток
// (свежий — Steam не зовём; устаревший — перезаписываем; Steam упал — отдаём старое;
// `success: false` тоже кэшируется), достижения (Ready/Private/Unlinked), сессии
// пользователя по игре, `GameNotFound`. Тест на настоящей БД через RPC.
import { describe, expect, it } from "bun:test";
import {
  Db,
  gameAchievements,
  gameDetails,
  games,
  gamestoreApps,
  playSegments,
  sessions,
  user,
  userGames,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, LibraryRpcs } from "@cg/rpc";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { LibraryRpcHandlers } from "../src/library/rpc";
import { ProtonDb } from "../src/steam/ProtonDb";
import {
  type AchievementSchemaEntry,
  type PlayerAchievements,
  SteamApi,
} from "../src/steam/SteamApi";
import { type StoreLookup, SteamStoreApi } from "../src/steam/SteamStoreApi";

const linkedUser: CurrentUserShape = {
  id: "u-game",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: "76561197960287930",
  email: null,
  emailVerified: false,
};
const unlinkedUser: CurrentUserShape = {
  ...linkedUser,
  id: "u-game-unlinked",
  steamId: null,
};

/** Текущий пользователь и ответы фейков меняются от теста к тесту. */
const state = {
  current: linkedUser,
  store: { _tag: "Unavailable" } as StoreLookup,
  storeCalls: 0,
  schema: null as ReadonlyArray<AchievementSchemaEntry> | null,
  schemaCalls: 0,
  player: { _tag: "None" } as PlayerAchievements,
};

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.succeed(Option.some(state.current)),
});

const steamLayer = Layer.succeed(
  SteamApi,
  SteamApi.of({
    getOwnedGames: () => Effect.die("not used in game tests"),
    getAchievementSchema: () =>
      Effect.sync(() => {
        state.schemaCalls++;
        return state.schema;
      }),
    getPlayerAchievements: () => Effect.succeed(state.player),
  }),
);
const storeLayer = Layer.succeed(
  SteamStoreApi,
  SteamStoreApi.of({
    fetchDetails: () =>
      Effect.sync(() => {
        state.storeCalls++;
        return state.store;
      }),
  }),
);
const protonLayer = Layer.succeed(
  ProtonDb,
  ProtonDb.of({ fetchTier: () => Effect.die("not used in game tests") }),
);

const env = Layer.mergeAll(LibraryRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(Layer.mergeAll(steamLayer, storeLayer, protonLayer)),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));

const client = RpcTest.makeClient(LibraryRpcs);

const found = (
  shortDescription: string,
): Extract<StoreLookup, { _tag: "Found" }> => ({
  _tag: "Found",
  details: {
    shortDescription,
    aboutTheGame: "<p>about</p>",
    developers: ["Larian Studios"],
    publishers: ["Larian Studios"],
    genres: ["RPG"],
    releaseDate: "3 авг. 2023 г.",
    metacriticScore: 96,
    metacriticUrl: "https://www.metacritic.com/game/pc/bg3",
    controllerSupport: "full",
    linux: false,
    achievementsTotal: 2,
    screenshots: [{ thumb: "https://cdn/t.jpg", full: "https://cdn/f.jpg" }],
    movies: [],
  },
});

const seedGame = (db: Db["Service"], appId = 1086940) =>
  Effect.gen(function* () {
    yield* db
      .insert(user)
      .values([
        { id: linkedUser.id, name: "Игрок", email: "g@example.test" },
        { id: unlinkedUser.id, name: "Игрок", email: "gu@example.test" },
      ])
      .onConflictDoNothing();
    yield* db
      .insert(games)
      .values({ appId, name: "Baldur's Gate 3", protonTier: "platinum" });
    yield* db.insert(userGames).values({
      userId: linkedUser.id,
      appId,
      playtimeMinutes: 2460,
    });
  });

const ms = (days: number) => days * 24 * 60 * 60 * 1000;

const seedDetails = (db: Db["Service"], fetchedAt: Date, extra = {}) =>
  db.insert(gameDetails).values({
    appId: 1086940,
    fetchedAt,
    found: true,
    shortDescription: "cached",
    aboutTheGame: "",
    developers: [],
    publishers: [],
    genres: [],
    achievementsTotal: 0,
    screenshots: [],
    movies: [],
    ...extra,
  });

const game = (appId = 1086940) =>
  Effect.gen(function* () {
    return yield* (yield* client)["library.game"]({ appId });
  });

const reset = () => {
  state.current = linkedUser;
  state.store = { _tag: "Unavailable" };
  state.storeCalls = 0;
  state.schema = null;
  state.schemaCalls = 0;
  state.player = { _tag: "None" };
};

describe("library.game", () => {
  it("fresh cache: Steam Store not called, details from DB", async () => {
    reset();
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        yield* seedDetails(db, new Date(Date.now() - 60 * 60 * 1000));
        return yield* game();
      }),
    );
    expect(state.storeCalls).toBe(0);
    expect(view.details?.shortDescription).toBe("cached");
    expect(view.name).toBe("Baldur's Gate 3");
    expect(view.inLibrary).toBe(true);
    expect(view.playtimeMinutes).toBe(2460);
    expect(view.protonTier).toBe("platinum");
    expect(view.cloud).toEqual({ _tag: "Missing" });
    expect(view.sizeBytes).toBe(null);
  });

  it("stale cache: Steam Store called and row overwritten", async () => {
    reset();
    state.store = found("fresh from steam");
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        yield* seedDetails(db, new Date(Date.now() - ms(8)));
        return yield* game();
      }),
    );
    expect(state.storeCalls).toBe(1);
    expect(view.details?.shortDescription).toBe("fresh from steam");
    expect(view.details?.developers).toEqual(["Larian Studios"]);
    expect(view.details?.screenshots).toEqual([
      { thumb: "https://cdn/t.jpg", full: "https://cdn/f.jpg" },
    ]);
  });

  it("Steam Store unavailable: stale details are returned", async () => {
    reset();
    state.store = { _tag: "Unavailable" };
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        yield* seedDetails(db, new Date(Date.now() - ms(8)));
        return yield* game();
      }),
    );
    expect(state.storeCalls).toBe(1);
    expect(view.details?.shortDescription).toBe("cached");
  });

  it("success:false is cached: details null, no repeat call", async () => {
    reset();
    state.store = { _tag: "NotFound" };
    const [first, second] = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        const a = yield* game();
        const b = yield* game();
        return [a, b] as const;
      }),
    );
    expect(state.storeCalls).toBe(1);
    expect(first.details).toBe(null);
    expect(second.details).toBe(null);
  });

  it("no cache and Steam unavailable: details null, nothing stored", async () => {
    reset();
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        const v = yield* game();
        const rows = yield* db.select().from(gameDetails);
        expect(rows).toHaveLength(0);
        return v;
      }),
    );
    expect(view.details).toBe(null);
  });

  it("achievements Ready: unlocked/locked split, sorted by unlock desc", async () => {
    reset();
    state.store = found("x");
    state.schema = [
      {
        apiName: "A",
        name: "Первое",
        description: "d1",
        icon: "i1",
        iconGray: "g1",
        hidden: false,
      },
      {
        apiName: "B",
        name: "Второе",
        description: "d2",
        icon: "i2",
        iconGray: "g2",
        hidden: true,
      },
      {
        apiName: "C",
        name: "Третье",
        description: "d3",
        icon: "i3",
        iconGray: "g3",
        hidden: false,
      },
    ];
    state.player = {
      _tag: "Ready",
      unlocked: [
        { apiName: "A", unlockedAt: "2026-01-01T00:00:00.000Z" },
        { apiName: "C", unlockedAt: "2026-02-01T00:00:00.000Z" },
      ],
    };
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        const v = yield* game();
        // Схема закэширована, повторный запрос её не перезапрашивает.
        yield* game();
        const cached = yield* db.select().from(gameAchievements);
        expect(cached).toHaveLength(3);
        return v;
      }),
    );
    expect(state.schemaCalls).toBe(1);
    expect(view.achievements._tag).toBe("Ready");
    if (view.achievements._tag !== "Ready") return;
    expect(view.achievements.total).toBe(2);
    expect(view.achievements.unlocked.map((a) => a.apiName)).toEqual([
      "C",
      "A",
    ]);
    expect(view.achievements.unlocked[0]).toEqual({
      apiName: "C",
      name: "Третье",
      description: "d3",
      icon: "i3",
      unlockedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(view.achievements.locked).toEqual([
      {
        apiName: "B",
        name: "Второе",
        description: "d2",
        iconGray: "g2",
        hidden: true,
      },
    ]);
  });

  it("achievements None when the schema fetch fails even if the player list is Ready", async () => {
    reset();
    state.store = found("x");
    state.schema = null;
    state.player = {
      _tag: "Ready",
      unlocked: [{ apiName: "A", unlockedAt: "2026-01-01T00:00:00.000Z" }],
    };
    const view = await run(
      Effect.gen(function* () {
        yield* seedGame(yield* Db);
        return yield* game();
      }),
    );
    // Иначе страница рисует «Достижения · 0 из 54» над пустой сеткой.
    expect(view.achievements).toEqual({ _tag: "None" });
  });

  it("two concurrent opens with a stale schema both succeed and leave one schema", async () => {
    reset();
    state.store = found("x");
    state.schema = [
      {
        apiName: "A",
        name: "A",
        description: "",
        icon: "i",
        iconGray: "g",
        hidden: false,
      },
      {
        apiName: "B",
        name: "B",
        description: "",
        icon: "i",
        iconGray: "g",
        hidden: false,
      },
    ];
    state.player = { _tag: "Ready", unlocked: [] };
    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        // Кэш описания свежий, схема устарела и в ней лишняя старая запись.
        yield* seedDetails(db, new Date(), {
          achievementsTotal: 2,
          achievementsFetchedAt: new Date(Date.now() - ms(8)),
        });
        yield* db.insert(gameAchievements).values({
          appId: 1086940,
          apiName: "OLD",
          name: "old",
          description: "",
          icon: "i",
          iconGray: "g",
        });
        yield* Effect.all(
          Array.from({ length: 4 }, () => game()),
          { concurrency: "unbounded" },
        );
        return yield* db.select().from(gameAchievements);
      }),
    );
    expect(rows.map((r) => r.apiName).sort()).toEqual(["A", "B"]);
  });

  it("achievements Private for closed profile", async () => {
    reset();
    state.store = found("x");
    state.schema = [];
    state.player = { _tag: "Private" };
    const view = await run(
      Effect.gen(function* () {
        yield* seedGame(yield* Db);
        return yield* game();
      }),
    );
    expect(view.achievements).toEqual({ _tag: "Private" });
  });

  it("achievements None when the game has none", async () => {
    reset();
    state.store = {
      _tag: "Found",
      details: { ...found("x").details, achievementsTotal: 0 },
    };
    state.player = { _tag: "Ready", unlocked: [] };
    const view = await run(
      Effect.gen(function* () {
        yield* seedGame(yield* Db);
        return yield* game();
      }),
    );
    expect(view.achievements).toEqual({ _tag: "None" });
    expect(state.schemaCalls).toBe(0);
  });

  it("Unlinked when user has no steamId; still returns details", async () => {
    reset();
    state.current = unlinkedUser;
    state.store = found("x");
    const view = await run(
      Effect.gen(function* () {
        yield* seedGame(yield* Db);
        return yield* game();
      }),
    );
    expect(view.achievements).toEqual({ _tag: "Unlinked" });
    expect(view.details?.shortDescription).toBe("x");
    expect(view.inLibrary).toBe(false);
    expect(view.playtimeMinutes).toBe(0);
    expect(view.sessions).toEqual([]);
  });

  it("sessions: last 10 non-failed with minutes from closed segments, lastSession first; cloud Ready with size", async () => {
    reset();
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        yield* db.insert(gamestoreApps).values({
          appId: 1086940,
          sizeBytes: 122 * 2 ** 30,
          buildId: "b1",
        });
        for (let i = 0; i < 12; i++) {
          yield* db.insert(sessions).values({
            id: `s-${i}`,
            userId: linkedUser.id,
            appId: 1086940,
            state: i === 11 ? "failed" : "ended",
            createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
            endedAt: new Date(Date.UTC(2026, 0, 1 + i, 1)),
          });
        }
        // s-10 — самая свежая не-failed: два закрытых отрезка 25 + 10 минут.
        yield* db.insert(playSegments).values([
          {
            sessionId: "s-10",
            userId: linkedUser.id,
            appId: 1086940,
            startedAt: new Date(Date.UTC(2026, 0, 11, 0, 0)),
            endedAt: new Date(Date.UTC(2026, 0, 11, 0, 25)),
            billable: true,
            open: false,
          },
          {
            sessionId: "s-10",
            userId: linkedUser.id,
            appId: 1086940,
            startedAt: new Date(Date.UTC(2026, 0, 11, 0, 30)),
            endedAt: new Date(Date.UTC(2026, 0, 11, 0, 40)),
            billable: true,
            open: false,
          },
        ]);
        return yield* game();
      }),
    );
    expect(view.cloud).toEqual({ _tag: "Ready" });
    expect(view.sizeBytes).toBe(122 * 2 ** 30);
    expect(view.sessions).toHaveLength(10);
    expect(view.sessions[0]?.id).toBe("s-10");
    expect(view.sessions[0]?.minutes).toBe(35);
    expect(view.sessions[0]?.startedAt).toBe(
      new Date(Date.UTC(2026, 0, 11)).toISOString(),
    );
    // Без отрезков — от начала до конца сессии: 60 минут.
    expect(view.sessions[1]?.id).toBe("s-9");
    expect(view.sessions[1]?.minutes).toBe(60);
    expect(view.lastSession).toEqual(view.sessions[0]!);
  });

  it("GameNotFound for unknown appId", async () => {
    reset();
    const exit = await run(
      Effect.gen(function* () {
        yield* seedGame(yield* Db);
        return yield* Effect.exit(game(999999));
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("GameNotFound");
  });

  it("inLibrary false for a game not owned: playtime 0", async () => {
    reset();
    state.store = found("x");
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGame(db);
        yield* db.insert(games).values({ appId: 620, name: "Portal 2" });
        return yield* game(620);
      }),
    );
    expect(view.inLibrary).toBe(false);
    expect(view.playtimeMinutes).toBe(0);
    expect(view.name).toBe("Portal 2");
  });
});
