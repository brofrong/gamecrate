// RPC `admin.classes.*`/`admin.workers.setClass`: CRUD классов воркеров,
// порядок по силе, запрет удаления занятого класса (по образцу adminWorkers.test.ts).
import { describe, expect, it } from "bun:test";
import { Db, workerClasses, workers } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
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

/**
 * Миграция сидирует класс «Стандарт» (`rank 1`) — тесты строят свой набор
 * классов с нуля, как `setupClasses` в `packages/db/test/placement.test.ts`.
 */
const clearSeededClass = (db: Db["Service"]) => db.delete(workerClasses);

/** Класс с настоящим `uuid` (`id` — колонка `uuid`, не произвольная строка). */
const insertClass = (
  db: Db["Service"],
  values: { name: string; rank: number },
) =>
  db
    .insert(workerClasses)
    .values(values)
    .returning({ id: workerClasses.id })
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

describe("admin.classes", () => {
  it("list returns classes by rank desc with worker counts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const standardId = yield* insertClass(db, { name: "Стандарт", rank: 1 });
        yield* insertClass(db, { name: "Быстрое", rank: 2 });
        yield* insertWorker(db, { id: "w1", classId: standardId });
        yield* insertWorker(db, { id: "w2", classId: standardId });

        const rpc = yield* client;
        return yield* rpc["admin.classes.list"]();
      }),
    );
    expect(result.map((c) => c.name)).toEqual(["Быстрое", "Стандарт"]);
    expect(result.find((c) => c.name === "Стандарт")?.workers).toBe(2);
    expect(result.find((c) => c.name === "Быстрое")?.workers).toBe(0);
  });

  it("create adds the weakest class; empty list starts at rank 1", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const rpc = yield* client;
        const first = yield* rpc["admin.classes.create"]({
          name: "Базовый",
        });
        const second = yield* rpc["admin.classes.create"]({
          name: "Медленное",
        });
        const rows = yield* db
          .select({ name: workerClasses.name, rank: workerClasses.rank })
          .from(workerClasses);
        return { first, second, rows };
      }),
    );
    expect(result.first).toBe("ok");
    expect(result.second).toBe("ok");
    const byName = new Map(result.rows.map((r) => [r.name, r.rank]));
    expect(byName.get("Базовый")).toBe(1);
    expect(byName.get("Медленное")).toBe(0);
  });

  it("create returns duplicate for a taken name", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const rpc = yield* client;
        yield* rpc["admin.classes.create"]({ name: "Стандарт" });
        return yield* rpc["admin.classes.create"]({ name: "Стандарт" });
      }),
    );
    expect(result).toBe("duplicate");
  });

  it("rename: ok, duplicate, notFound", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const id1 = yield* insertClass(db, { name: "Стандарт", rank: 1 });
        yield* insertClass(db, { name: "Быстрое", rank: 2 });
        const rpc = yield* client;
        const ok = yield* rpc["admin.classes.rename"]({
          id: id1,
          name: "Базовый",
        });
        const duplicate = yield* rpc["admin.classes.rename"]({
          id: id1,
          name: "Быстрое",
        });
        const notFound = yield* rpc["admin.classes.rename"]({
          id: "00000000-0000-0000-0000-000000000000",
          name: "Что угодно",
        });
        return { ok, duplicate, notFound };
      }),
    );
    expect(result.ok).toBe("ok");
    expect(result.duplicate).toBe("duplicate");
    expect(result.notFound).toBe("notFound");
  });

  it("move changes order and returns edge at either end", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const lowId = yield* insertClass(db, { name: "Медленное", rank: 1 });
        const midId = yield* insertClass(db, { name: "Стандарт", rank: 2 });
        const highId = yield* insertClass(db, { name: "Быстрое", rank: 3 });
        const rpc = yield* client;

        const up = yield* rpc["admin.classes.move"]({
          id: midId,
          direction: "up",
        });
        const afterUp = yield* db
          .select({ id: workerClasses.id, rank: workerClasses.rank })
          .from(workerClasses)
          .orderBy(workerClasses.rank);

        const edgeTop = yield* rpc["admin.classes.move"]({
          id: midId, // теперь самый сильный (rank 3)
          direction: "up",
        });
        const edgeBottom = yield* rpc["admin.classes.move"]({
          id: lowId,
          direction: "down",
        });
        const notFound = yield* rpc["admin.classes.move"]({
          id: "00000000-0000-0000-0000-000000000000",
          direction: "up",
        });
        return { up, afterUp, edgeTop, edgeBottom, notFound, lowId, midId, highId };
      }),
    );
    expect(result.up).toBe("ok");
    // mid и high поменялись местами по рангу.
    const ranks = new Map(result.afterUp.map((r) => [r.id, r.rank]));
    expect(ranks.get(result.midId)).toBe(3);
    expect(ranks.get(result.highId)).toBe(2);
    expect(ranks.get(result.lowId)).toBe(1);
    expect(result.edgeTop).toBe("edge");
    expect(result.edgeBottom).toBe("edge");
    expect(result.notFound).toBe("notFound");
  });

  it("delete: ok, inUse for a class with workers, notFound", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const emptyId = yield* insertClass(db, { name: "Пустой", rank: 1 });
        const busyId = yield* insertClass(db, { name: "Занятый", rank: 2 });
        yield* insertWorker(db, { id: "w1", classId: busyId });
        const rpc = yield* client;

        const inUse = yield* rpc["admin.classes.delete"]({ id: busyId });
        const ok = yield* rpc["admin.classes.delete"]({ id: emptyId });
        const notFound = yield* rpc["admin.classes.delete"]({
          id: "00000000-0000-0000-0000-000000000000",
        });
        const rows = yield* db
          .select({ id: workerClasses.id })
          .from(workerClasses);
        return { inUse, ok, notFound, rows, busyId };
      }),
    );
    expect(result.inUse).toBe("inUse");
    expect(result.ok).toBe("ok");
    expect(result.notFound).toBe("notFound");
    expect(result.rows.map((r) => r.id)).toEqual([result.busyId]);
  });
});

