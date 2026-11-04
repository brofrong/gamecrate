// RPC `admin.games.*`/`admin.installs.*`: игры общей библиотеки (список,
// удаление) и задачи установки (список, отмена), по образцу adminWorkers.test.ts.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  Db,
  games,
  gamestoreApps,
  installJobs,
  ownGames,
  sessions,
  user,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs, OWN_APP_ID_MIN } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import {
  loadOwnGameManifests,
  OwnGameCatalog,
} from "../src/library/OwnGameCatalog";

const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};
const player: CurrentUserShape = { ...admin, id: "u-player", role: "player" };

const auth = { current: admin as CurrentUserShape | null };
const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.sync(() => Option.fromNullishOr(auth.current)),
});

/** Настоящий `games/soh/game.json` — образец для манифестов каталога. */
const [sohManifest] = loadOwnGameManifests(
  join(import.meta.dir, "../../../games"),
);
if (sohManifest === undefined) throw new Error("games/*/game.json not found");

/**
 * Каталог api: свои сборки alpha и zeta (`OWN_APP_ID_MIN`, `+1`). Строки
 * `own_games` с другим appId каталог не знает (`game.json` убрали).
 */
const catalog = OwnGameCatalog.fromManifests(
  (["alpha", "zeta"] as const).map((slug, i) => ({
    ...sohManifest,
    appId: OWN_APP_ID_MIN + i,
    slug,
  })),
);

