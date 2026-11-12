// RPC `admin.users.plan`/`grantTariff`/`revokeTariff`/`addMinutes` (карточка
// пользователя, спека §2, §3, §8) + `AdminSession.queuePosition`
// (`sessions.queue_position`) — по образцу `adminTariffs.test.ts`/
// `adminUsers.test.ts`.
import { describe, expect, it } from "bun:test";
import {
  Db,
  games,
  minuteCredits,
  sessions,
  tariffGrants,
  user,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs, type TariffInput } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { OwnGameCatalog } from "../src/library/OwnGameCatalog";

const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};

const auth = { current: admin as CurrentUserShape | null };
const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.sync(() => Option.fromNullishOr(auth.current)),
});

const env = Layer.mergeAll(AdminRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provide(OwnGameCatalog.fromManifests([])),
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
  db.insert(user).values({
    id,
    name,
    email: `${id}@example.test`,
  });

const insertAdmin = (db: Db["Service"]) =>
  db.insert(user).values({
    id: admin.id,
    name: admin.name,
    email: `${admin.id}@example.test`,
    role: "admin",
  });

const tariffInput = (overrides: Partial<TariffInput> = {}): TariffInput => ({
  name: "Плюс",
  priceRub: 50_000,
  queuePriority: 10,
  monthlyMinutes: null,
  rollover: false,
  maxResolution: "1080p",
  maxBitrateMbps: 20,
  maxSessionMinutes: null,
  ...overrides,
});

describe("admin.users.grantTariff", () => {
  it("replaces the active grant (old ends at now, new starts at now)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        const rpc = yield* client;

        yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "А" }),
        });
        yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "Б" }),
        });
        const list = yield* rpc["admin.tariffs.list"]();
        const a = list.find((t) => t.name === "А")!;
        const b = list.find((t) => t.name === "Б")!;

        const first = yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: a.id,
          endsAt: null,
        });
        const rowsAfterFirst = yield* db
          .select()
          .from(tariffGrants)
          .where(eq(tariffGrants.userId, "u1"));

        const second = yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: b.id,
          endsAt: null,
        });
        const rowsAfterSecond = yield* db
          .select()
          .from(tariffGrants)
          .where(eq(tariffGrants.userId, "u1"));

        return { first, second, rowsAfterFirst, rowsAfterSecond, a, b };
      }),
    );
    expect(result.first).toBe("ok");
    expect(result.second).toBe("ok");
    expect(result.rowsAfterFirst).toHaveLength(1);
    expect(result.rowsAfterFirst[0]!.endsAt).toBeNull();

    expect(result.rowsAfterSecond).toHaveLength(2);
    const old = result.rowsAfterSecond.find((g) => g.tariffId === result.a.id);
    const fresh = result.rowsAfterSecond.find(
      (g) => g.tariffId === result.b.id,
    );
    expect(old?.endsAt).not.toBeNull();
    expect(old?.endsAt?.getTime()).toBe(fresh?.startsAt.getTime());
    expect(fresh?.endsAt).toBeNull();
  });

  it('with past endsAt → "badEnd"', async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        const rpc = yield* client;

        yield* rpc["admin.tariffs.create"]({ input: tariffInput() });
        const list = yield* rpc["admin.tariffs.list"]();
        const plus = list.find((t) => t.name === "Плюс")!;

        const badEnd = yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: plus.id,
          endsAt: new Date(Date.now() - 60_000).toISOString(),
        });
        const rows = yield* db
          .select()
          .from(tariffGrants)
          .where(eq(tariffGrants.userId, "u1"));
        return { badEnd, rows };
      }),
    );
    expect(result.badEnd).toBe("badEnd");
    expect(result.rows).toHaveLength(0);
  });

  it('archived tariff → "archived"', async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        const rpc = yield* client;

        yield* rpc["admin.tariffs.create"]({ input: tariffInput() });
        const list = yield* rpc["admin.tariffs.list"]();
        const plus = list.find((t) => t.name === "Плюс")!;
        yield* rpc["admin.tariffs.setArchived"]({
          id: plus.id,
          archived: true,
        });

        const archived = yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: plus.id,
          endsAt: null,
        });
        const notFoundUser = yield* rpc["admin.users.grantTariff"]({
          userId: "no-such-user",
          tariffId: plus.id,
          endsAt: null,
        });
        const notFoundTariff = yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: "no-such-tariff",
          endsAt: null,
        });
        const rows = yield* db
          .select()
          .from(tariffGrants)
          .where(eq(tariffGrants.userId, "u1"));
        return { archived, notFoundUser, notFoundTariff, rows };
      }),
    );
    expect(result.archived).toBe("archived");
    expect(result.notFoundUser).toBe("notFound");
    expect(result.notFoundTariff).toBe("notFound");
    expect(result.rows).toHaveLength(0);
  });

  it("two concurrent grants for the same user: no defect, exactly one open grant remains", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        const rpc = yield* client;

        yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "А" }),
        });
        yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "Б" }),
        });
        const list = yield* rpc["admin.tariffs.list"]();
        const a = list.find((t) => t.name === "А")!;
        const b = list.find((t) => t.name === "Б")!;

        // Без лока на строку пользователя внутри `grantTariff` оба вызова
        // видят "нет действующей выдачи" и оба её открывают — остаются две
        // открытые выдачи одновременно.
        const [resultA, resultB] = yield* Effect.all(
          [
            rpc["admin.users.grantTariff"]({
              userId: "u1",
              tariffId: a.id,
              endsAt: null,
            }),
            rpc["admin.users.grantTariff"]({
              userId: "u1",
              tariffId: b.id,
              endsAt: null,
            }),
          ],
          { concurrency: 2 },
        );
        const rows = yield* db
          .select()
          .from(tariffGrants)
          .where(eq(tariffGrants.userId, "u1"));
        return { resultA, resultB, rows };
      }),
    );
    expect(result.resultA).toBe("ok");
    expect(result.resultB).toBe("ok");
    expect(result.rows).toHaveLength(2);
    const open = result.rows.filter((g) => g.endsAt === null);
    expect(open).toHaveLength(1);
  });
});

