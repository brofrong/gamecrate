// Общие помощники тестов оркестратора: фейковый хаб, окружение `run`,
// фикстуры БД (пользователи, воркеры, сессии) и сравнение через JSON.
import { expect } from "bun:test";
import {
  Db,
  gamestoreApps,
  games,
  sessions,
  user,
  workerClasses,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import type { AgentCommand, WorkerHardware } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, PubSub, References, type Scope, Stream } from "effect";
import {
  AgentHub,
  type AgentHubEvent,
  type AgentHubShape,
  type WorkerInfo,
} from "../src/AgentHub";
import { SessionRunner, type SessionRunnerOptions } from "../src/SessionRunner";
import type { SteamLoginSeeds } from "../src/SteamLoginSeeds";
import { SteamLoginSeedsTest } from "./seedKey";

/** Фейковый хаб: подключённые воркеры и отправленные команды — в памяти. */
export const makeFakeHub = () => {
  const infos = new Map<string, WorkerInfo>();
  const sent: Array<{ workerId: string; command: AgentCommand }> = [];
  const state: {
    dropSends: boolean;
    refuse: (workerId: string, command: AgentCommand) => boolean;
  } = { dropSends: false, refuse: () => false };
  const events = Effect.runSync(PubSub.unbounded<AgentHubEvent>());
  const hub: AgentHubShape = {
    send: (workerId, command) =>
      Effect.sync(() => {
        if (
          state.dropSends ||
          !infos.has(workerId) ||
          state.refuse(workerId, command)
        )
          return false;
        sent.push({ workerId, command });
        return true;
      }),
    connected: () => new Set(infos.keys()),
    info: (workerId) => infos.get(workerId),
    workerOf: () => undefined,
    events,
    subscribe: PubSub.subscribe(events),
    connect: () => Stream.die("fake hub"),
    report: () => Effect.die("fake hub"),
  };
  return { hub, infos, sent, state };
};
export type FakeHub = ReturnType<typeof makeFakeHub>;

export type Env = Db | AgentHub | SessionRunner | SteamLoginSeeds | Scope.Scope;

/** Прогоняет тест с фейковым хабом и полным окружением оркестратора. */
export const run = <A, E>(
  body: (fake: FakeHub) => Effect.Effect<A, E, Env>,
  options: SessionRunnerOptions = {},
) => {
  const fake = makeFakeHub();
  return Effect.runPromise(
    Effect.scoped(body(fake)).pipe(
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.provide(
        SessionRunner.layerWithoutLoops(options).pipe(
          Layer.provideMerge(Layer.succeed(AgentHub, fake.hub)),
          Layer.provideMerge(SteamLoginSeedsTest),
          Layer.provideMerge(DbTest),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        ),
      ),
    ),
  );
};

export const at = (base: Date, seconds: number) =>
  new Date(base.getTime() + seconds * 1000);

/**
 * `toMatchObject` в Bun не сравнивает значения `Date` (любые две даты «совпадают»),
 * поэтому сравниваем через JSON: даты становятся ISO-строками.
 */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
export const like = (actual: unknown, expected: unknown) =>
  expect(json(actual)).toMatchObject(json(expected) as object);

/** Имя класса по умолчанию для ранга (совпадает с сидом миграции на `rank 1`). */
const classNameOf = (rank: number) =>
  rank === 1 ? "Стандарт" : `Класс ${rank}`;

/**
 * Находит класс воркера с данным `rank` или заводит его (тесты чистят таблицы
 * и не зависят от строки, которую сеет миграция).
 */
const classIdByRank = (rank: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [existing] = yield* db
      .select({ id: workerClasses.id })
      .from(workerClasses)
      .where(eq(workerClasses.rank, rank));
    if (existing !== undefined) return existing.id;
    const [created] = yield* db
      .insert(workerClasses)
      .values({ name: classNameOf(rank), rank })
      .returning({ id: workerClasses.id });
    return created!.id;
  });

/**
 * Агент воркера подключён: строка `workers` (как пишет хаб) + запись в фейке.
 * По умолчанию класс — «Стандарт» (`rank 1`, заводится, если его ещё нет);
 * `classRank: null` — воркер без класса (спека §2.1, сессий не берёт).
 */
export const connectWorker = (
  fake: FakeHub,
  workerId: string,
  slots: number,
  opts: {
    readonly classRank?: number | null;
    readonly hardware?: WorkerHardware;
  } = {},
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const classRank = opts.classRank === undefined ? 1 : opts.classRank;
    const classId = classRank === null ? null : yield* classIdByRank(classRank);
    yield* db
      .insert(workers)
      .values({
        id: workerId,
        publicIp: "203.0.113.7",
        slots,
        classId,
        hardware: opts.hardware ?? null,
      })
      .onConflictDoNothing();
    fake.infos.set(workerId, {
      workerId,
      publicIp: "203.0.113.7",
      slots,
      udpPortBase: 59000,
      roles: ["worker"],
    });
  });

/** Игра 570 (Dota 2) в общей библиотеке + пользователи `ids`. */
export const seedUsers = (...ids: string[]) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(games)
      .values({ appId: 570, name: "Dota 2" })
      .onConflictDoNothing();
    // Игра в библиотеке — планировщик размещает сессии, а не ставит в установку.
    yield* db
      .insert(gamestoreApps)
      .values({ appId: 570, sizeBytes: 1, buildId: "1" })
      .onConflictDoNothing();
    for (const id of ids)
      yield* db.insert(user).values({
        id,
        name: id,
        email: `${id}@steam.invalid`,
        emailVerified: false,
      });
  });

export const insertSession = (values: {
  id: string;
  userId: string;
  state?: (typeof sessions.$inferInsert)["state"];
  workerId?: string;
  slot?: number;
  createdAt?: Date;
  stateSince?: Date;
  clientSeenAt?: Date;
  lastInputAt?: Date;
  agentSeenAt?: Date;
  stopRequestedAt?: Date;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(sessions).values({ appId: 570, ...values });
  });
