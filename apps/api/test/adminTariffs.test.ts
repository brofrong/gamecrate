// RPC `admin.tariffs.*`/`admin.hourPacks.*` (вкладка «Тарифы», спека §1, §8):
// CRUD тарифов и пакетов часов, перестановка тарифа по умолчанию одной
// транзакцией, запрет архивировать тариф по умолчанию. По образцу
// `adminRegions.test.ts`.
import { describe, expect, it } from "bun:test";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs, type TariffInput } from "@cg/rpc";
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

const tariffInput = (
  overrides: Partial<TariffInput> = {},
): TariffInput => ({
  name: "Плюс",
  priceRub: 50_000,
  queuePriority: 10,
  monthlyMinutes: 6_000,
  rollover: true,
  maxResolution: "1080p",
  maxBitrateMbps: 20,
  maxSessionMinutes: 180,
  ...overrides,
});

describe("admin.tariffs", () => {
  it("list contains seeded Базовый as default", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        return yield* rpc["admin.tariffs.list"]();
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "Базовый",
      isDefault: true,
      archived: false,
      monthlyMinutes: null,
      maxResolution: "1440p",
      maxBitrateMbps: 40,
      queuePriority: 0,
    });
  });

  it("create rejects duplicate name", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "Плюс" }),
        });
        return yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "Плюс" }),
        });
      }),
    );
    expect(result).toBe("duplicate");
  });

  it("update edits fields and keeps isDefault", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        const before = yield* rpc["admin.tariffs.list"]();
        const base = before[0]!;
        const updated = yield* rpc["admin.tariffs.update"]({
          id: base.id,
          input: tariffInput({ name: "Базовый+", queuePriority: 5 }),
        });
        const after = yield* rpc["admin.tariffs.list"]();
        return { updated, base, after: after[0]! };
      }),
    );
    expect(result.updated).toBe("ok");
    expect(result.after).toMatchObject({
      id: result.base.id,
      name: "Базовый+",
      queuePriority: 5,
      isDefault: true,
    });
  });

  it("setDefault moves the flag atomically (exactly one default after)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        const created = yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "Плюс" }),
        });
        expect(created).toBe("ok");
        const list = yield* rpc["admin.tariffs.list"]();
        const plus = list.find((t) => t.name === "Плюс")!;
        const setDefault = yield* rpc["admin.tariffs.setDefault"]({
          id: plus.id,
        });
        const after = yield* rpc["admin.tariffs.list"]();
        return { setDefault, after, plusId: plus.id };
      }),
    );
    expect(result.setDefault).toBe("ok");
    const defaults = result.after.filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(result.plusId);
  });

  it("setDefault is race-safe under concurrent calls (exactly one default remains)", async () => {
    const result = await run(
      Effect.gen(function* () {
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
        // Два конкурентных setDefault на разные тарифы, пока третий (seed
        // «Базовый») — текущий дефолт: без лока на старый дефолт внутри
        // `setDefaultTariff` второй вызов падает нарушением частичного
        // уникального индекса `tariffs_default_idx`.
        const [setA, setB] = yield* Effect.all(
          [
            rpc["admin.tariffs.setDefault"]({ id: a.id }),
            rpc["admin.tariffs.setDefault"]({ id: b.id }),
          ],
          { concurrency: 2 },
        );
        const after = yield* rpc["admin.tariffs.list"]();
        return { setA, setB, after };
      }),
    );
    expect(result.setA).toBe("ok");
    expect(result.setB).toBe("ok");
    const defaults = result.after.filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
  });

  it('setDefault on archived tariff → "archived"', async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        yield* rpc["admin.tariffs.create"]({
          input: tariffInput({ name: "Плюс" }),
        });
        const list = yield* rpc["admin.tariffs.list"]();
        const plus = list.find((t) => t.name === "Плюс")!;
        yield* rpc["admin.tariffs.setArchived"]({
          id: plus.id,
          archived: true,
        });
        const setDefault = yield* rpc["admin.tariffs.setDefault"]({
          id: plus.id,
        });
        const notFound = yield* rpc["admin.tariffs.setDefault"]({
          id: "00000000-0000-0000-0000-000000000000",
        });
        return { setDefault, notFound };
      }),
    );
    expect(result.setDefault).toBe("archived");
    expect(result.notFound).toBe("notFound");
  });

  it('cannot archive default → "isDefault"', async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        const list = yield* rpc["admin.tariffs.list"]();
        const base = list[0]!;
        return yield* rpc["admin.tariffs.setArchived"]({
          id: base.id,
          archived: true,
        });
      }),
    );
    expect(result).toBe("isDefault");
  });

  it("hour packs create/update/archive roundtrip", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        const created = yield* rpc["admin.hourPacks.create"]({
          input: { name: "10 часов", minutes: 600, priceRub: 1_000 },
        });
        const list = yield* rpc["admin.hourPacks.list"]();
        const pack = list.find((p) => p.name === "10 часов")!;
        const updated = yield* rpc["admin.hourPacks.update"]({
          id: pack.id,
          input: { name: "10 часов", minutes: 600, priceRub: 1_500 },
        });
        const archived = yield* rpc["admin.hourPacks.setArchived"]({
          id: pack.id,
          archived: true,
        });
        const unarchived = yield* rpc["admin.hourPacks.setArchived"]({
          id: pack.id,
          archived: false,
        });
        const notFound = yield* rpc["admin.hourPacks.update"]({
          id: "nope",
          input: { name: "x", minutes: 60, priceRub: null },
        });
        const after = yield* rpc["admin.hourPacks.list"]();
        return { created, updated, archived, unarchived, notFound, after, pack };
      }),
    );
    expect(result.created).toBe("ok");
    expect(result.updated).toBe("ok");
    expect(result.archived).toBe("ok");
    expect(result.unarchived).toBe("ok");
    expect(result.notFound).toBe("notFound");
    const after = result.after.find((p) => p.id === result.pack.id)!;
    expect(after).toMatchObject({
      name: "10 часов",
      minutes: 600,
      priceRub: 1_500,
      archived: false,
    });
  });

  it("player role gets Forbidden", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = player;
        const rpc = yield* client;
        const list = yield* Effect.flip(rpc["admin.tariffs.list"]());
        const create = yield* Effect.flip(
          rpc["admin.tariffs.create"]({ input: tariffInput() }),
        );
        const hourPacks = yield* Effect.flip(rpc["admin.hourPacks.list"]());
        return { list, create, hourPacks };
      }),
    );
    expect(result.list._tag).toBe("Forbidden");
    expect(result.create._tag).toBe("Forbidden");
    expect(result.hourPacks._tag).toBe("Forbidden");
  });
});
