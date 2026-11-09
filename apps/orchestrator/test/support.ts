// Общие помощники тестов оркестратора: фейковый хаб, окружение `run`,
// фикстуры БД (пользователи, воркеры, сессии), тестовый конфиг и сравнение
// через JSON.
import { expect } from "bun:test";
import {
  Db,
  gamestoreApps,
  games,
  sessions,
  sha256Hex,
  user,
  workerClasses,
  workerCredentials,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import type {
  AgentCommand,
  AgentRoles,
  OwnGamePackage,
  WorkerHardware,
  WorkerStats,
  WorkerVersions,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import {
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  References,
  type Scope,
  Stream,
} from "effect";
import {
  AgentHub,
  type AgentHubEvent,
  type AgentHubShape,
  type WorkerInfo,
} from "../src/AgentHub";
import { OrchestratorConfig } from "../src/config";
import { SessionRunner, type SessionRunnerOptions } from "../src/SessionRunner";
import type { SteamLoginSeeds } from "../src/SteamLoginSeeds";
import { SteamLoginSeedsTest, testSeedKey } from "./seedKey";

/** Тестовый `PROFILE_KEY`: 32 байта 0x02 в base64. */
export const testProfileKey = Buffer.alloc(32, 2).toString("base64");

/** `RELAY_SECRET` тестового конфига (заголовок `x-cg-relay-secret` к relay). */
export const testRelaySecret = "test-relay-secret-test-relay-secret-0001";

/** Конфиг оркестратора для тестов HTTP: все секреты — заметные строки-метки. */
export const TestOrchestratorConfig = Layer.succeed(OrchestratorConfig, {
  port: 0,
  databaseUrl: Redacted.make("postgres://unused"),
  publicUrl: "https://game.example.ru",
  relayPort: 0,
  relaySecret: Redacted.make(testRelaySecret),
  s3PublicEndpoint: "https://s3.game.example.ru",
  s3Bucket: "cg-profiles",
  s3AccessKey: Redacted.make("test-s3-access"),
  s3SecretKey: Redacted.make("test-s3-secret"),
  profileKey: Redacted.make(testProfileKey),
  cgVersion: "1.2.3",
  registry: Option.some({
    server: "registry.example.ru",
    username: "cg-pull",
    password: Redacted.make("test-registry-password"),
  }),
  seedKey: testSeedKey,
});

/**
 * Сервер, как его заводит админка (строка `workers` без IP и слотов, по
 * желанию — в регионе), уже обменявший код на постоянный токен `token`
 * (в `worker_credentials` — только его хэш).
 */
export const seedWorker = (
  id: string,
  opts: { readonly regionId?: string; readonly token: string },
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(workers)
      .values({ id, publicIp: "", slots: 0, regionId: opts.regionId ?? null });
    yield* db.insert(workerCredentials).values({
      workerId: id,
      tokenHash: sha256Hex(opts.token),
      tokenIssuedAt: new Date(),
    });
  });

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
    tokenHash: () => undefined,
    disconnect: () => Effect.die("fake hub"),
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
 * `workers.stats` минимально достаточный для планировщика: нагрузка —
 * заглушки, важен только `ownGames` (раскатанные на воркере пакеты своих игр,
 * спека 2026-11-03 «Свои игры», `hasPackage`).
 */
const statsWith = (
  ownGamesList: ReadonlyArray<OwnGamePackage>,
): WorkerStats => ({
  cpuPercent: 0,
  memory: { totalBytes: 0, usedBytes: 0, cacheBytes: 0 },
  gpus: [],
  filesystems: [],
  uptimeSeconds: 0,
  ownGames: ownGamesList,
});

/**
 * `workers.versions` подключённого агента: клиент Steam собран
 * (`steamClientBuiltAt` не `null`) — без этого `eligibleWorkers` не даёт
 * воркеру Steam-игры (спека 2026-11-09 §5).
 */
export const versionsWithSteamClient: WorkerVersions = {
  agentCommit: "test",
  sessionImage: "cg-session:test",
  driver: null,
  steamClientBuiltAt: "2026-11-01T00:00:00.000Z",
};

/**
 * Игра `appId` в библиотеке сервера `workerId` (строка `gamestore_apps`,
 * своя у каждого сервера, спека 2026-11-09 §5); строка `games` заводится,
 * если её ещё нет. `deletingAt` — админ удаляет игру с этого сервера.
 */
export const installOn = (
  workerId: string,
  appId: number,
  opts: { readonly deletingAt?: Date } = {},
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(games)
      .values({ appId, name: `App ${appId}` })
      .onConflictDoNothing();
    yield* db
      .insert(gamestoreApps)
      .values({
        workerId,
        appId,
        sizeBytes: 1,
        buildId: "1",
        deletingAt: opts.deletingAt ?? null,
      })
      .onConflictDoNothing();
  });

