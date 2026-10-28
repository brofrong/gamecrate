// RPC `admin.users.*`: список пользователей (без Steam-секретов), роль,
// блокировка (останавливает активную сессию) и сброс входа Steam, по образцу
// adminGames.test.ts.
import { describe, expect, it } from "bun:test";
import {
  account,
  Db,
  games,
  playSegments,
  profiles,
  sessions,
  user,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import { resetSteamLogin } from "../src/admin/users";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";

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

const env = Layer.mergeAll(AdminRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => {
  auth.current = admin;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(AdminRpcs);

const insertUser = (
  db: Db["Service"],
  values: Partial<typeof user.$inferInsert> & { id: string },
) =>
  db.insert(user).values({
    name: values.id,
    email: `${values.id}@example.test`,
    ...values,
  });

const insertAdminAndPlayer = (db: Db["Service"]) =>
  Effect.gen(function* () {
    yield* insertUser(db, { id: admin.id, name: admin.name, role: "admin" });
    yield* insertUser(db, { id: player.id, name: player.name });
  });

describe("admin.users.list", () => {
  it("list returns users without Steam secrets", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdminAndPlayer(db);
        yield* db.insert(user).values({
          id: "u1",
          name: "Alice",
          email: "alice@example.test",
          steamId: "76561198000000001",
        });
        yield* db.insert(account).values([
          {
            id: "acc-u1-steam",
            accountId: "76561198000000001",
            providerId: "steam",
            userId: "u1",
            accessToken: "secret-access-token",
            refreshToken: "secret-refresh-token",
          },
          {
            id: "acc-u1-pocket",
            accountId: "pocket-sub-u1",
            providerId: "pocket-id",
            userId: "u1",
          },
        ]);
        yield* db.insert(profiles).values({
          userId: "u1",
          version: 3,
          objectKey: "profiles/u1/x.cgp",
          sizeBytes: 1234,
        });
        yield* db.insert(games).values({ appId: 10, name: "Hades" });
        yield* db.insert(sessions).values({
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 10,
          state: "ended",
          endedAt: new Date(),
        });
        // Два закрытых billable-отрезка по 60 с и один не-billable (не считается).
        yield* db.insert(playSegments).values([
          {
            sessionId: "11111111-1111-1111-1111-111111111111",
            userId: "u1",
            appId: 10,
            startedAt: new Date(0),
            endedAt: new Date(60_000),
            billable: true,
            open: false,
          },
          {
            sessionId: "11111111-1111-1111-1111-111111111111",
            userId: "u1",
            appId: 10,
            startedAt: new Date(60_000),
            endedAt: new Date(120_000),
            billable: true,
            open: false,
          },
          {
            sessionId: "11111111-1111-1111-1111-111111111111",
            userId: "u1",
            appId: 10,
            startedAt: new Date(120_000),
            endedAt: new Date(180_000),
            billable: false,
            open: false,
          },
        ]);

        const rpc = yield* client;
        return yield* rpc["admin.users.list"]();
      }),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-access-token");
    expect(serialized).not.toContain("secret-refresh-token");

    const alice = result.find((u) => u.id === "u1");
    expect(alice?.providers).toEqual(["pocket-id", "steam"]);
    expect(alice?.playedSeconds).toBe(120);
    expect(alice?.profileSizeBytes).toBe(1234);
    expect(alice?.profileVersion).toBe(3);
    expect(alice?.steamId).toBe("76561198000000001");
    expect(alice?.blockedAt).toBeNull();
    expect(alice?.steamLoginResetPending).toBe(false);
  });

  it("synthetic email is null", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdminAndPlayer(db);
        yield* db.insert(user).values({
          id: "u-steam",
          name: "SteamUser",
          email: "steam_76561198000000002@cloudgaming.local",
          steamId: "76561198000000002",
        });
        const rpc = yield* client;
        return yield* rpc["admin.users.list"]();
      }),
    );
    const steamUser = result.find((u) => u.id === "u-steam");
    expect(steamUser?.email).toBeNull();
  });
});

describe("admin.users.setRole", () => {
  it("changes role; self and unknown", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdminAndPlayer(db);
        const rpc = yield* client;

        const ok = yield* rpc["admin.users.setRole"]({
          userId: player.id,
          role: "admin",
        });
        const [rowAfterOk] = yield* db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, player.id));

        const self = yield* rpc["admin.users.setRole"]({
          userId: admin.id,
          role: "player",
        });
        const [rowAfterSelf] = yield* db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, admin.id));

        const notFound = yield* rpc["admin.users.setRole"]({
          userId: "no-such-user",
          role: "admin",
        });

        return { ok, self, notFound, roleAfterOk: rowAfterOk?.role, roleAfterSelf: rowAfterSelf?.role };
      }),
    );
    expect(result.ok).toBe("ok");
    expect(result.roleAfterOk).toBe("admin");
    expect(result.self).toBe("self");
    expect(result.roleAfterSelf).toBe("admin");
    expect(result.notFound).toBe("notFound");
  });
});

