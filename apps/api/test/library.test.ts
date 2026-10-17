// Синхронизация библиотеки Steam, тиры ProtonDB и RPC `library.*` на временной БД.
import { describe, expect, it } from "bun:test";
import { Db, games, user, userGames } from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  type CurrentUserShape,
  LibraryRpcs,
  type ProtonTier,
  SteamUnavailable,
  tierLabel,
} from "@cg/rpc";
import { count, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth, librarySyncHooks } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import {
  coverUrl,
  refreshTiers,
  syncLibrary,
  syncOnLogin,
} from "../src/library/LibraryService";
import { LibraryRpcHandlers } from "../src/library/rpc";
import { ProtonDb } from "../src/steam/ProtonDb";
import { type OwnedGames, SteamApi } from "../src/steam/SteamApi";

const steamUser: CurrentUserShape = {
  id: "u-steam",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: "76561197960287930",
};

type Game = { appId: number; name: string; playtimeMinutes: number };

/** Управляемый из теста Steam: что вернёт следующий `getOwnedGames`. */
const makeSteam = () => {
  const state = {
    next: Effect.succeed<OwnedGames>({
      _tag: "Games",
      games: [],
    }) as Effect.Effect<OwnedGames, SteamUnavailable>,
    calls: 0,
  };
  const games = (list: ReadonlyArray<Game>) => {
    state.next = Effect.succeed({ _tag: "Games", games: list });
  };
  const layer = Layer.succeed(
    SteamApi,
    SteamApi.of({
      getOwnedGames: () =>
        Effect.suspend(() => {
          state.calls++;
          return state.next;
        }),
    }),
  );
  return { state, games, layer };
};

/** ProtonDB-заглушка: запоминает appId; `tier` — ответ (по умолчанию gold). */
const makeProton = (
  tier: Effect.Effect<ProtonTier> = Effect.succeed("gold"),
) => {
  const calls: Array<number> = [];
  const layer = Layer.succeed(
    ProtonDb,
    ProtonDb.of({
      fetchTier: (appId) =>
        Effect.sync(() => calls.push(appId)).pipe(Effect.andThen(tier)),
    }),
  );
  return { calls, layer };
};

const fakeAuth = (current: CurrentUserShape | null) =>
  Layer.succeed(BetterAuth, {
    handler: async () => new Response(""),
    currentUser: () => Effect.succeed(Option.fromNullishOr(current)),
  });

/** RPC-хендлеры библиотеки + мидлвары поверх общей временной БД и заглушек. */
const env = (steam: Layer.Layer<SteamApi>, proton: Layer.Layer<ProtonDb>) =>
  Layer.mergeAll(LibraryRpcHandlers, RpcMiddlewares).pipe(
    Layer.provide(fakeAuth(steamUser)),
    Layer.provideMerge(Layer.mergeAll(steam, proton)),
    Layer.provideMerge(DbTest),
  );

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof env>> | Scope.Scope
  >,
  steam: Layer.Layer<SteamApi>,
  proton: Layer.Layer<ProtonDb>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(env(steam, proton))),
  );

const insertUser = (steamId: string | null = steamUser.steamId) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(user).values({
      id: steamUser.id,
      name: steamUser.name,
      email: `${steamUser.id}@steam.example`,
      steamId,
    });
  });

const userRow = Effect.gen(function* () {
  const db = yield* Db;
  const [row] = yield* db.select().from(user).where(eq(user.id, steamUser.id));
  return row;
});

const ownedAppIds = Effect.gen(function* () {
  const db = yield* Db;
  const rows = yield* db
    .select({ appId: userGames.appId })
    .from(userGames)
    .where(eq(userGames.userId, steamUser.id))
    .orderBy(userGames.appId);
  return rows.map((r) => r.appId);
});

const client = RpcTest.makeClient(LibraryRpcs);

const manyGames = (n: number): Array<Game> =>
  Array.from({ length: n }, (_, i) => ({
    appId: 1000 + i,
    name: `Game ${i}`,
    playtimeMinutes: i,
  }));