describe("admin.workers.setClass", () => {
  it("sets, clears to null, and returns false for unknown worker", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const classId = yield* insertClass(db, { name: "Стандарт", rank: 1 });
        yield* insertWorker(db, { id: "w1" });
        const rpc = yield* client;

        const setOk = yield* rpc["admin.workers.setClass"]({
          workerId: "w1",
          classId,
        });
        const [afterSet] = yield* db
          .select({ classId: workers.classId })
          .from(workers)
          .where(eq(workers.id, "w1"));

        const clearOk = yield* rpc["admin.workers.setClass"]({
          workerId: "w1",
          classId: null,
        });
        const [afterClear] = yield* db
          .select({ classId: workers.classId })
          .from(workers)
          .where(eq(workers.id, "w1"));

        const unknown = yield* rpc["admin.workers.setClass"]({
          workerId: "no-such-worker",
          classId,
        });
        return { setOk, afterSet, clearOk, afterClear, unknown, classId };
      }),
    );
    expect(result.setOk).toBe(true);
    expect(result.afterSet?.classId).toBe(result.classId);
    expect(result.clearOk).toBe(true);
    expect(result.afterClear?.classId).toBeNull();
    expect(result.unknown).toBe(false);
  });
});

// Гонки round 1 code review: create/rename с тем же именем и delete занятого
// класса раньше проверяли через отдельный `select`, который конкурентный
// второй запрос проходил тоже — и падал дефектом (500) на уникальном индексе
// или FK `on delete restrict` вместо документированного `"duplicate"`/`"inUse"`.
// Теперь ответ строится по самому Postgres-нарушению (`violatedConstraint` в
// `classes.ts`) — ниже тесты бьют именно по этому: два одновременных запроса
// на один ресурс никогда не должны дать дефект, а должны дать ровно одно
// `"ok"` и одно `"duplicate"`/`"inUse"`.
describe("admin.classes races (round 1 review)", () => {
  it("concurrent create with the same name: no defect, exactly one ok and one duplicate", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const rpc = yield* client;
        return yield* Effect.all(
          [
            rpc["admin.classes.create"]({ name: "Гонка" }),
            rpc["admin.classes.create"]({ name: "Гонка" }),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );
    expect([...result].sort()).toEqual(["duplicate", "ok"]);
  });

  it("concurrent rename of two different classes to the same name: no defect, one ok and one duplicate", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const id1 = yield* insertClass(db, { name: "Класс А", rank: 1 });
        const id2 = yield* insertClass(db, { name: "Класс Б", rank: 2 });
        const rpc = yield* client;
        return yield* Effect.all(
          [
            rpc["admin.classes.rename"]({ id: id1, name: "Общее имя" }),
            rpc["admin.classes.rename"]({ id: id2, name: "Общее имя" }),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );
    expect([...result].sort()).toEqual(["duplicate", "ok"]);
  });

  it("setClass assigns a worker, then delete of that class returns inUse (not a defect) end to end over RPC", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* clearSeededClass(db);
        const classId = yield* insertClass(db, { name: "Класс", rank: 1 });
        yield* insertWorker(db, { id: "w1" });
        const rpc = yield* client;

        // Воспроизводит порядок из ревью: `admin.workers.setClass` назначает
        // воркера классу до того, как админ успевает его удалить.
        const setOk = yield* rpc["admin.workers.setClass"]({
          workerId: "w1",
          classId,
        });
        const deleteResult = yield* rpc["admin.classes.delete"]({
          id: classId,
        });
        return { setOk, deleteResult };
      }),
    );
    expect(result.setOk).toBe(true);
    expect(result.deleteResult).toBe("inUse");
  });
});
