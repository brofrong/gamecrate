// RPC `admin.regions.*`: CRUD регионов, порядок по позиции, запрет удаления
// занятого региона (по образцу adminClasses.test.ts).
import { describe, expect, it } from "bun:test";
import { Db, regions, workers } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs } from "@cg/rpc";
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

const insertRegion = (
  db: Db["Service"],
  values: { code: string; name: string; position?: number },
) =>
  db
    .insert(regions)
    .values(values)
    .returning({ id: regions.id })
    .pipe(Effect.map(([row]) => row!.id));

const insertWorker = (
  db: Db["Service"],
  values: Partial<typeof workers.$inferInsert> & { id: string },
) =>
  db.insert(workers).values({
    publicIp: "37.153.14.138",
    slots: 2,
    ...values,
  });

describe("admin.regions", () => {
  it("creates, lists in position order, renames", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        const spb = yield* rpc["admin.regions.create"]({
          code: "spb",
          name: "Питер",
        });
        const msk = yield* rpc["admin.regions.create"]({
          code: "msk",
          name: "Москва",
        });
        if (typeof spb === "string" || typeof msk === "string") {
          throw new Error("expected AdminRegion");
        }
        // Поставим "Москва" первой по позиции, хотя создана второй.
        const renamed = yield* rpc["admin.regions.update"]({
          id: msk.id,
          name: "Мск",
          position: 0,
        });
        yield* rpc["admin.regions.update"]({
          id: spb.id,
          name: "Питер",
          position: 1,
        });
        const list = yield* rpc["admin.regions.list"]();
        return { spb, msk, renamed, list };
      }),
    );
    expect(result.spb).toMatchObject({
      code: "spb",
      name: "Питер",
      position: 0,
      workers: 0,
    });
    expect(result.renamed).toBe("ok");
    expect(result.list.map((r) => r.name)).toEqual(["Мск", "Питер"]);
  });

  it("rejects duplicate code", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        yield* rpc["admin.regions.create"]({ code: "spb", name: "Питер" });
        return yield* rpc["admin.regions.create"]({
          code: "spb",
          name: "Петербург",
        });
      }),
    );
    expect(result).toBe("codeTaken");
  });

  it('rejects bad code "Spb"', async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        return yield* rpc["admin.regions.create"]({
          code: "Spb",
          name: "Питер",
        });
      }),
    );
    expect(result).toBe("invalid");
  });

  it("update returns notFound for unknown id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        return yield* rpc["admin.regions.update"]({
          id: "00000000-0000-0000-0000-000000000000",
          name: "Что угодно",
          position: 0,
        });
      }),
    );
    expect(result).toBe("notFound");
  });

  it("refuses to delete a region with workers", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const regionId = yield* insertRegion(db, {
          code: "spb",
          name: "Питер",
        });
        yield* insertWorker(db, { id: "w1", regionId });
        const rpc = yield* client;

        const notEmpty = yield* rpc["admin.regions.delete"]({ id: regionId });
        yield* db.update(workers).set({ regionId: null });
        const ok = yield* rpc["admin.regions.delete"]({ id: regionId });
        const notFound = yield* rpc["admin.regions.delete"]({
          id: "00000000-0000-0000-0000-000000000000",
        });
        return { notEmpty, ok, notFound };
      }),
    );
    expect(result.notEmpty).toBe("notEmpty");
    expect(result.ok).toBe("ok");
    expect(result.notFound).toBe("notFound");
  });

  it("player gets Forbidden on every admin.regions method", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = player;
        const rpc = yield* client;
        const list = yield* Effect.flip(rpc["admin.regions.list"]());
        const create = yield* Effect.flip(
          rpc["admin.regions.create"]({ code: "spb", name: "Питер" }),
        );
        const update = yield* Effect.flip(
          rpc["admin.regions.update"]({ id: "x", name: "x", position: 0 }),
        );
        const del = yield* Effect.flip(
          rpc["admin.regions.delete"]({ id: "x" }),
        );
        return { list, create, update, del };
      }),
    );
    expect(result.list._tag).toBe("Forbidden");
    expect(result.create._tag).toBe("Forbidden");
    expect(result.update._tag).toBe("Forbidden");
    expect(result.del._tag).toBe("Forbidden");
  });
});
