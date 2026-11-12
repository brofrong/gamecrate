// Снимок места в очереди (спека 2026-11-10 §5): место/всего среди сессий,
// претендующих на те же серверы, и оценка ожидания по освобождениям слотов.
import { describe, expect, it } from "bun:test";
import { Db, sessions } from "@cg/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  etaMinutes,
  type QueueEntry,
  rankQueue,
  refreshQueue,
} from "../src/QueueSnapshot";
import {
  at,
  connectWorker,
  insertSession,
  like,
  run,
  seedUsers,
} from "./support";

const T0 = new Date("2026-11-11T12:00:00.000Z");

const entry = (
  id: string,
  targets: ReadonlyArray<string>,
  opts: { readonly priority?: number; readonly createdSec?: number } = {},
): QueueEntry => ({
  id,
  priority: opts.priority ?? 0,
  createdAt: at(T0, opts.createdSec ?? 0),
  targets: new Set(targets),
});

const noReleases = () => 0;

describe("rankQueue", () => {
  it("disjoint targets don't count", () => {
    const places = rankQueue(
      [
        entry("a", ["w1"], { createdSec: 1 }),
        entry("b", ["w2"], { createdSec: 2 }),
        entry("c", ["w1", "w3"], { createdSec: 3 }),
      ],
      noReleases,
    );
    expect(places.get("a")).toEqual({
      position: 1,
      total: 2,
      etaMinutes: null,
    });
    expect(places.get("b")).toEqual({
      position: 1,
      total: 1,
      etaMinutes: null,
    });
    expect(places.get("c")).toEqual({
      position: 2,
      total: 2,
      etaMinutes: null,
    });
  });

  it("priority then createdAt", () => {
    const places = rankQueue(
      [
        entry("old", ["w1"], { createdSec: 1 }),
        entry("vip", ["w1"], { createdSec: 9, priority: 5 }),
        entry("new", ["w1"], { createdSec: 5 }),
      ],
      noReleases,
    );
    expect(places.get("vip")?.position).toBe(1);
    expect(places.get("old")?.position).toBe(2);
    expect(places.get("new")?.position).toBe(3);
  });

  it("total includes self", () => {
    const places = rankQueue([entry("a", ["w1"])], noReleases);
    expect(places.get("a")).toEqual({
      position: 1,
      total: 1,
      etaMinutes: null,
    });
  });

  it("empty targets", () => {
    const places = rankQueue(
      [
        entry("e1", [], { createdSec: 1 }),
        entry("a", ["w1"], { createdSec: 2 }),
        entry("e2", [], { createdSec: 3 }),
      ],
      noReleases,
    );
    expect(places.get("e1")).toEqual({
      position: 1,
      total: 1,
      etaMinutes: null,
    });
    expect(places.get("e2")).toEqual({
      position: 1,
      total: 1,
      etaMinutes: null,
    });
    expect(places.get("a")).toEqual({
      position: 1,
      total: 1,
      etaMinutes: null,
    });
  });

  it("eta from releases of my targets", () => {
    const places = rankQueue(
      [
        entry("a", ["w1"], { createdSec: 1 }),
        entry("b", ["w1", "w2"], { createdSec: 2 }),
      ],
      (targets) => (targets.has("w2") ? 12 : 6),
    );
    // a: 1 / (6/60) = 10 мин; b: 2 / (12/60) = 10 мин
    expect(places.get("a")?.etaMinutes).toBe(10);
    expect(places.get("b")?.etaMinutes).toBe(10);
  });
});

describe("etaMinutes", () => {
  it("(1, 2) → null", () => expect(etaMinutes(1, 2)).toBeNull());
  it("(1, 12) → 5", () => expect(etaMinutes(1, 12)).toBe(5));
  it("(3, 6) → 30", () => expect(etaMinutes(3, 6)).toBe(30));
  it("(20, 6) → 61", () => expect(etaMinutes(20, 6)).toBe(61));
  it("rounds up to 5, minimum 5, 60 stays 60", () => {
    expect(etaMinutes(1, 60)).toBe(5); // 1 мин
    expect(etaMinutes(2, 10)).toBe(15); // 12 мин
    expect(etaMinutes(6, 6)).toBe(60);
    expect(etaMinutes(1, 3)).toBe(20);
  });
});

const queueColumns = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({
        state: sessions.state,
        queuePosition: sessions.queuePosition,
        queueTotal: sessions.queueTotal,
        queueEtaMinutes: sessions.queueEtaMinutes,
      })
      .from(sessions)
      .where(eq(sessions.id, id));
    if (row === undefined) return yield* Effect.die(`no session ${id}`);
    return row;
  });

describe("refreshQueue", () => {
  it("writes position/total for two queued sessions on the same worker", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1", "u2", "r1", "r2", "r3", "r-old", "r-other");
        yield* connectWorker(fake, "w1", 1);
        yield* connectWorker(fake, "w2", 1, { library: [] });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          createdAt: at(t0, -60),
        });
        yield* insertSession({
          id: "s2",
          userId: "u2",
          createdAt: at(t0, -30),
        });
        // Освобождения слотов: три на w1 за последний час, старое и на чужом
        // сервере не в счёт.
        const db = yield* Db;
        const released = (
          id: string,
          userId: string,
          workerId: string,
          releasedSec: number,
        ) =>
          db.insert(sessions).values({
            id,
            userId,
            appId: 570,
            state: "ended",
            workerId,
            slot: 0,
            slotReleasedAt: at(t0, releasedSec),
          });
        yield* released("r1", "r1", "w1", -60);
        yield* released("r2", "r2", "w1", -600);
        yield* released("r3", "r3", "w1", -3000);
        yield* released("r-old", "r-old", "w1", -3700);
        yield* released("r-other", "r-other", "w2", -60);

        yield* refreshQueue(t0);

        // 3 освобождения в час: место 1 → 20 мин, место 2 → 40 мин.
        like(yield* queueColumns("s1"), {
          queuePosition: 1,
          queueTotal: 2,
          queueEtaMinutes: 20,
        });
        like(yield* queueColumns("s2"), {
          queuePosition: 2,
          queueTotal: 2,
          queueEtaMinutes: 40,
        });
      }),
    ));

  it("clears columns after the session leaves queued", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1", "u2");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({
          id: "s1",
          userId: "u1",
          createdAt: at(t0, -60),
        });
        yield* insertSession({
          id: "s2",
          userId: "u2",
          createdAt: at(t0, -30),
        });
        yield* refreshQueue(t0);
        like(yield* queueColumns("s1"), { queuePosition: 1, queueTotal: 2 });

        const db = yield* Db;
        yield* db
          .update(sessions)
          .set({ state: "starting", workerId: "w1", slot: 0 })
          .where(eq(sessions.id, "s1"));
        yield* refreshQueue(at(t0, 5));

        like(yield* queueColumns("s1"), {
          state: "starting",
          queuePosition: null,
          queueTotal: null,
          queueEtaMinutes: null,
        });
        like(yield* queueColumns("s2"), {
          queuePosition: 1,
          queueTotal: 1,
          queueEtaMinutes: null,
        });
      }),
    ));
});
