// Статус облачной версии игры, облачный профиль Steam и время последней
// сессии в `library.list` — тесты CloudRepo и интеграция через RPC.
import { describe, expect, it } from "bun:test";
import {
  Db,
  gamestoreApps,
  games,
  installJobs,
  profiles,
  sessions,
  user,
  userGames,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, LibraryRpcs } from "@cg/rpc";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import * as CloudRepo from "../src/library/CloudRepo";
import { OwnGameCatalog } from "../src/library/OwnGameCatalog";
import { LibraryRpcHandlers } from "../src/library/rpc";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamApi } from "../src/steam/SteamApi";
import { SteamStoreApi } from "../src/steam/SteamStoreApi";

/** Пользователь без Steam: `library.list` не пытается синхронизироваться. */
const cloudUser: CurrentUserShape = {
  id: "u-cloud",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
};

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.succeed(Option.some(cloudUser)),
});

// `getOwnedGames`/`fetchTier` не вызываются: у `cloudUser` нет `steamId`. Заглушки
// нужны только чтобы удовлетворить тип окружения хендлера `library.list`.
const steamLayer = Layer.succeed(
  SteamApi,
  SteamApi.of({
    getOwnedGames: () => Effect.die("not used in cloud tests"),
    getAchievementSchema: () => Effect.die("not used in cloud tests"),
    getPlayerAchievements: () => Effect.die("not used in cloud tests"),
  }),
);
const protonLayer = Layer.succeed(
  ProtonDb,
  ProtonDb.of({ fetchTier: () => Effect.die("not used in cloud tests") }),
);

const storeLayer = Layer.succeed(
  SteamStoreApi,
  SteamStoreApi.of({
    fetchDetails: () => Effect.die("not used in cloud tests"),
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

const insertUser = (db: Db["Service"], id: string = cloudUser.id) =>
  db.insert(user).values({ id, name: "Игрок", email: `${id}@example.test` });

const insertGames = (db: Db["Service"], appIds: ReadonlyArray<number>) =>
  db
    .insert(games)
    .values(appIds.map((appId) => ({ appId, name: `Game ${appId}` })));

const insertOwned = (
  db: Db["Service"],
  userId: string,
  appIds: ReadonlyArray<number>,
) => db.insert(userGames).values(appIds.map((appId) => ({ userId, appId })));

const client = RpcTest.makeClient(LibraryRpcs);

describe("cloud status and steam profile in library.list", () => {
  it("cloud statuses: ready, installing with percent, installing without size, missing", async () => {
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        yield* insertGames(db, [1, 2, 3, 4]);
        yield* insertOwned(db, cloudUser.id, [1, 2, 3, 4]);
        // Библиотека своя у каждого сервера (спека §5) — нужен владелец строки.
        yield* db
          .insert(workers)
          .values({ id: "gs1", publicIp: "203.0.113.8", slots: 0 });
        yield* db.insert(gamestoreApps).values({
          workerId: "gs1",
          appId: 1,
          sizeBytes: 1000,
          buildId: "b1",
        });
        yield* db.insert(installJobs).values([
          {
            id: crypto.randomUUID(),
            appId: 2,
            userId: cloudUser.id,
            state: "running",
            bytesDownloaded: 50,
            bytesTotal: 100,
          },
          {
            id: crypto.randomUUID(),
            appId: 3,
            userId: cloudUser.id,
            state: "queued",
          },
        ]);
        return yield* (yield* client)["library.list"]();
      }),
    );
    expect(view._tag).toBe("Ready");
    if (view._tag !== "Ready") return;
    const byId = new Map(view.entries.map((e) => [e.appId, e.cloud]));
    expect(byId.get(1)).toEqual({ _tag: "Ready" });
    expect(byId.get(2)).toEqual({ _tag: "Installing", percent: 50 });
    expect(byId.get(3)).toEqual({ _tag: "Installing", percent: null });
    expect(byId.get(4)).toEqual({ _tag: "Missing" });
  });

  it("done install jobs do not count as installing", async () => {
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        yield* insertGames(db, [2]);
        yield* insertOwned(db, cloudUser.id, [2]);
        yield* db.insert(installJobs).values({
          id: crypto.randomUUID(),
          appId: 2,
          userId: cloudUser.id,
          state: "done",
        });
        return yield* (yield* client)["library.list"]();
      }),
    );
    expect(view._tag).toBe("Ready");
    if (view._tag !== "Ready") return;
    expect(view.entries[0]?.cloud).toEqual({ _tag: "Missing" });
  });

  it("steamProfile reflects profiles row", async () => {
    const without = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        return yield* (yield* client)["library.list"]();
      }),
    );
    expect(without._tag).toBe("Ready");
    if (without._tag === "Ready") expect(without.steamProfile).toBe(false);

    const withProfile = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        yield* db.insert(profiles).values({
          userId: cloudUser.id,
          version: 1,
          objectKey: `profiles/${cloudUser.id}/x.cgp`,
          sizeBytes: 10,
        });
        return yield* (yield* client)["library.list"]();
      }),
    );
    expect(withProfile._tag).toBe("Ready");
    if (withProfile._tag === "Ready")
      expect(withProfile.steamProfile).toBe(true);
  });

  it("cloudStatuses([]) returns empty map without a db query", async () => {
    const statuses = await run(CloudRepo.cloudStatuses([]));
    expect(statuses.size).toBe(0);
  });

  it("lastPlayedAt: failed-only session is null, newer of two sessions wins", async () => {
    const view = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db);
        yield* insertGames(db, [1, 2]);
        yield* insertOwned(db, cloudUser.id, [1, 2]);
        yield* db.insert(sessions).values({
          id: crypto.randomUUID(),
          userId: cloudUser.id,
          appId: 1,
          state: "failed",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        });
        yield* db.insert(sessions).values([
          {
            id: crypto.randomUUID(),
            userId: cloudUser.id,
            appId: 2,
            state: "ended",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            id: crypto.randomUUID(),
            userId: cloudUser.id,
            appId: 2,
            state: "ended",
            createdAt: new Date("2026-02-01T00:00:00Z"),
          },
        ]);
        return yield* (yield* client)["library.list"]();
      }),
    );
    expect(view._tag).toBe("Ready");
    if (view._tag !== "Ready") return;
    const byId = new Map(view.entries.map((e) => [e.appId, e.lastPlayedAt]));
    expect(byId.get(1)).toBeNull();
    expect(byId.get(2)).toBe(new Date("2026-02-01T00:00:00Z").toISOString());
  });
});