/**
 * Агент воркера подключён: строка `workers` (как пишет хаб) + запись в фейке.
 * По умолчанию класс — «Стандарт» (`rank 1`, заводится, если его ещё нет);
 * `classRank: null` — воркер без класса (спека §2.1, сессий не берёт).
 * `ownGames` — пакеты своих игр, которые воркер уже раскатал (`workers.stats`,
 * спека 2026-11-03 «Свои игры»); нет опции — `stats` пустой (ни одного пакета).
 * `roles` — роли агента (по умолчанию `worker`; ставить игры — `gamestore`).
 * `library` — Steam-игры, уже стоящие в библиотеке этого сервера (по
 * умолчанию Dota 2, `570`, — большинство тестов размещают именно её).
 * `steamClient: false` — шаблон клиента Steam не собран
 * (`versions.steamClientBuiltAt = null`), Steam-игр сервер не берёт.
 */
export const connectWorker = (
  fake: FakeHub,
  workerId: string,
  slots: number,
  opts: {
    readonly classRank?: number | null;
    readonly hardware?: WorkerHardware;
    readonly ownGames?: ReadonlyArray<OwnGamePackage>;
    readonly roles?: AgentRoles;
    readonly library?: ReadonlyArray<number>;
    readonly steamClient?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const classRank = opts.classRank === undefined ? 1 : opts.classRank;
    const classId = classRank === null ? null : yield* classIdByRank(classRank);
    const roles = opts.roles ?? ["worker"];
    yield* db
      .insert(workers)
      .values({
        id: workerId,
        publicIp: "203.0.113.7",
        slots,
        classId,
        roles: [...roles],
        hardware: opts.hardware ?? null,
        versions:
          opts.steamClient === false
            ? { ...versionsWithSteamClient, steamClientBuiltAt: null }
            : versionsWithSteamClient,
        stats: opts.ownGames === undefined ? null : statsWith(opts.ownGames),
      })
      .onConflictDoNothing();
    for (const appId of opts.library ?? [570])
      yield* installOn(workerId, appId);
    fake.infos.set(workerId, {
      workerId,
      publicIp: "203.0.113.7",
      slots,
      udpPortBase: 59000,
      roles,
    });
  });

/**
 * Служебный сервер, которого нет на связи (в фейковом хабе его нет): у него
 * в библиотеке Dota 2 (`seedUsers`). Библиотека своя у каждого сервера
 * (спека 2026-11-09 §5), а игра на неподключённом сервере для размещения не в
 * счёт — тесты планировщика не должны от него зависеть.
 */
export const LIBRARY_FIXTURE_WORKER = "library-fixture";

/**
 * Игра 570 (Dota 2) + пользователи `ids`. Dota 2 стоит на
 * `LIBRARY_FIXTURE_WORKER` (не на связи); подключённым воркерам её ставит
 * `connectWorker` (опция `library`).
 */
export const seedUsers = (...ids: string[]) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(games)
      .values({ appId: 570, name: "Dota 2" })
      .onConflictDoNothing();
    yield* db
      .insert(workers)
      .values({
        id: LIBRARY_FIXTURE_WORKER,
        publicIp: "203.0.113.8",
        slots: 0,
        roles: ["worker", "gamestore"],
      })
      .onConflictDoNothing();
    yield* installOn(LIBRARY_FIXTURE_WORKER, 570);
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
  appId?: number;
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
