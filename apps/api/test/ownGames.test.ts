// Свои игры в api (спека 2026-11-03 «Свои игры»): библиотека без Steam и при
// закрытом профиле, игровое время из отрезков, запуск без Steam, скрытая игра,
// страница игры без Steam Store и загрузчик каталога `games/*/game.json`.
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Db,
  games,
  ownGames,
  playSegments,
  sessions,
  syncOwnGames,
  user,
  userGames,
  workerClasses,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  type CurrentUserShape,
  LibraryRpcs,
  type OwnGameManifest,
  SessionRpcs,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import {
  loadOwnGameManifests,
  OwnGameCatalog,
} from "../src/library/OwnGameCatalog";
import { LibraryRpcHandlers } from "../src/library/rpc";
import { SessionEvents } from "../src/session/SessionEvents";
import { SessionRpcHandlers } from "../src/session/rpc";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamApi } from "../src/steam/SteamApi";
import { SteamStoreApi } from "../src/steam/SteamStoreApi";

/** Каталог репозитория: настоящий `games/soh/game.json`. */
const repoGamesDir = join(import.meta.dir, "../../../games");
const [soh] = loadOwnGameManifests(repoGamesDir).filter(
  (manifest) => manifest.slug === "soh",
);
if (soh === undefined) throw new Error("games/soh/game.json not found");
const SOH = soh.appId;

/** Вторая своя игра — только в БД, не в каталоге api. */
const other: OwnGameManifest = { ...soh, appId: SOH + 1, slug: "other" };

const noSteam: CurrentUserShape = {
  id: "u-own",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
};
const withSteam: CurrentUserShape = {
  ...noSteam,
  id: "u-own-steam",
  steamId: "76561197960287930",
};

const state = { current: noSteam };

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.sync(() => Option.some(state.current)),
});

// Ни Steam Web API, ни Steam Store, ни ProtonDB своим играм не нужны: любой
// вызов роняет тест.
const steamLayer = Layer.succeed(
  SteamApi,
  SteamApi.of({
    getOwnedGames: () => Effect.die("Steam Web API called for own games"),
    getAchievementSchema: () => Effect.die("Steam achievements called"),
    getPlayerAchievements: () => Effect.die("Steam achievements called"),
  }),
);
const storeLayer = Layer.succeed(
  SteamStoreApi,
  SteamStoreApi.of({
    fetchDetails: () => Effect.die("Steam Store called for an own game"),
  }),
);
const protonLayer = Layer.succeed(
  ProtonDb,
  ProtonDb.of({ fetchTier: () => Effect.die("ProtonDB called") }),
);

const env = Layer.mergeAll(
  LibraryRpcHandlers,
  SessionRpcHandlers,
  RpcMiddlewares,
).pipe(
  Layer.provide(fakeAuth),
  Layer.provide(SessionEvents.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      steamLayer,
      storeLayer,
      protonLayer,
      OwnGameCatalog.fromManifests([soh]),
    ),
  ),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
  current: CurrentUserShape = noSteam,
) => {
  state.current = current;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const library = RpcTest.makeClient(LibraryRpcs);
const session = RpcTest.makeClient(SessionRpcs);

const GiB = 1024 ** 3;

/**
 * Пользователи, обе свои игры в каталоге БД (как после `syncOwnGames` при
 * старте api), `published` — открыта ли SoH игрокам (`other` открыта всегда).
 */
const seed = (opts: { readonly published: boolean }) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(user).values(
      [noSteam, withSteam].map((u) => ({
        id: u.id,
        name: u.name,
        email: `${u.id}@example.test`,
        steamId: u.steamId,
      })),
    );
    yield* syncOwnGames([soh, other]);
    yield* db
      .update(ownGames)
      .set({ published: opts.published })
      .where(eq(ownGames.appId, SOH));
    yield* db
      .update(ownGames)
      .set({ published: true })
      .where(eq(ownGames.appId, other.appId));
  });

