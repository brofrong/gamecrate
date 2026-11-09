// Удаление игр с сервера: DeleteGame агенту сервера строки, итоги — к паре
// (сервер, игра) (библиотека своя у каждого сервера, спека 2026-11-09 §5).
import { describe, expect, it } from "bun:test";
import { Db, gamestoreApps, games, workers } from "@cg/db";
import { DbTest } from "@cg/db/test";
import type { AgentCommand, AgentReport, AgentRoles } from "@cg/rpc";
import { and, asc, eq } from "drizzle-orm";
import { Effect, Layer, PubSub, References, type Scope, Stream } from "effect";
import {
  AgentHub,
  type AgentHubEvent,
  type AgentHubShape,
  type WorkerInfo,
} from "../src/AgentHub";
import { GameDeleter } from "../src/GameDeleter";

/** Фейковый хаб: подключённые агенты и отправленные команды — в памяти. */
const makeFakeHub = () => {
  const infos = new Map<string, WorkerInfo>();
  const sent: Array<{ workerId: string; command: AgentCommand }> = [];
  const state = {
    refuse: (_workerId: string, _command: AgentCommand) => false,
  };
  const events = Effect.runSync(PubSub.unbounded<AgentHubEvent>());
  const hub: AgentHubShape = {
    send: (workerId, command) =>
      Effect.sync(() => {
        if (!infos.has(workerId) || state.refuse(workerId, command))
          return false;
        sent.push({ workerId, command });
        return true;
      }),
    connected: () => new Set(infos.keys()),
    info: (workerId) => infos.get(workerId),
    workerOf: () => undefined,
    tokenHash: () => undefined,
    disconnect: () => Effect.die("fake hub"),
    events,
    subscribe: PubSub.subscribe(events),
    connect: () => Stream.die("fake hub"),
    report: () => Effect.die("fake hub"),
  };
  return { hub, infos, sent, state };
};
type FakeHub = ReturnType<typeof makeFakeHub>;

type Env = Db | AgentHub | GameDeleter | Scope.Scope;

const run = <A, E>(body: (fake: FakeHub) => Effect.Effect<A, E, Env>) => {
  const fake = makeFakeHub();
  return Effect.runPromise(
    Effect.scoped(body(fake)).pipe(
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.provide(
        GameDeleter.layerWithoutLoops.pipe(
          Layer.provideMerge(Layer.succeed(AgentHub, fake.hub)),
          Layer.provideMerge(DbTest),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        ),
      ),
    ),
  );
};

const DOTA = 570;
const PORTAL = 400;

const connectAgent = (fake: FakeHub, workerId: string, roles: AgentRoles) =>
  fake.infos.set(workerId, {
    workerId,
    publicIp: "203.0.113.7",
    slots: 0,
    udpPortBase: 59000,
    roles,
  });

const connected = (workerId: string): AgentHubEvent => ({
  _tag: "Connected",
  workerId,
  publicIp: "203.0.113.7",
  slots: 0,
  udpPortBase: 59000,
  roles: ["gamestore"],
  running: [],
  installs: [],
});

const report = (workerId: string, agentReport: AgentReport): AgentHubEvent => ({
  _tag: "Report",
  workerId,
  report: agentReport,
});

/**
 * Библиотеки серверов: на gs-b Dota помечена к удалению, Portal просто
 * установлена; на gs-c та же Dota стоит без пометки.
 */
const seed = Effect.gen(function* () {
  const db = yield* Db;
  yield* db.insert(games).values([
    { appId: DOTA, name: "Dota 2" },
    { appId: PORTAL, name: "Portal" },
  ]);
  for (const id of ["gs-b", "gs-c"])
    yield* db.insert(workers).values({
      id,
      publicIp: "203.0.113.8",
      slots: 0,
      roles: ["worker", "gamestore"],
    });
  yield* db.insert(gamestoreApps).values([
    {
      workerId: "gs-b",
      appId: DOTA,
      sizeBytes: 1,
      buildId: "1",
      deletingAt: new Date(),
    },
    { workerId: "gs-b", appId: PORTAL, sizeBytes: 1, buildId: "1" },
    { workerId: "gs-c", appId: DOTA, sizeBytes: 1, buildId: "1" },
  ]);
});

/** Строки библиотек: сервер, игра, пометка удаления. */
const apps = Effect.gen(function* () {
  const db = yield* Db;
  return yield* db
    .select({
      workerId: gamestoreApps.workerId,
      appId: gamestoreApps.appId,
      deletingAt: gamestoreApps.deletingAt,
    })
    .from(gamestoreApps)
    .orderBy(asc(gamestoreApps.workerId), asc(gamestoreApps.appId));
});

const deleteDota = {
  workerId: "gs-b",
  command: { _tag: "DeleteGame", appId: DOTA } as AgentCommand,
};