const env = Layer.mergeAll(AdminRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provide(catalog),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => {
  auth.current = admin;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(AdminRpcs);

const insertUser = (db: Db["Service"], id: string, name = id) =>
  db.insert(user).values({ id, name, email: `${id}@example.test` });

const insertGame = (db: Db["Service"], appId: number, name: string) =>
  db.insert(games).values({ appId, name });

const insertWorker = (
  db: Db["Service"],
  values: Partial<typeof workers.$inferInsert> & { id: string },
) =>
  db.insert(workers).values({
    publicIp: "37.153.14.138",
    slots: 2,
    ...values,
  });

const insertSession = (
  db: Db["Service"],
  values: Partial<typeof sessions.$inferInsert> & {
    id: string;
    userId: string;
    appId: number;
  },
) => db.insert(sessions).values(values);

const insertGamestoreApp = (
  db: Db["Service"],
  values: Partial<typeof gamestoreApps.$inferInsert> & {
    appId: number;
    sizeBytes: number;
    buildId: string;
  },
) => db.insert(gamestoreApps).values(values);

const insertInstallJob = (
  db: Db["Service"],
  values: Partial<typeof installJobs.$inferInsert> & {
    id: string;
    appId: number;
    userId: string;
  },
) => db.insert(installJobs).values(values);

const insertOwnGame = (
  db: Db["Service"],
  values: Partial<typeof ownGames.$inferInsert> & {
    appId: number;
    slug: string;
    version: string;
  },
) => db.insert(ownGames).values(values);

describe("admin.games", () => {
  const seedGames = (db: Db["Service"]) =>
    Effect.gen(function* () {
      yield* insertUser(db, "u1", "Alice");
      yield* insertUser(db, "u2", "Bob");
      yield* insertGame(db, 100, "Balatro");
      yield* insertGame(db, 200, "Peglin");
      yield* insertGamestoreApp(db, {
        appId: 100,
        sizeBytes: 64 * 1024 * 1024,
        buildId: "b1",
      });
      yield* insertGamestoreApp(db, {
        appId: 200,
        sizeBytes: 317 * 1024 * 1024,
        buildId: "b2",
      });
    });

  it("games.list: launches/activeSessions по сессиям, служебные пакеты из стат воркера", async () => {
    const now = new Date();
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGames(db);
        yield* insertWorker(db, { id: "w1" });
        // 3 размещённых сессии Peglin (последняя — lastLaunchAt).
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 200,
          workerId: "w1",
          slot: 0,
          state: "ended",
          createdAt: new Date(now.getTime() - 3000),
          endedAt: new Date(now.getTime() - 2000),
          slotReleasedAt: new Date(now.getTime() - 2000),
        });
        yield* insertSession(db, {
          id: "22222222-2222-2222-2222-222222222222",
          userId: "u1",
          appId: 200,
          workerId: "w1",
          slot: 0,
          state: "ended",
          createdAt: new Date(now.getTime() - 2000),
          endedAt: new Date(now.getTime() - 1000),
          slotReleasedAt: new Date(now.getTime() - 1000),
        });
        yield* insertSession(db, {
          id: "33333333-3333-3333-3333-333333333333",
          userId: "u1",
          appId: 200,
          workerId: "w1",
          slot: 0,
          state: "playing",
          createdAt: new Date(now.getTime() - 1000),
        });
        // Queued без воркера: не считается в launches, но считается в activeSessions.
        yield* insertSession(db, {
          id: "44444444-4444-4444-4444-444444444444",
          userId: "u2",
          appId: 200,
          state: "queued",
          createdAt: now,
        });
        yield* insertWorker(db, {
          id: "gamestore-1",
          roles: ["gamestore"],
          statsAt: now,
          stats: {
            cpuPercent: 1,
            memory: { totalBytes: 0, usedBytes: 0, cacheBytes: 0 },
            gpus: [],
            filesystems: [],
            uptimeSeconds: 0,
            library: [
              {
                appId: 1493710,
                name: "Proton Experimental",
                sizeBytes: 1_610_612_736,
              },
            ],
          } as never,
        });

        const rpc = yield* client;
        return yield* rpc["admin.games.list"]();
      }),
    );
    // По размеру убыв.
    expect(result.games.map((g) => g.appId)).toEqual([200, 100]);
    const peglin = result.games.find((g) => g.appId === 200);
    expect(peglin?.launches).toBe(3);
    expect(peglin?.activeSessions).toBe(2);
    expect(peglin?.lastLaunchAt).toBe(
      new Date(now.getTime() - 1000).toISOString(),
    );
    expect(peglin?.installing).toBe(false);
    expect(peglin?.deleting).toBe(false);
    const balatro = result.games.find((g) => g.appId === 100);
    expect(balatro?.launches).toBe(0);
    expect(balatro?.activeSessions).toBe(0);
    expect(result.service).toEqual({
      count: 1,
      names: ["Proton Experimental"],
      sizeBytes: 1_610_612_736,
    });
  });

  it("games.list: deleteError surfaces the stored reason, null otherwise", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGames(db);
        yield* db
          .update(gamestoreApps)
          .set({ deleteError: "Игра запущена" })
          .where(eq(gamestoreApps.appId, 100));

        const rpc = yield* client;
        return yield* rpc["admin.games.list"]();
      }),
    );
    const balatro = result.games.find((g) => g.appId === 100);
    expect(balatro?.deleteError).toBe("Игра запущена");
    const peglin = result.games.find((g) => g.appId === 200);
    expect(peglin?.deleteError).toBeNull();
  });

  it("games.delete: a new request clears the previous delete_error immediately", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGames(db);
        yield* db
          .update(gamestoreApps)
          .set({ deleteError: "Игра запущена" })
          .where(eq(gamestoreApps.appId, 100));

        const started = yield* (yield* client)["admin.games.delete"]({
          appId: 100,
        });
        const [row] = yield* db
          .select({ deleteError: gamestoreApps.deleteError })
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, 100));
        return { started, deleteError: row?.deleteError };
      }),
    );
    expect(result.started).toBe("started");
    expect(result.deleteError).toBeNull();
  });

  it("games.delete: free app marks deleting_at once, active session/job → inUse, unknown → notFound", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGames(db);

        const started = yield* (yield* client)["admin.games.delete"]({
          appId: 100,
        });
        const [rowAfterFirst] = yield* db
          .select({ deletingAt: gamestoreApps.deletingAt })
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, 100));
        yield* Effect.sleep("10 millis");
        const startedAgain = yield* (yield* client)["admin.games.delete"]({
          appId: 100,
        });
        const [rowAfterSecond] = yield* db
          .select({ deletingAt: gamestoreApps.deletingAt })
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, 100));

        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 200,
          state: "playing",
        });
        const inUseBySession = yield* (yield* client)["admin.games.delete"]({
          appId: 200,
        });

        yield* insertInstallJob(db, {
          id: "job-1",
          appId: 100,
          userId: "u1",
          state: "queued",
        });
        const inUseByJob = yield* (yield* client)["admin.games.delete"]({
          appId: 100,
        });

        const notFound = yield* (yield* client)["admin.games.delete"]({
          appId: 1493710,
        });

        return {
          started,
          startedAgain,
          inUseBySession,
          inUseByJob,
          notFound,
          deletingAtFirst: rowAfterFirst?.deletingAt,
          deletingAtSecond: rowAfterSecond?.deletingAt,
        };
      }),
    );
    expect(result.started).toBe("started");
    expect(result.deletingAtFirst).not.toBeNull();
    expect(result.startedAgain).toBe("started");
    expect(result.deletingAtSecond?.getTime()).toBe(
      result.deletingAtFirst?.getTime(),
    );
    expect(result.inUseBySession).toBe("inUse");
    expect(result.inUseByJob).toBe("inUse");
    expect(result.notFound).toBe("notFound");
  });

  it("games.delete: ended session still holding a slot (container not released yet) → inUse", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedGames(db);
        yield* insertWorker(db, { id: "w1" });
        // state уже терминальный, но slotReleasedAt ещё null — агент не
        // прислал Stopped/Failed, контейнер на GPU воркера жив.
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 100,
          workerId: "w1",
          slot: 0,
          state: "ended",
          endedAt: new Date(),
        });

        return yield* (yield* client)["admin.games.delete"]({ appId: 100 });
      }),
    );
    expect(result).toBe("inUse");
  });
});