/** Воркер на связи, с классом, железом под требования SoH и её активным пакетом. */
const seedWorker = Effect.gen(function* () {
  const db = yield* Db;
  const [cls] = yield* db.select().from(workerClasses);
  yield* db.insert(workers).values({
    id: "w1",
    publicIp: "203.0.113.1",
    slots: 1,
    roles: ["worker"],
    classId: cls!.id,
    lastSeenAt: new Date(),
    hardware: {
      cpuModel: "Test CPU",
      cpuCores: 8,
      cpuThreads: 16,
      memoryBytes: 32 * GiB,
      gpus: [{ name: "Test GPU", memoryBytes: 8 * GiB }],
      disks: [],
    },
    stats: {
      cpuPercent: 0,
      memory: { totalBytes: 0, usedBytes: 0, cacheBytes: 0 },
      gpus: [],
      filesystems: [],
      uptimeSeconds: 0,
      ownGames: [{ slug: soh.slug, version: soh.version }],
    },
  });
});

const sohEntry = {
  appId: SOH,
  name: soh.name,
  playtimeMinutes: 0,
  protonTier: "pending",
  coverUrl: "/own-games/1900000001/cover.jpg",
  cloud: { _tag: "Ready" },
  lastPlayedAt: null,
} as const;

describe("own games", () => {
  it("user without Steam sees published own games in library", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* seed({ published: true });
        return yield* (yield* library)["library.list"]();
      }),
    );
    expect(view._tag).toBe("Ready");
    if (view._tag !== "Ready") return;
    expect(view.entries).toContainEqual(sohEntry);
    expect(view.entries.map((entry) => entry.appId).toSorted()).toEqual([
      SOH,
      other.appId,
    ]);
    expect(view.syncedAt).toBeNull();
    expect(view.steamProfile).toBe(false);
  });

  it("private Steam profile still lists own games", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* seed({ published: true });
        const db = yield* Db;
        // Steam уже синхронизировался и сказал «профиль скрыт»: старые
        // Steam-игры не показываются, свои — да.
        yield* db.insert(games).values({ appId: 10, name: "Hades" });
        yield* db
          .insert(userGames)
          .values({ userId: withSteam.id, appId: 10, playtimeMinutes: 5 });
        yield* db
          .update(user)
          .set({ libraryPrivate: true, librarySyncedAt: new Date() })
          .where(eq(user.id, withSteam.id));
        return yield* (yield* library)["library.list"]();
      }),
      withSteam,
    );
    expect(view._tag).toBe("Private");
    expect(view.entries).toContainEqual(sohEntry);
    expect(view.entries.map((entry) => entry.appId)).not.toContain(10);
  });

  it("own playtime comes from closed play segments", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed({ published: true });
        const db = yield* Db;
        const mine = crypto.randomUUID();
        const theirs = crypto.randomUUID();
        const t0 = Date.parse("2026-11-01T10:00:00.000Z");
        const at = (minutes: number) => new Date(t0 + minutes * 60_000);
        yield* db.insert(sessions).values([
          {
            id: mine,
            userId: noSteam.id,
            appId: SOH,
            state: "ended",
            createdAt: at(0),
            endedAt: at(60),
          },
          {
            id: theirs,
            userId: withSteam.id,
            appId: SOH,
            state: "ended",
            createdAt: at(0),
            endedAt: at(60),
          },
        ]);
        yield* db.insert(playSegments).values([
          // 30 мин + 15,5 мин закрытых → 45 (вниз от 45,5).
          {
            sessionId: mine,
            userId: noSteam.id,
            appId: SOH,
            startedAt: at(0),
            endedAt: at(30),
            billable: true,
            open: false,
          },
          {
            sessionId: mine,
            userId: noSteam.id,
            appId: SOH,
            startedAt: at(40),
            endedAt: at(55.5),
            billable: false,
            open: false,
          },
          // Открытый отрезок и чужая сессия — не в счёт.
          {
            sessionId: mine,
            userId: noSteam.id,
            appId: SOH,
            startedAt: at(56),
            endedAt: at(59),
            billable: true,
            open: true,
          },
          {
            sessionId: theirs,
            userId: withSteam.id,
            appId: SOH,
            startedAt: at(0),
            endedAt: at(50),
            billable: true,
            open: false,
          },
        ]);
        const rpc = yield* library;
        const list = yield* rpc["library.list"]();
        const page = yield* rpc["library.game"]({ appId: SOH });
        return { list, page };
      }),
    );
    const entry = result.list.entries.find((e) => e.appId === SOH);
    expect(entry?.playtimeMinutes).toBe(45);
    expect(entry?.lastPlayedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(result.page.playtimeMinutes).toBe(45);
    expect(result.page.sessions).toHaveLength(1);
  });

  it("user without Steam can start a published own game", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* seed({ published: true });
        yield* seedWorker;
        return yield* (yield* session)["session.start"]({ appId: SOH });
      }),
    );
    expect(view).toMatchObject({
      appId: SOH,
      gameName: soh.name,
      state: "queued",
    });
  });

  it("unpublished own game is not found and not startable", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed({ published: false });
        yield* seedWorker;
        const rpc = yield* library;
        const list = yield* rpc["library.list"]();
        const page = yield* Effect.flip(rpc["library.game"]({ appId: SOH }));
        const start = yield* Effect.flip(
          (yield* session)["session.start"]({ appId: SOH }),
        );
        // Открыта в БД, но api не знает её описания (нет в каталоге) — тоже
        // «не найдена».
        const notInCatalog = yield* Effect.flip(
          rpc["library.game"]({ appId: other.appId }),
        );
        const db = yield* Db;
        const rows = yield* db.select().from(sessions);
        return { list, page, start, notInCatalog, rows };
      }),
    );
    expect(result.list.entries.map((entry) => entry.appId)).toEqual([
      other.appId,
    ]);
    expect(result.page).toMatchObject({ _tag: "GameNotFound", appId: SOH });
    expect(result.start).toMatchObject({ _tag: "GameNotOwned", appId: SOH });
    expect(result.notInCatalog).toMatchObject({
      _tag: "GameNotFound",
      appId: other.appId,
    });
    expect(result.rows).toHaveLength(0);
  });

  it("own game page has own info and never calls Steam Store", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* seed({ published: true });
        yield* seedWorker;
        return yield* (yield* library)["library.game"]({ appId: SOH });
      }),
      withSteam,
    );
    expect(view).toEqual({
      appId: SOH,
      name: soh.name,
      coverUrl: "/own-games/1900000001/cover.jpg",
      cloud: { _tag: "Ready" },
      protonTier: "pending",
      inLibrary: true,
      playtimeMinutes: 0,
      sizeBytes: null,
      lastSession: null,
      sessions: [],
      details: null,
      achievements: { _tag: "None" },
      available: true,
      own: {
        description: soh.site.description,
        controls: soh.site.controls,
        source: soh.site.source,
        screenshots: soh.site.screenshots.map(
          (file) => `/own-games/1900000001/${file}`,
        ),
      },
    });
    expect(view.own?.screenshots).toContain("/own-games/1900000001/shot-1.jpg");
  });

  it("catalog loader rejects slug mismatch and duplicate appId", async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-own-games-"));
    const put = async (
      dir: string,
      gameDir: string,
      manifest: OwnGameManifest,
    ) => {
      await mkdir(join(dir, gameDir), { recursive: true });
      await writeFile(
        join(dir, gameDir, "game.json"),
        JSON.stringify(manifest),
      );
    };
    try {
      // Годный каталог: каталог без game.json пропускается.
      const ok = join(root, "ok");
      await put(ok, "soh", soh);
      await mkdir(join(ok, "notes"), { recursive: true });
      expect(loadOwnGameManifests(ok).map((m) => m.slug)).toEqual(["soh"]);

      const mismatch = join(root, "mismatch");
      await put(mismatch, "zelda", soh);
      expect(() => loadOwnGameManifests(mismatch)).toThrow(
        join(mismatch, "zelda", "game.json"),
      );

      const duplicate = join(root, "duplicate");
      await put(duplicate, "soh", soh);
      await put(duplicate, "soh2", { ...soh, slug: "soh2" });
      expect(() => loadOwnGameManifests(duplicate)).toThrow(
        join(duplicate, "soh2", "game.json"),
      );
      expect(() => loadOwnGameManifests(duplicate)).toThrow(String(SOH));

      const broken = join(root, "broken");
      await mkdir(join(broken, "soh"), { recursive: true });
      await writeFile(join(broken, "soh", "game.json"), '{"appId": 5}');
      expect(() => loadOwnGameManifests(broken)).toThrow(
        join(broken, "soh", "game.json"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