describe("admin.users.setBlocked", () => {
  it("stops the active session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdminAndPlayer(db);
        yield* db.insert(games).values({ appId: 10, name: "Hades" });
        yield* db.insert(sessions).values({
          id: "11111111-1111-1111-1111-111111111111",
          userId: player.id,
          appId: 10,
          state: "queued",
        });
        const rpc = yield* client;

        const ok = yield* rpc["admin.users.setBlocked"]({
          userId: player.id,
          blocked: true,
        });
        const [rowAfterFirst] = yield* db
          .select({ blockedAt: user.blockedAt })
          .from(user)
          .where(eq(user.id, player.id));
        const [sessionAfter] = yield* db
          .select({ stopRequestedAt: sessions.stopRequestedAt })
          .from(sessions)
          .where(eq(sessions.id, "11111111-1111-1111-1111-111111111111"));

        yield* Effect.sleep("10 millis");
        const okAgain = yield* rpc["admin.users.setBlocked"]({
          userId: player.id,
          blocked: true,
        });
        const [rowAfterSecond] = yield* db
          .select({ blockedAt: user.blockedAt })
          .from(user)
          .where(eq(user.id, player.id));

        const unblocked = yield* rpc["admin.users.setBlocked"]({
          userId: player.id,
          blocked: false,
        });
        const [rowAfterUnblock] = yield* db
          .select({ blockedAt: user.blockedAt })
          .from(user)
          .where(eq(user.id, player.id));

        const self = yield* rpc["admin.users.setBlocked"]({
          userId: admin.id,
          blocked: true,
        });

        return {
          ok,
          okAgain,
          unblocked,
          self,
          blockedAtFirst: rowAfterFirst?.blockedAt,
          blockedAtSecond: rowAfterSecond?.blockedAt,
          blockedAtAfterUnblock: rowAfterUnblock?.blockedAt,
          stopRequestedAt: sessionAfter?.stopRequestedAt,
        };
      }),
    );
    expect(result.ok).toBe("ok");
    expect(result.blockedAtFirst).not.toBeNull();
    expect(result.stopRequestedAt).not.toBeNull();
    expect(result.okAgain).toBe("ok");
    expect(result.blockedAtSecond?.getTime()).toBe(
      result.blockedAtFirst?.getTime(),
    );
    expect(result.unblocked).toBe("ok");
    expect(result.blockedAtAfterUnblock).toBeNull();
    expect(result.self).toBe("self");
  });
});

describe("admin.users.resetSteamLogin", () => {
  it("marks the user", async () => {
    const now = new Date();
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdminAndPlayer(db);
        yield* db.insert(user).values({
          id: "u-steam",
          name: "SteamUser",
          email: "u-steam@example.test",
          steamId: "76561198000000003",
        });
        yield* db.insert(account).values({
          id: "acc-steam",
          accountId: "76561198000000003",
          providerId: "steam",
          userId: "u-steam",
        });

        const rpc = yield* client;
        const ok = yield* rpc["admin.users.resetSteamLogin"]({
          userId: "u-steam",
        });
        const [row] = yield* db
          .select({
            steamLoginResetAt: user.steamLoginResetAt,
            steamId: user.steamId,
          })
          .from(user)
          .where(eq(user.id, "u-steam"));
        const [accountRow] = yield* db
          .select()
          .from(account)
          .where(eq(account.userId, "u-steam"));

        const notFound = yield* rpc["admin.users.resetSteamLogin"]({
          userId: "no-such-user",
        });

        return { ok, notFound, row, accountRow };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.row?.steamLoginResetAt).not.toBeNull();
    expect(result.row?.steamId).toBe("76561198000000003");
    expect(result.accountRow?.providerId).toBe("steam");
    expect(result.notFound).toBe(false);
  });

  // Через RPC проверить точность нечем (`resetSteamLogin` отдаёт только
  // `boolean`) — вызываем функцию репозитория напрямую с конкретным `now`
  // (оркестратор, Task 3, сравнивает это значение с точностью до мс).
  it("stores the exact now passed in (millisecond precision)", async () => {
    const now = new Date("2026-10-28T12:34:56.789Z");
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, { id: "u-steam2", name: "SteamUser2" });
        const ok = yield* resetSteamLogin("u-steam2", now);
        const [row] = yield* db
          .select({ steamLoginResetAt: user.steamLoginResetAt })
          .from(user)
          .where(eq(user.id, "u-steam2"));
        return { ok, row };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.row?.steamLoginResetAt?.getTime()).toBe(now.getTime());
  });
});

describe("admin.users access", () => {
  it("player gets Forbidden on every new admin method", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = player;
        const rpc = yield* client;
        const list = yield* Effect.flip(rpc["admin.users.list"]());
        const setRole = yield* Effect.flip(
          rpc["admin.users.setRole"]({ userId: "u1", role: "admin" }),
        );
        const setBlocked = yield* Effect.flip(
          rpc["admin.users.setBlocked"]({ userId: "u1", blocked: true }),
        );
        const resetSteamLogin = yield* Effect.flip(
          rpc["admin.users.resetSteamLogin"]({ userId: "u1" }),
        );
        return { list, setRole, setBlocked, resetSteamLogin };
      }),
    );
    expect(result.list._tag).toBe("Forbidden");
    expect(result.setRole._tag).toBe("Forbidden");
    expect(result.setBlocked._tag).toBe("Forbidden");
    expect(result.resetSteamLogin._tag).toBe("Forbidden");
  });
});