describe("admin.games (свои сборки)", () => {
  const ALPHA = OWN_APP_ID_MIN;
  const ZETA = OWN_APP_ID_MIN + 1;

  const seedOwnGames = (db: Db["Service"]) =>
    Effect.gen(function* () {
      yield* insertUser(db, "u1", "Alice");
      yield* insertUser(db, "u2", "Bob");
      yield* insertGame(db, ALPHA, "Alpha Game");
      yield* insertGame(db, ZETA, "Zeta Game");
      yield* insertOwnGame(db, { appId: ALPHA, slug: "alpha", version: "1.0.0" });
      yield* insertOwnGame(db, { appId: ZETA, slug: "zeta", version: "2.0.0" });
    });

  it("admin list shows own games with workers that have the active package", async () => {
    const now = new Date();
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedOwnGames(db);

        // w1 — активный пакет alpha ровно этой версии: считается.
        yield* insertWorker(db, {
          id: "w1",
          roles: ["worker"],
          stats: {
            cpuPercent: 0,
            memory: { totalBytes: 0, usedBytes: 0, cacheBytes: 0 },
            gpus: [],
            filesystems: [],
            uptimeSeconds: 0,
            ownGames: [{ slug: "alpha", version: "1.0.0" }],
          } as never,
        });
        // w2 — устаревшая версия alpha: не считается.
        yield* insertWorker(db, {
          id: "w2",
          roles: ["worker"],
          stats: {
            cpuPercent: 0,
            memory: { totalBytes: 0, usedBytes: 0, cacheBytes: 0 },
            gpus: [],
            filesystems: [],
            uptimeSeconds: 0,
            ownGames: [{ slug: "alpha", version: "0.9.0" }],
          } as never,
        });
        // w3 — роль gamestore, не worker: не считается, даже с подходящим пакетом.
        yield* insertWorker(db, {
          id: "w3",
          roles: ["gamestore"],
          stats: {
            cpuPercent: 0,
            memory: { totalBytes: 0, usedBytes: 0, cacheBytes: 0 },
            gpus: [],
            filesystems: [],
            uptimeSeconds: 0,
            ownGames: [{ slug: "alpha", version: "1.0.0" }],
          } as never,
        });

        // Alpha: одна размещённая сессия (launches/lastLaunchAt) и одна queued (activeSessions).
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: ALPHA,
          workerId: "w1",
          slot: 0,
          state: "playing",
          createdAt: new Date(now.getTime() - 1000),
        });
        yield* insertSession(db, {
          id: "22222222-2222-2222-2222-222222222222",
          userId: "u2",
          appId: ALPHA,
          state: "queued",
          createdAt: now,
        });

        const rpc = yield* client;
        return yield* rpc["admin.games.list"]();
      }),
    );

    // По имени: «Alpha Game» раньше «Zeta Game».
    expect(result.own.map((g) => g.name)).toEqual(["Alpha Game", "Zeta Game"]);
    const alpha = result.own.find((g) => g.appId === ALPHA);
    expect(alpha?.slug).toBe("alpha");
    expect(alpha?.version).toBe("1.0.0");
    expect(alpha?.published).toBe(false);
    expect(alpha?.workers).toEqual(["w1"]);
    expect(alpha?.launches).toBe(1);
    expect(alpha?.lastLaunchAt).toBe(
      new Date(now.getTime() - 1000).toISOString(),
    );
    expect(alpha?.activeSessions).toBe(2);
    const zeta = result.own.find((g) => g.appId === ZETA);
    expect(zeta?.workers).toEqual([]);
    expect(zeta?.launches).toBe(0);
    expect(zeta?.lastLaunchAt).toBeNull();
    expect(zeta?.activeSessions).toBe(0);
  });

  it("setPublished: a game the api catalog no longer knows is notFound and stays closed", async () => {
    // Строка в БД есть, а `game.json` из репозитория убрали: открытая, она
    // вела бы с плитки на «игра не найдена».
    const GONE = OWN_APP_ID_MIN + 2;
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedOwnGames(db);
        yield* insertGame(db, GONE, "Gone Game");
        yield* insertOwnGame(db, {
          appId: GONE,
          slug: "gone",
          version: "1.0.0",
        });

        const rpc = yield* client;
        const answer = yield* rpc["admin.games.setPublished"]({
          appId: GONE,
          published: true,
        });
        const [row] = yield* db
          .select({ published: ownGames.published })
          .from(ownGames)
          .where(eq(ownGames.appId, GONE));
        return { answer, published: row?.published };
      }),
    );
    expect(result).toEqual({ answer: "notFound", published: false });
  });

  it("setPublished toggles and returns notFound for unknown appId", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedOwnGames(db);

        const rpc = yield* client;
        const opened = yield* rpc["admin.games.setPublished"]({
          appId: ALPHA,
          published: true,
        });
        const [afterOpen] = yield* db
          .select({ published: ownGames.published })
          .from(ownGames)
          .where(eq(ownGames.appId, ALPHA));
        const closed = yield* rpc["admin.games.setPublished"]({
          appId: ALPHA,
          published: false,
        });
        const [afterClose] = yield* db
          .select({ published: ownGames.published })
          .from(ownGames)
          .where(eq(ownGames.appId, ALPHA));
        const notFound = yield* rpc["admin.games.setPublished"]({
          appId: ALPHA + 100,
          published: true,
        });

        return {
          opened,
          closed,
          notFound,
          publishedAfterOpen: afterOpen?.published,
          publishedAfterClose: afterClose?.published,
        };
      }),
    );
    expect(result.opened).toBe("ok");
    expect(result.publishedAfterOpen).toBe(true);
    expect(result.closed).toBe("ok");
    expect(result.publishedAfterClose).toBe(false);
    expect(result.notFound).toBe("notFound");
  });
});