describe("admin.users.revokeTariff", () => {
  it("closes the grant → plan shows default", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        const rpc = yield* client;

        yield* rpc["admin.tariffs.create"]({ input: tariffInput() });
        const list = yield* rpc["admin.tariffs.list"]();
        const plus = list.find((t) => t.name === "Плюс")!;
        yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: plus.id,
          endsAt: null,
        });

        const revoked = yield* rpc["admin.users.revokeTariff"]({
          userId: "u1",
        });
        const planAfter = yield* rpc["admin.users.plan"]({ userId: "u1" });
        const again = yield* rpc["admin.users.revokeTariff"]({
          userId: "u1",
        });
        return { revoked, planAfter, again };
      }),
    );
    expect(result.revoked).toBe("ok");
    expect(result.planAfter?.tariff.name).toBe("Базовый");
    expect(result.planAfter?.tariff.isDefault).toBe(true);
    expect(result.again).toBe("none");
  });
});

describe("admin.users.addMinutes", () => {
  it("adds a credit and remainingMinutes grows (тариф с лимитом)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        const rpc = yield* client;

        yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ monthlyMinutes: 60 }),
        });
        const list = yield* rpc["admin.tariffs.list"]();
        const plus = list.find((t) => t.name === "Плюс")!;
        yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: plus.id,
          endsAt: null,
        });

        const before = yield* rpc["admin.users.plan"]({ userId: "u1" });

        const ok = yield* rpc["admin.users.addMinutes"]({
          userId: "u1",
          minutes: 30,
          comment: "Компенсация",
        });
        const after = yield* rpc["admin.users.plan"]({ userId: "u1" });

        const notFound = yield* rpc["admin.users.addMinutes"]({
          userId: "no-such-user",
          minutes: 10,
          comment: "x",
        });

        const creditRows = yield* db
          .select()
          .from(minuteCredits)
          .where(eq(minuteCredits.userId, "u1"));

        return { before, ok, after, notFound, creditRows };
      }),
    );
    expect(result.before?.remainingMinutes).toBe(60);
    expect(result.ok).toBe("ok");
    expect(result.after?.remainingMinutes).toBe(90);
    expect(result.notFound).toBe("notFound");
    expect(result.creditRows).toHaveLength(1);
    expect(result.creditRows[0]!.comment).toBe("Компенсация");
    expect(result.creditRows[0]!.grantedBy).toBe(admin.id);
  });
});

describe("admin.users.plan", () => {
  it("returns null for a missing user", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        const rpc = yield* client;
        return yield* rpc["admin.users.plan"]({ userId: "no-such-user" });
      }),
    );
    expect(result).toBeNull();
  });

  it("includes grants/credits history, new first, with grantedBy name", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        const rpc = yield* client;

        yield* rpc["admin.tariffs.create"]({ input: tariffInput() });
        const list = yield* rpc["admin.tariffs.list"]();
        const plus = list.find((t) => t.name === "Плюс")!;
        yield* rpc["admin.users.grantTariff"]({
          userId: "u1",
          tariffId: plus.id,
          endsAt: null,
        });
        yield* rpc["admin.users.addMinutes"]({
          userId: "u1",
          minutes: 120,
          comment: "Подарок",
        });

        return yield* rpc["admin.users.plan"]({ userId: "u1" });
      }),
    );
    expect(result?.grants).toHaveLength(1);
    expect(result?.grants[0]!.tariffName).toBe("Плюс");
    expect(result?.grants[0]!.grantedBy).toBe(admin.name);
    expect(result?.credits).toHaveLength(1);
    expect(result?.credits[0]!.comment).toBe("Подарок");
    expect(result?.credits[0]!.grantedBy).toBe(admin.name);
  });
});

describe("admin.sessions.list queuePosition", () => {
  it("returns queuePosition from sessions.queue_position", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertAdmin(db);
        yield* insertUser(db, "u1");
        yield* insertUser(db, "u2");
        yield* db.insert(games).values({ appId: 10, name: "Hades" });
        yield* db.insert(sessions).values({
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 10,
          state: "queued",
          queuePosition: 3,
        });
        yield* db.insert(sessions).values({
          id: "22222222-2222-2222-2222-222222222222",
          userId: "u2",
          appId: 10,
          state: "playing",
        });

        const rpc = yield* client;
        return yield* rpc["admin.sessions.list"]({ failedOnly: false });
      }),
    );
    const queued = result.active.find(
      (s) => s.id === "11111111-1111-1111-1111-111111111111",
    );
    const playing = result.active.find(
      (s) => s.id === "22222222-2222-2222-2222-222222222222",
    );
    expect(queued?.queuePosition).toBe(3);
    expect(playing?.queuePosition).toBeNull();
  });
});