describe("library", () => {
  it("syncLibrary returns LibraryPrivate for empty response", async () => {
    const steam = makeSteam();
    steam.state.next = Effect.succeed({ _tag: "Private" });
    const result = await run(
      Effect.gen(function* () {
        yield* insertUser();
        const synced = yield* syncLibrary(steamUser.id, "76561197960287930");
        const view = yield* (yield* client)["library.list"]();
        const row = yield* userRow;
        return { synced, view, row };
      }),
      steam.layer,
      makeProton().layer,
    );
    expect(result.synced).toBe("Private");
    expect(result.view).toEqual({ _tag: "Private" });
    expect(result.row?.libraryPrivate).toBe(true);
    expect(result.row?.librarySyncedAt).toBeNull();
  });

  it("syncLibrary upserts 1500 games", async () => {
    const steam = makeSteam();
    steam.games(manyGames(1500));
    const result = await run(
      Effect.gen(function* () {
        yield* insertUser();
        const started = performance.now();
        const synced = yield* syncLibrary(steamUser.id, "76561197960287930");
        const elapsed = performance.now() - started;
        const db = yield* Db;
        const [owned] = yield* db
          .select({ n: count() })
          .from(userGames)
          .where(eq(userGames.userId, steamUser.id));
        const [catalog] = yield* db.select({ n: count() }).from(games);
        const row = yield* userRow;
        return { synced, elapsed, owned: owned?.n, catalog: catalog?.n, row };
      }),
      steam.layer,
      makeProton().layer,
    );
    expect(result.synced).toBe("Synced");
    expect(result.owned).toBe(1500);
    expect(result.catalog).toBe(1500);
    expect(result.elapsed).toBeLessThan(5000);
    expect(result.row?.librarySyncedAt).toBeInstanceOf(Date);
    expect(result.row?.libraryPrivate).toBe(false);
  });

  it("syncLibrary removes games no longer owned", async () => {
    const steam = makeSteam();
    const result = await run(
      Effect.gen(function* () {
        yield* insertUser();
        steam.games([
          { appId: 1, name: "One", playtimeMinutes: 1 },
          { appId: 2, name: "Two", playtimeMinutes: 2 },
          { appId: 3, name: "Three", playtimeMinutes: 3 },
        ]);
        yield* syncLibrary(steamUser.id, "76561197960287930");
        steam.games([
          { appId: 2, name: "Two", playtimeMinutes: 20 },
          { appId: 3, name: "Three (renamed)", playtimeMinutes: 3 },
          { appId: 4, name: "Four", playtimeMinutes: 4 },
        ]);
        yield* syncLibrary(steamUser.id, "76561197960287930");
        const owned = yield* ownedAppIds;
        const db = yield* Db;
        const catalog = yield* db
          .select({ appId: games.appId, name: games.name })
          .from(games)
          .orderBy(games.appId);
        const [two] = yield* db
          .select({ playtime: userGames.playtimeMinutes })
          .from(userGames)
          .where(eq(userGames.appId, 2));
        return { owned, catalog, playtime: two?.playtime };
      }),
      steam.layer,
      makeProton().layer,
    );
    expect(result.owned).toEqual([2, 3, 4]);
    expect(result.playtime).toBe(20);
    // Каталог игр общий: игра 1 остаётся, имя игры 3 обновлено.
    expect(result.catalog).toEqual([
      { appId: 1, name: "One" },
      { appId: 2, name: "Two" },
      { appId: 3, name: "Three (renamed)" },
      { appId: 4, name: "Four" },
    ]);
  });

  it("refresh failure keeps cached library", async () => {
    const steam = makeSteam();
    steam.games([
      { appId: 10, name: "Vampire Survivors", playtimeMinutes: 600 },
      { appId: 20, name: "Hades", playtimeMinutes: 300 },
    ]);
    const result = await run(
      Effect.gen(function* () {
        yield* insertUser();
        const rpc = yield* client;
        // librarySyncedAt пуст → list сначала синхронизирует.
        const before = yield* rpc["library.list"]();
        steam.state.next = Effect.fail(
          new SteamUnavailable({ reason: "unavailable" }),
        );
        const refresh = yield* Effect.result(rpc["library.refresh"]());
        const after = yield* rpc["library.list"]();
        return { before, refresh, after };
      }),
      steam.layer,
      makeProton(Effect.never).layer,
    );
    expect(result.before._tag).toBe("Ready");
    if (result.before._tag !== "Ready") return;
    expect(result.before.entries.map((e) => e.name)).toEqual([
      "Vampire Survivors",
      "Hades",
    ]);
    expect(result.before.syncedAt).not.toBeNull();
    expect(result.refresh._tag).toBe("Failure");
    if (result.refresh._tag === "Failure") {
      const failure = result.refresh.failure;
      expect(failure).toBeInstanceOf(SteamUnavailable);
      expect(failure._tag === "SteamUnavailable" && failure.reason).toBe(
        "unavailable",
      );
    }
    expect(result.after).toEqual(result.before);
    expect(steam.state.calls).toBe(2);
  });

  it("refreshTiers skips fresh tiers", async () => {
    const proton = makeProton(Effect.succeed("platinum"));
    const hour = 3_600_000;
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(games).values([
          {
            appId: 1,
            name: "Fresh",
            protonTier: "gold",
            protonCheckedAt: new Date(Date.now() - hour),
          },
          { appId: 2, name: "Never checked" },
          {
            appId: 3,
            name: "Stale",
            protonTier: "bronze",
            protonCheckedAt: new Date(Date.now() - 25 * hour),
          },
        ]);
        yield* refreshTiers([1, 2, 3]);
        return yield* db
          .select({
            appId: games.appId,
            tier: games.protonTier,
            checkedAt: games.protonCheckedAt,
          })
          .from(games)
          .where(inArray(games.appId, [1, 2, 3]))
          .orderBy(games.appId);
      }),
      makeSteam().layer,
      proton.layer,
    );
    expect(proton.calls.toSorted()).toEqual([2, 3]);
    expect(result.map((r) => r.tier)).toEqual(["gold", "platinum", "platinum"]);
    expect(result[1]?.checkedAt?.getTime()).toBeGreaterThan(Date.now() - hour);
  });

  it("list sorts by playtime desc then name", async () => {
    const steam = makeSteam();
    steam.games([
      { appId: 1, name: "Beta", playtimeMinutes: 10 },
      { appId: 2, name: "Alpha", playtimeMinutes: 10 },
      { appId: 3, name: "Zed", playtimeMinutes: 100 },
      { appId: 4, name: "Gamma", playtimeMinutes: 0 },
    ]);
    // ProtonDB «висит»: ответ list не ждёт фоновое обновление тиров.
    const view = await run(
      Effect.gen(function* () {
        yield* insertUser();
        return yield* (yield* client)["library.list"]();
      }),
      steam.layer,
      makeProton(Effect.never).layer,
    );
    expect(view._tag).toBe("Ready");
    if (view._tag !== "Ready") return;
    expect(view.entries.map((e) => e.name)).toEqual([
      "Zed",
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(view.entries[0]).toEqual({
      appId: 3,
      name: "Zed",
      playtimeMinutes: 100,
      protonTier: "pending",
      coverUrl:
        "https://cdn.cloudflare.steamstatic.com/steam/apps/3/library_600x900_2x.jpg",
    });
  });

  it("syncOnLogin syncs steam users and swallows steam failures", async () => {
    const steam = makeSteam();
    steam.games([{ appId: 7, name: "Seven", playtimeMinutes: 1 }]);
    const proton = makeProton(Effect.succeed("silver"));
    const result = await run(
      Effect.gen(function* () {
        yield* insertUser();
        yield* syncOnLogin(steamUser.id);
        const owned = yield* ownedAppIds;
        const db = yield* Db;
        const [game] = yield* db
          .select({ tier: games.protonTier })
          .from(games)
          .where(eq(games.appId, 7));
        steam.state.next = Effect.fail(
          new SteamUnavailable({ reason: "unauthorized" }),
        );
        // Ошибка Steam только логируется — эффект успешен.
        yield* syncOnLogin(steamUser.id);
        return { owned, tier: game?.tier, after: yield* ownedAppIds };
      }),
      steam.layer,
      proton.layer,
    );
    expect(result.owned).toEqual([7]);
    expect(result.tier).toBe("silver");
    expect(result.after).toEqual([7]);
    expect(steam.state.calls).toBe(2);
  });

  it("syncOnLogin skips users without steamId", async () => {
    const steam = makeSteam();
    await run(
      Effect.gen(function* () {
        yield* insertUser(null);
        yield* syncOnLogin(steamUser.id);
      }),
      steam.layer,
      makeProton().layer,
    );
    expect(steam.state.calls).toBe(0);
  });

  it("login hook forks sync and never fails login", async () => {
    const forked: Array<string> = [];
    const hooks = librarySyncHooks((userId) => {
      forked.push(userId);
      throw new Error("runtime closed");
    });
    const after = hooks.session?.create?.after;
    expect(after).toBeDefined();
    await expect(
      after?.(
        {
          id: "s-1",
          userId: "u-steam",
          token: "token",
          expiresAt: new Date(Date.now() + 3_600_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        null,
      ),
    ).resolves.toBeUndefined();
    expect(forked).toEqual(["u-steam"]);
  });

  it("tierLabel has russian text for every tier", () => {
    expect(tierLabel).toEqual({
      platinum: "Работает идеально",
      gold: "Работает после мелких настроек",
      silver: "Работает с недочётами",
      bronze: "Запускается, но играть тяжело",
      borked: "Скорее всего не запустится",
      pending: "Нет данных",
    });
    expect(coverUrl(570)).toBe(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/570/library_600x900_2x.jpg",
    );
  });
});