describe("admin.installs", () => {
  const seedInstalls = (db: Db["Service"]) =>
    Effect.gen(function* () {
      yield* insertUser(db, "u1", "Alice");
      yield* insertUser(db, "u2", "Bob");
      yield* insertGame(db, 100, "Balatro");
      yield* insertGame(db, 200, "Peglin");
      yield* insertGame(db, 300, "Celeste");
      yield* insertWorker(db, { id: "gamestore-1", roles: ["gamestore"] });
    });

  it("installs.list: running с waitingSessions, queued, done за 2 дня, failed за 10 дней не в recent", async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedInstalls(db);
        yield* insertInstallJob(db, {
          id: "job-running",
          appId: 100,
          userId: "u1",
          state: "running",
          workerId: "gamestore-1",
          stage: "downloading",
          bytesDownloaded: 1000,
          bytesTotal: 2000,
        });
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 100,
          state: "installing",
          installJobId: "job-running",
        });
        yield* insertSession(db, {
          id: "22222222-2222-2222-2222-222222222222",
          userId: "u2",
          appId: 100,
          state: "installing",
          installJobId: "job-running",
        });
        yield* insertInstallJob(db, {
          id: "job-queued",
          appId: 200,
          userId: "u1",
          state: "queued",
        });
        yield* insertInstallJob(db, {
          id: "job-done",
          appId: 300,
          userId: "u1",
          state: "done",
          updatedAt: new Date(now.getTime() - 2 * dayMs),
        });
        yield* insertInstallJob(db, {
          id: "job-failed-old",
          appId: 300,
          userId: "u1",
          state: "failed",
          error: "boom",
          updatedAt: new Date(now.getTime() - 10 * dayMs),
        });

        const rpc = yield* client;
        return yield* rpc["admin.installs.list"]();
      }),
    );
    // Старые сверху среди активных (job-running вставлена раньше job-queued).
    expect(result.active.map((i) => i.id)).toEqual([
      "job-running",
      "job-queued",
    ]);
    const running = result.active.find((i) => i.id === "job-running");
    expect(running?.waitingSessions).toBe(2);
    expect(running?.bytesDownloaded).toBe(1000);
    expect(running?.bytesTotal).toBe(2000);
    expect(running?.stage).toBe("downloading");
    // Новые сверху, только за 7 дней.
    expect(result.recent.map((i) => i.id)).toEqual(["job-done"]);
  });

  it("installs.cancel: активная помечается один раз, done/неизвестная — false", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedInstalls(db);
        yield* insertInstallJob(db, {
          id: "job-running",
          appId: 100,
          userId: "u1",
          state: "running",
          workerId: "gamestore-1",
        });
        yield* insertInstallJob(db, {
          id: "job-done",
          appId: 200,
          userId: "u1",
          state: "done",
        });

        const rpc = yield* client;
        const first = yield* rpc["admin.installs.cancel"]({
          jobId: "job-running",
        });
        const [rowAfterFirst] = yield* db
          .select({ cancelRequestedAt: installJobs.cancelRequestedAt })
          .from(installJobs)
          .where(eq(installJobs.id, "job-running"));
        yield* Effect.sleep("10 millis");
        const second = yield* rpc["admin.installs.cancel"]({
          jobId: "job-running",
        });
        const [rowAfterSecond] = yield* db
          .select({ cancelRequestedAt: installJobs.cancelRequestedAt })
          .from(installJobs)
          .where(eq(installJobs.id, "job-running"));

        const done = yield* rpc["admin.installs.cancel"]({
          jobId: "job-done",
        });
        const unknown = yield* rpc["admin.installs.cancel"]({
          jobId: "no-such-job",
        });

        return {
          first,
          second,
          done,
          unknown,
          cancelRequestedAtFirst: rowAfterFirst?.cancelRequestedAt,
          cancelRequestedAtSecond: rowAfterSecond?.cancelRequestedAt,
        };
      }),
    );
    expect(result.first).toBe(true);
    expect(result.second).toBe(true);
    expect(result.cancelRequestedAtFirst).not.toBeNull();
    expect(result.cancelRequestedAtSecond?.getTime()).toBe(
      result.cancelRequestedAtFirst?.getTime(),
    );
    expect(result.done).toBe(false);
    expect(result.unknown).toBe(false);
  });
});

describe("admin.games/installs access", () => {
  it("player gets Forbidden on every new admin method", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = player;
        const rpc = yield* client;
        const gamesList = yield* Effect.flip(rpc["admin.games.list"]());
        const gamesDelete = yield* Effect.flip(
          rpc["admin.games.delete"]({ appId: 100 }),
        );
        const installsList = yield* Effect.flip(rpc["admin.installs.list"]());
        const installsCancel = yield* Effect.flip(
          rpc["admin.installs.cancel"]({ jobId: "x" }),
        );
        const setPublished = yield* Effect.flip(
          rpc["admin.games.setPublished"]({ appId: 100, published: true }),
        );
        return {
          gamesList,
          gamesDelete,
          installsList,
          installsCancel,
          setPublished,
        };
      }),
    );
    expect(result.gamesList._tag).toBe("Forbidden");
    expect(result.gamesDelete._tag).toBe("Forbidden");
    expect(result.installsList._tag).toBe("Forbidden");
    expect(result.installsCancel._tag).toBe("Forbidden");
    expect(result.setPublished._tag).toBe("Forbidden");
  });
});
