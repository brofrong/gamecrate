// RPC `admin.workers.create`/`issueCode`/`revoke`: одноразовый код
// подключения сервера, перевыпуск, отзыв (спека §3, по образцу
// adminClasses.test.ts/adminWorkers.test.ts).
import { describe, expect, it } from "bun:test";
import {
  Db,
  ENROLL_CODE_TTL_MS,
  regions,
  sha256Hex,
  workerCredentials,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs } from "@cg/rpc";
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
const player: CurrentUserShape = { ...admin, id: "u-player", role: "player" };

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

const insertRegion = (db: Db["Service"], code = "spb", name = "Питер") =>
  db
    .insert(regions)
    .values({ code, name })
    .returning({ id: regions.id })
    .pipe(Effect.map(([row]) => row!.id));

describe("admin.workers.create", () => {
  it("returns a 24-char code valid for 24h and stores only its hash", async () => {
    const before = Date.now();
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const regionId = yield* insertRegion(db);
        const rpc = yield* client;
        const created = yield* rpc["admin.workers.create"]({
          id: "spb-01",
          regionId,
        });
        const [row] = yield* db
          .select()
          .from(workerCredentials)
          .where(eq(workerCredentials.workerId, "spb-01"));
        const [worker] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "spb-01"));
        return { created, row, worker };
      }),
    );
    const after = Date.now();
    if (typeof result.created === "string") {
      throw new Error("expected enroll code");
    }
    expect(result.created.code).toHaveLength(24);
    expect(result.row?.enrollCodeHash).toBe(sha256Hex(result.created.code));
    // Код сам по себе в БД не лежит.
    expect(JSON.stringify(result.row)).not.toContain(result.created.code);
    expect(result.row?.tokenHash).toBeNull();
    const expiresAt = new Date(result.created.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + ENROLL_CODE_TTL_MS - 1000,
    );
    expect(expiresAt).toBeLessThanOrEqual(after + ENROLL_CODE_TTL_MS + 1000);
    expect(result.worker?.publicIp).toBe("");
    expect(result.worker?.slots).toBe(0);
  });

  it("rejects existing id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const regionId = yield* insertRegion(db);
        const rpc = yield* client;
        yield* rpc["admin.workers.create"]({ id: "spb-01", regionId });
        return yield* rpc["admin.workers.create"]({ id: "spb-01", regionId });
      }),
    );
    expect(result).toBe("idTaken");
  });

  it('rejects "Spb_1"', async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const regionId = yield* insertRegion(db);
        const rpc = yield* client;
        return yield* rpc["admin.workers.create"]({ id: "Spb_1", regionId });
      }),
    );
    expect(result).toBe("invalid");
  });

  it('unknown or non-uuid region is "regionNotFound", no worker row', async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const rpc = yield* client;
        const unknown = yield* rpc["admin.workers.create"]({
          id: "spb-01",
          regionId: crypto.randomUUID(),
        });
        const malformed = yield* rpc["admin.workers.create"]({
          id: "spb-02",
          regionId: "not-a-uuid",
        });
        const rows = yield* db.select({ id: workers.id }).from(workers);
        return { unknown, malformed, rows };
      }),
    );
    expect(result.unknown).toBe("regionNotFound");
    expect(result.malformed).toBe("regionNotFound");
    expect(result.rows).toEqual([]);
  });
});

describe("admin.workers.issueCode", () => {
  it("keeps the current token until exchange", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const regionId = yield* insertRegion(db);
        const rpc = yield* client;
        yield* rpc["admin.workers.create"]({ id: "spb-01", regionId });
        // Симулируем обмен кода на постоянный токен (Task 3 делает это сам).
        yield* db
          .update(workerCredentials)
          .set({ tokenHash: sha256Hex("cgw_token"), tokenIssuedAt: new Date() })
          .where(eq(workerCredentials.workerId, "spb-01"));

        const reissued = yield* rpc["admin.workers.issueCode"]({
          workerId: "spb-01",
        });
        const [row] = yield* db
          .select()
          .from(workerCredentials)
          .where(eq(workerCredentials.workerId, "spb-01"));
        const notFound = yield* rpc["admin.workers.issueCode"]({
          workerId: "no-such-worker",
        });
        return { reissued, row, notFound };
      }),
    );
    if (typeof result.reissued === "string") {
      throw new Error("expected enroll code");
    }
    expect(result.reissued.code).toHaveLength(24);
    expect(result.row?.tokenHash).toBe(sha256Hex("cgw_token"));
    expect(result.row?.enrollCodeHash).toBe(sha256Hex(result.reissued.code));
    expect(result.notFound).toBe("notFound");
  });
});

describe("admin.workers.revoke", () => {
  it("clears token and code", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const regionId = yield* insertRegion(db);
        const rpc = yield* client;
        yield* rpc["admin.workers.create"]({ id: "spb-01", regionId });
        yield* db
          .update(workerCredentials)
          .set({ tokenHash: sha256Hex("cgw_token"), tokenIssuedAt: new Date() })
          .where(eq(workerCredentials.workerId, "spb-01"));

        const revoked = yield* rpc["admin.workers.revoke"]({
          workerId: "spb-01",
        });
        const [row] = yield* db
          .select()
          .from(workerCredentials)
          .where(eq(workerCredentials.workerId, "spb-01"));
        const unknown = yield* rpc["admin.workers.revoke"]({
          workerId: "no-such-worker",
        });
        return { revoked, row, unknown };
      }),
    );
    expect(result.revoked).toBe(true);
    expect(result.row?.tokenHash).toBeNull();
    expect(result.row?.enrollCodeHash).toBeNull();
    expect(result.row?.revokedAt).not.toBeNull();
    expect(result.unknown).toBe(false);
  });
});

describe("admin.workers.create/issueCode/revoke access", () => {
  it("non-admin gets Forbidden", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = player;
        const rpc = yield* client;
        const create = yield* Effect.flip(
          rpc["admin.workers.create"]({ id: "spb-01", regionId: "x" }),
        );
        const issue = yield* Effect.flip(
          rpc["admin.workers.issueCode"]({ workerId: "spb-01" }),
        );
        const revoke = yield* Effect.flip(
          rpc["admin.workers.revoke"]({ workerId: "spb-01" }),
        );
        const setRegion = yield* Effect.flip(
          rpc["admin.workers.setRegion"]({
            workerId: "spb-01",
            regionId: null,
          }),
        );
        return { create, issue, revoke, setRegion };
      }),
    );
    expect(result.create._tag).toBe("Forbidden");
    expect(result.issue._tag).toBe("Forbidden");
    expect(result.revoke._tag).toBe("Forbidden");
    expect(result.setRegion._tag).toBe("Forbidden");
  });
});