describe("game deleter", () => {
  it("deleting app → DeleteGame to the agent of its server once per connection, resent after reconnect", () =>
    run((fake) =>
      Effect.gen(function* () {
        const deleter = yield* GameDeleter;
        yield* seed;
        // Сервера строки нет на связи — некому отправить (чужим — не шлём).
        connectAgent(fake, "a-worker", ["worker", "gamestore"]);
        connectAgent(fake, "gs-c", ["worker", "gamestore"]);
        yield* deleter.tick;
        expect(fake.sent).toEqual([]);

        // Агент gs-b; не доставлено — повтор на следующем проходе.
        connectAgent(fake, "gs-b", ["worker", "gamestore"]);
        fake.state.refuse = () => true;
        yield* deleter.tick;
        expect(fake.sent).toEqual([]);
        fake.state.refuse = () => false;
        yield* deleter.tick;
        yield* deleter.tick;
        expect(fake.sent).toEqual([deleteDota]);

        // Переподключился другой агент — ничего; этот — команда снова.
        yield* deleter.handle(connected("gs-c"));
        yield* deleter.tick;
        expect(fake.sent).toEqual([deleteDota]);
        yield* deleter.handle(connected("gs-b"));
        yield* deleter.tick;
        yield* deleter.tick;
        expect(fake.sent).toEqual([deleteDota, deleteDota]);
      }),
    ));

  it("GameDeleted removes the gamestore_apps row", () =>
    run((fake) =>
      Effect.gen(function* () {
        const deleter = yield* GameDeleter;
        yield* seed;
        connectAgent(fake, "gs-b", ["gamestore"]);
        yield* deleter.tick;
        expect(fake.sent).toEqual([deleteDota]);

        yield* deleter.handle(
          report("gs-b", { _tag: "GameDeleted", appId: DOTA }),
        );
        // Игра без пометки удаления (повторный итог) не трогается.
        yield* deleter.handle(
          report("gs-b", { _tag: "GameDeleted", appId: PORTAL }),
        );
        expect(yield* apps).toEqual([
          { workerId: "gs-b", appId: PORTAL, deletingAt: null },
          { workerId: "gs-c", appId: DOTA, deletingAt: null },
        ]);

        // Удалять больше нечего — и после переподключения тоже.
        yield* deleter.handle(connected("gs-b"));
        yield* deleter.tick;
        expect(fake.sent).toEqual([deleteDota]);
      }),
    ));

  it("GameDeleteFailed clears deleting_at", () =>
    run((fake) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const deleter = yield* GameDeleter;
        yield* seed;
        connectAgent(fake, "gs-b", ["gamestore"]);
        yield* deleter.tick;

        yield* deleter.handle(
          report("gs-b", {
            _tag: "GameDeleteFailed",
            appId: DOTA,
            reason: "Steam не удалил игру",
          }),
        );
        expect(yield* apps).toEqual([
          { workerId: "gs-b", appId: PORTAL, deletingAt: null },
          { workerId: "gs-b", appId: DOTA, deletingAt: null },
          { workerId: "gs-c", appId: DOTA, deletingAt: null },
        ]);
        const [dota] = yield* db
          .select()
          .from(gamestoreApps)
          .where(
            and(
              eq(gamestoreApps.workerId, "gs-b"),
              eq(gamestoreApps.appId, DOTA),
            ),
          );
        expect(dota?.buildId).toBe("1");

        yield* deleter.handle(connected("gs-b"));
        yield* deleter.tick;
        expect(fake.sent).toEqual([deleteDota]);
      }),
    ));

  it("GameDeleteFailed stores the reason", () =>
    run((fake) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const deleter = yield* GameDeleter;
        yield* seed;
        connectAgent(fake, "gs-b", ["gamestore"]);
        yield* deleter.tick;

        yield* deleter.handle(
          report("gs-b", {
            _tag: "GameDeleteFailed",
            appId: DOTA,
            reason: "Игра запущена",
          }),
        );
        const rows = yield* db
          .select({
            workerId: gamestoreApps.workerId,
            deletingAt: gamestoreApps.deletingAt,
            deleteError: gamestoreApps.deleteError,
          })
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, DOTA))
          .orderBy(asc(gamestoreApps.workerId));
        // Причина — только у строки сервера, где удаление не удалось.
        expect(rows).toEqual([
          { workerId: "gs-b", deletingAt: null, deleteError: "Игра запущена" },
          { workerId: "gs-c", deletingAt: null, deleteError: null },
        ]);
      }),
    ));

  it("deletes only on the requested worker", () =>
    run((fake) =>
      Effect.gen(function* () {
        const deleter = yield* GameDeleter;
        yield* seed;
        connectAgent(fake, "gs-b", ["worker", "gamestore"]);
        connectAgent(fake, "gs-c", ["worker", "gamestore"]);
        yield* deleter.tick;
        // Dota помечена к удалению только на gs-b — команда только ему.
        expect(fake.sent).toEqual([deleteDota]);

        // Итог от gs-c про ту же игру (у него она не помечена) — не в счёт,
        // и пометку на gs-b он не трогает.
        yield* deleter.handle(
          report("gs-c", { _tag: "GameDeleted", appId: DOTA }),
        );
        yield* deleter.handle(
          report("gs-c", {
            _tag: "GameDeleteFailed",
            appId: DOTA,
            reason: "Игра запущена",
          }),
        );
        const deletingOnB = (yield* apps).find(
          (a) => a.workerId === "gs-b" && a.appId === DOTA,
        );
        expect(deletingOnB?.deletingAt).toBeInstanceOf(Date);

        yield* deleter.handle(
          report("gs-b", { _tag: "GameDeleted", appId: DOTA }),
        );
        expect(yield* apps).toEqual([
          { workerId: "gs-b", appId: PORTAL, deletingAt: null },
          { workerId: "gs-c", appId: DOTA, deletingAt: null },
        ]);
      }),
    ));
});
