import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { Db, profiles, regions, user, workerClasses, workers } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type AgentCommand, type AgentConnect, AgentRpcs } from "@cg/rpc";
import { BunHttpServer, BunSocket } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import {
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  PubSub,
  Queue,
  Redacted,
  References,
  type Scope,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { AgentHub, type AgentHubEvent } from "../src/AgentHub";
import { agentWebsocketUrl, orchestratorConfig } from "../src/config";
import { HttpApp } from "../src/http";
import { SteamLoginSeeds } from "../src/SteamLoginSeeds";
import { Tunnels } from "../src/Tunnels";
import { WorkerAuth } from "../src/WorkerAuth";
import { testSeedKey } from "./seedKey";
import {
  seedWorker,
  TestOrchestratorConfig,
  testProfileKey,
  testRelaySecret,
} from "./support";

/** Постоянный токен сервера `workerId` в этих тестах. */
const tokenOf = (workerId: string) => `cgw_test-token-of-${workerId}`;

/** Сервер `workerId`, заведённый админкой и уже получивший токен `tokenOf(workerId)`. */
const seeded = (workerId: string) =>
  seedWorker(workerId, { token: tokenOf(workerId) });

/** Настоящий Bun-сервер на свободном порту + AgentHub на временной БД. */
const TestServer = HttpRouter.serve(HttpApp, {
  disableLogger: true,
  disableListenLog: true,
}).pipe(
  Layer.provide(Tunnels.layer),
  Layer.provideMerge(WorkerAuth.layer),
  Layer.provideMerge(AgentHub.layer),
  Layer.provideMerge(SteamLoginSeeds.layer),
  Layer.provideMerge(DbTest),
  Layer.provide(TestOrchestratorConfig),
  Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
  Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
);

let runtime: ManagedRuntime.ManagedRuntime<
  HttpServer.HttpServer | AgentHub | Db,
  unknown
>;
let port: number;

beforeAll(async () => {
  runtime = ManagedRuntime.make(TestServer);
  const address = await runtime.runPromise(
    HttpServer.HttpServer.useSync((server) => server.address),
  );
  if (!("port" in address)) throw new Error("expected a TCP address");
  port = address.port;
  await runtime.runPromise(seeded("w-http"));
});
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, AgentHub | Db | Scope.Scope>) =>
  runtime.runPromise(Effect.scoped(effect));

/** Сырой апгрейд `GET /agent` по TCP: статусная строка ответа сервера. */
const rawUpgrade = (authorization?: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          "GET /agent HTTP/1.1",
          `host: 127.0.0.1:${port}`,
          "connection: Upgrade",
          "upgrade: websocket",
          "sec-websocket-version: 13",
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
          ...(authorization === undefined
            ? []
            : [`authorization: ${authorization}`]),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("error", reject);
  });

/**
 * RPC-клиент агента по WebSocket `/agent` (NDJSON) с токеном `token` на
 * апгрейде, живёт в текущем scope.
 */
const agentClient = (token: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          BunSocket.layerWebSocket(`ws://127.0.0.1:${port}/agent`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    return yield* RpcClient.make(AgentRpcs).pipe(
      Effect.provideContext(context),
    );
  });

const hello = (workerId: string): AgentConnect => ({
  token: Redacted.make(tokenOf(workerId)),
  workerId,
  publicIp: "203.0.113.7",
  slots: 1,
  udpPortBase: 59000,
  running: [
    {
      sessionId: "s-running",
      slot: 0,
      streamUrl: "http://cg-session-s-running:8080",
      gameRunning: true,
    },
  ],
  roles: ["worker", "gamestore"],
  installs: ["job-1"],
});

type AgentClient = Effect.Success<ReturnType<typeof agentClient>>;

/**
 * Подключает агента (новый WebSocket с токеном из `payload` или уже открытый
 * `client`): команды из потока `agent.connect` складываются в очередь.
 */
const connectAgent = (payload: AgentConnect, existing?: AgentClient) =>
  Effect.gen(function* () {
    const client =
      existing ?? (yield* agentClient(Redacted.value(payload.token)));
    const commands = yield* Queue.unbounded<AgentCommand>();
    const fiber = yield* client["agent.connect"](payload).pipe(
      Stream.runForEach((command) => Queue.offer(commands, command)),
      Effect.forkScoped,
    );
    return { client, commands, fiber };
  });

/** Ждёт первое событие хаба, подходящее под условие (не дольше 5 с). */
const waitEvent = <T extends AgentHubEvent>(
  events: PubSub.Subscription<AgentHubEvent>,
  match: (event: AgentHubEvent) => event is T,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* PubSub.take(events);
      if (match(event)) return event;
    }
  }).pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);

const isTag =
  <Tag extends AgentHubEvent["_tag"]>(tag: Tag, workerId: string) =>
  (event: AgentHubEvent): event is Extract<AgentHubEvent, { _tag: Tag }> =>
    event._tag === tag && event.workerId === workerId;

describe("http", () => {
  it("GET /healthz returns ok", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("agent without its server token gets 401 before upgrade", async () => {
    const token = tokenOf("w-http");
    expect(await rawUpgrade()).toContain(" 401 ");
    expect(await rawUpgrade("Bearer wrong-token")).toContain(" 401 ");
    expect(await rawUpgrade(token)).toContain(" 401 ");
    expect(await rawUpgrade(`Basic ${token}`)).toContain(" 401 ");
    expect(await rawUpgrade(`Bearer ${token}`)).toContain(" 101 ");
  });
});

describe("agent hub", () => {
  it("connect updates the worker row and send delivers command to its stream", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        yield* seeded("w-connect");
        const events = yield* hub.subscribe;
        const { commands } = yield* connectAgent(hello("w-connect"));

        const connected = yield* waitEvent(
          events,
          isTag("Connected", "w-connect"),
        );
        expect(connected).toEqual({
          _tag: "Connected",
          workerId: "w-connect",
          publicIp: "203.0.113.7",
          slots: 1,
          udpPortBase: 59000,
          roles: ["worker", "gamestore"],
          running: hello("w-connect").running,
          installs: ["job-1"],
        });
        expect(hub.connected().has("w-connect")).toBe(true);
        expect(hub.info("w-connect")).toEqual({
          workerId: "w-connect",
          publicIp: "203.0.113.7",
          slots: 1,
          udpPortBase: 59000,
          roles: ["worker", "gamestore"],
        });

        const [row] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-connect"));
        expect(row?.publicIp).toBe("203.0.113.7");
        expect(row?.slots).toBe(1);
        expect(row?.lastSeenAt).toBeInstanceOf(Date);

        const command: AgentCommand = {
          _tag: "StartSession",
          sessionId: "s-1",
          userId: "u-1",
          appId: 620,
          slot: 0,
          udpPort: 59000,
          profile: null,
          steamLogin: null,
          display: { width: 1920, height: 1080 },
        };
        expect(yield* hub.send("w-connect", command)).toBe(true);
        const received = yield* Queue.take(commands).pipe(
          Effect.timeout(Duration.seconds(5)),
        );
        expect(received).toEqual(command);
      }),
    ));

  it("reconnect updates the worker row", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        yield* seeded("w-upsert");
        const events = yield* hub.subscribe;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* connectAgent(hello("w-upsert"));
            yield* waitEvent(events, isTag("Connected", "w-upsert"));
          }),
        );
        yield* connectAgent({
          ...hello("w-upsert"),
          publicIp: "198.51.100.1",
          slots: 2,
        });
        yield* waitEvent(events, isTag("Connected", "w-upsert"));
        const rows = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-upsert"));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.publicIp).toBe("198.51.100.1");
        expect(rows[0]?.slots).toBe(2);
      }),
    ));

  it("hub update keeps class_id and region_id", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        const [region] = yield* db
          .insert(regions)
          .values({ code: "spb", name: "Санкт-Петербург" })
          .returning();
        yield* seedWorker("w-class", {
          token: tokenOf("w-class"),
          regionId: region!.id,
        });
        const events = yield* hub.subscribe;
        yield* connectAgent(hello("w-class"));
        yield* waitEvent(events, isTag("Connected", "w-class"));

        const [inserted] = yield* db
          .insert(workerClasses)
          .values({ name: "Быстрое", rank: 2 })
          .returning();
        const classId = inserted?.id;
        expect(classId).toBeDefined();
        yield* db
          .update(workers)
          .set({ classId })
          .where(eq(workers.id, "w-class"));

        yield* connectAgent(hello("w-class"));
        yield* waitEvent(events, isTag("Connected", "w-class"));

        const [row] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-class"));
        expect(row?.classId).toBe(classId);
        expect(row?.regionId).toBe(region!.id);
      }),
    ));

  it("agent.connect with another server's token fails with AgentUnauthorized", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        yield* seeded("w-owner");
        yield* seeded("w-victim");
        const events = yield* hub.subscribe;
        const victim = yield* connectAgent(hello("w-victim"));
        yield* waitEvent(events, isTag("Connected", "w-victim"));

        // Действующий токен w-owner пускает на апгрейде, но выдать себя за
        // w-victim по нему нельзя: поток падает, текущее соединение w-victim
        // и его строка `workers` не тронуты.
        const client = yield* agentClient(tokenOf("w-owner"));
        const spoofed = yield* client["agent.connect"]({
          ...hello("w-victim"),
          token: Redacted.make(tokenOf("w-owner")),
          publicIp: "198.51.100.66",
        }).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.timeout(Duration.seconds(5)),
        );
        expect(spoofed._tag).toBe("AgentUnauthorized");
        expect(hub.info("w-victim")?.publicIp).toBe("203.0.113.7");
        const [row] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-victim"));
        expect(row?.publicIp).toBe("203.0.113.7");
        const command: AgentCommand = { _tag: "StopSession", sessionId: "s" };
        expect(yield* hub.send("w-victim", command)).toBe(true);
        expect(
          yield* Queue.take(victim.commands).pipe(
            Effect.timeout(Duration.seconds(5)),
          ),
        ).toEqual(command);

        // По тому же сокету — своим id и своим токеном — подключиться можно.
        yield* connectAgent(hello("w-owner"), client);
        yield* waitEvent(events, isTag("Connected", "w-owner"));
      }),
    ));

  it("send to unknown worker returns false", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        expect(
          yield* hub.send("w-unknown", { _tag: "StopSession", sessionId: "s" }),
        ).toBe(false);
        expect(hub.connected().has("w-unknown")).toBe(false);
        expect(hub.info("w-unknown")).toBeUndefined();
      }),
    ));

  it("reports are published as hub events", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        yield* seeded("w-report");
        const events = yield* hub.subscribe;
        const { client } = yield* connectAgent(hello("w-report"));
        yield* waitEvent(events, isTag("Connected", "w-report"));

        yield* client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });
        yield* client["agent.report"]({
          _tag: "StreamReady",
          sessionId: "s-running",
          streamUrl: "http://cg-session-s-running:8080",
        });

        const heartbeat = yield* waitEvent(events, isTag("Report", "w-report"));
        expect(heartbeat.report).toEqual({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });
        const ready = yield* waitEvent(events, isTag("Report", "w-report"));
        expect(ready.report).toEqual({
          _tag: "StreamReady",
          sessionId: "s-running",
          streamUrl: "http://cg-session-s-running:8080",
        });
      }),
    ));

  it("connect stores roles, hardware and versions; WorkerStats updates stats and stats_at without publishing", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        yield* seeded("w-snapshot");
        yield* seeded("w-plain");
        const events = yield* hub.subscribe;
        const hardware = {
          cpuModel: "AMD Ryzen 9 5950X",
          cpuCores: 16,
          cpuThreads: 32,
          memoryBytes: 64_000_000_000,
          gpus: [{ name: "RTX 4090", memoryBytes: 24_000_000_000 }],
          disks: [
            {
              name: "nvme0n1",
              kind: "nvme" as const,
              sizeBytes: 2_000_000_000_000,
              raidLevel: null,
              members: [],
            },
          ],
        };
        const versions = {
          agentCommit: "abc123",
          sessionImage: "cg-session:1.2.3",
          driver: "550.90.07",
          steamClientBuiltAt: "2026-10-01T00:00:00.000Z",
        };
        const { client } = yield* connectAgent({
          ...hello("w-snapshot"),
          hardware,
          versions,
        });
        yield* waitEvent(events, isTag("Connected", "w-snapshot"));

        const [row] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-snapshot"));
        expect(row?.roles).toEqual(["worker", "gamestore"]);
        expect(row?.hardware?.cpuModel).toBe("AMD Ryzen 9 5950X");
        expect(row?.versions).toEqual(versions);
        expect(row?.stats).toBeNull();
        expect(row?.statsAt).toBeNull();

        const stats = {
          cpuPercent: 12.5,
          memory: { totalBytes: 1000, usedBytes: 500, cacheBytes: 100 },
          gpus: [],
          filesystems: [],
          uptimeSeconds: 3600,
        };
        yield* client["agent.report"]({ _tag: "WorkerStats", stats });

        // Если бы хаб опубликовал `WorkerStats` как `Report`, его бы и поймал
        // следующий `waitEvent` (он не фильтрует по вложенному тэгу отчёта) —
        // вместо этого первым должен прийти следующий отчёт, Heartbeat.
        yield* client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });
        const next = yield* waitEvent(events, isTag("Report", "w-snapshot"));
        expect(next.report).toEqual({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });

        const [updated] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-snapshot"));
        expect(updated?.stats?.cpuPercent).toBe(12.5);
        expect(updated?.statsAt).toBeInstanceOf(Date);

        // Подключение без hardware/versions — `null` в БД.
        yield* connectAgent(hello("w-plain"));
        yield* waitEvent(events, isTag("Connected", "w-plain"));
        const [plainRow] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-plain"));
        expect(plainRow?.hardware).toBeNull();
        expect(plainRow?.versions).toBeNull();
      }),
    ));

  it("a failed WorkerStats write is logged, not agent.report failing or dropping the link", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        yield* seeded("w-stats-write-fails");
        const events = yield* hub.subscribe;
        const { client } = yield* connectAgent(hello("w-stats-write-fails"));
        yield* waitEvent(events, isTag("Connected", "w-stats-write-fails"));

        // Симулируем сбой записи (как транзиентная ошибка БД): ломаем update
        // ровно того столбца, который пишет WorkerStats, временно убрав его.
        yield* db.$client.unsafe("ALTER TABLE workers DROP COLUMN stats");
        try {
          const stats = {
            cpuPercent: 1,
            memory: { totalBytes: 1, usedBytes: 1, cacheBytes: 0 },
            gpus: [],
            filesystems: [],
            uptimeSeconds: 1,
          };
          // Effect.orDie тут завалил бы agent.report (и с ним — WebSocket);
          // catchCause должен просто залогировать и вернуть успех.
          yield* client["agent.report"]({ _tag: "WorkerStats", stats });
        } finally {
          yield* db.$client.unsafe(
            "ALTER TABLE workers ADD COLUMN stats jsonb",
          );
        }

        // Соединение агента всё ещё живо: обычный отчёт после сбоя доходит и
        // публикуется, как будто ничего не случилось.
        yield* client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });
        const next = yield* waitEvent(
          events,
          isTag("Report", "w-stats-write-fails"),
        );
        expect(next.report).toEqual({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });
        expect(hub.connected().has("w-stats-write-fails")).toBe(true);
      }),
    ));

  it("report without connect is AgentNotConnected", () =>
    run(
      Effect.gen(function* () {
        yield* seeded("w-early");
        const client = yield* agentClient(tokenOf("w-early"));
        const result = yield* client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: [],
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure._tag).toBe("AgentNotConnected");
      }),
    ));

  it("profile commit needs agent.connect and versions the profile", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        yield* db.insert(user).values({
          id: "u-commit",
          name: "u-commit",
          email: "u-commit@steam.invalid",
          emailVerified: false,
        });
        const commit = {
          userId: "u-commit",
          baseVersion: null,
          objectKey: "profiles/u-commit/a.cgp",
          sizeBytes: 42,
          steamLoginSeeded: false,
        };

        // Соединение без agent.connect — не обработан (агент повторит).
        yield* seeded("w-commit");
        const client = yield* agentClient(tokenOf("w-commit"));
        const early = yield* client["agent.profileCommit"](commit).pipe(
          Effect.result,
        );
        expect(early._tag).toBe("Failure");
        if (early._tag === "Failure")
          expect(early.failure._tag).toBe("AgentNotConnected");
        expect(
          yield* db
            .select()
            .from(profiles)
            .where(eq(profiles.userId, "u-commit")),
        ).toEqual([]);

        const events = yield* hub.subscribe;
        yield* connectAgent(hello("w-commit"), client);
        yield* waitEvent(events, isTag("Connected", "w-commit"));
        expect(yield* client["agent.profileCommit"](commit)).toEqual({
          accepted: true,
        });
        expect(
          yield* client["agent.profileCommit"]({
            ...commit,
            baseVersion: 1,
            objectKey: "profiles/u-commit/b.cgp",
          }),
        ).toEqual({ accepted: true });
        // Повтор с той же базой — устарел.
        expect(
          yield* client["agent.profileCommit"]({ ...commit, baseVersion: 1 }),
        ).toEqual({ accepted: false });
        const [row] = yield* db
          .select()
          .from(profiles)
          .where(eq(profiles.userId, "u-commit"));
        expect(row?.version).toBe(2);
        expect(row?.objectKey).toBe("profiles/u-commit/b.cgp");
      }),
    ));

  it("disconnect publishes Disconnected", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        yield* seeded("w-gone");
        const events = yield* hub.subscribe;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* connectAgent(hello("w-gone"));
            yield* waitEvent(events, isTag("Connected", "w-gone"));
          }),
        );
        // Закрытие scope закрыло WebSocket агента.
        yield* waitEvent(events, isTag("Disconnected", "w-gone"));
        expect(hub.connected().has("w-gone")).toBe(false);
        expect(
          yield* hub.send("w-gone", { _tag: "StopSession", sessionId: "s" }),
        ).toBe(false);
      }),
    ));

  it("newer connection of the same worker wins", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        yield* seeded("w-twice");
        const events = yield* hub.subscribe;
        const first = yield* connectAgent(hello("w-twice"));
        yield* waitEvent(events, isTag("Connected", "w-twice"));
        const second = yield* connectAgent(hello("w-twice"));
        yield* waitEvent(events, isTag("Connected", "w-twice"));

        // Старый поток команд завершается; воркер остаётся подключённым.
        yield* Fiber.join(first.fiber).pipe(
          Effect.timeout(Duration.seconds(5)),
        );
        expect(hub.connected().has("w-twice")).toBe(true);

        const command: AgentCommand = { _tag: "StopSession", sessionId: "s" };
        expect(yield* hub.send("w-twice", command)).toBe(true);
        expect(
          yield* Queue.take(second.commands).pipe(
            Effect.timeout(Duration.seconds(5)),
          ),
        ).toEqual(command);

        // Отчёты по старому соединению больше не принимаются.
        const stale = yield* first.client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: [],
        }).pipe(Effect.result);
        expect(stale._tag).toBe("Failure");
      }),
    ));

  it("same socket re-connect keeps report routing", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        yield* seeded("w-same");
        const events = yield* hub.subscribe;
        const first = yield* connectAgent(hello("w-same"));
        yield* waitEvent(events, isTag("Connected", "w-same"));
        const second = yield* connectAgent(hello("w-same"), first.client);
        yield* waitEvent(events, isTag("Connected", "w-same"));
        yield* Fiber.join(first.fiber).pipe(
          Effect.timeout(Duration.seconds(5)),
        );

        yield* first.client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: ["s-same"],
        });
        const reported = yield* waitEvent(events, isTag("Report", "w-same"));
        expect(reported.report).toEqual({
          _tag: "Heartbeat",
          sessionIds: ["s-same"],
        });

        const command: AgentCommand = { _tag: "StopSession", sessionId: "s" };
        expect(yield* hub.send("w-same", command)).toBe(true);
        expect(
          yield* Queue.take(second.commands).pipe(
            Effect.timeout(Duration.seconds(5)),
          ),
        ).toEqual(command);
      }),
    ));

  it("newest connection stays current when an older connect is slower", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        const events = yield* hub.subscribe;
        const older = { ...hello("w-race"), publicIp: "192.0.2.1", slots: 1 };
        const newer = { ...hello("w-race"), publicIp: "192.0.2.2", slots: 2 };
        yield* seeded("w-race");

        // Блокировка строки воркера: upsert старшего соединения повисает в БД.
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select()
                .from(workers)
                .where(eq(workers.id, "w-race"))
                .for("update");
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.orDie, Effect.forkScoped);
        yield* Deferred.await(locked);

        /** Ждёт, пока текущим соединением воркера станет соединение с этим IP. */
        const awaitCurrent = (publicIp: string) =>
          Effect.gen(function* () {
            while (hub.info("w-race")?.publicIp !== publicIp)
              yield* Effect.sleep(Duration.millis(10));
          }).pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);

        const first = yield* connectAgent(older);
        yield* awaitCurrent(older.publicIp);
        const second = yield* connectAgent(newer);
        yield* awaitCurrent(newer.publicIp);
        yield* Deferred.succeed(release, undefined);

        // Первое `Connected` — новое соединение; старое вытеснено, его поток закрыт.
        const connected = yield* waitEvent(
          events,
          isTag("Connected", "w-race"),
        );
        expect(connected.publicIp).toBe(newer.publicIp);
        yield* Fiber.join(first.fiber).pipe(
          Effect.timeout(Duration.seconds(5)),
        );
        expect(hub.info("w-race")?.publicIp).toBe(newer.publicIp);

        const [row] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-race"));
        expect(row?.publicIp).toBe(newer.publicIp);
        expect(row?.slots).toBe(2);

        const command: AgentCommand = { _tag: "StopSession", sessionId: "s" };
        expect(yield* hub.send("w-race", command)).toBe(true);
        expect(
          yield* Queue.take(second.commands).pipe(
            Effect.timeout(Duration.seconds(5)),
          ),
        ).toEqual(command);
      }),
    ));
});

/** Минимальное окружение, с которым оркестратор стартует. */
const baseEnv = {
  DATABASE_URL: "postgres://unused",
  ORCHESTRATOR_PUBLIC_URL: "https://game.example.ru",
  S3_PUBLIC_ENDPOINT: "https://s3.game.example.ru",
  S3_ACCESS_KEY: "access-key",
  S3_SECRET_KEY: "secret-key",
  PROFILE_KEY: testProfileKey,
  SEED_KEY: Redacted.value(testSeedKey),
  RELAY_SECRET: testRelaySecret,
};

/** Разбор конфига по окружению `env`; `undefined` — переменной нет. */
const parse = (env: Record<string, string | undefined>) =>
  Effect.runPromise(
    orchestratorConfig
      .parse(
        ConfigProvider.fromUnknown(
          Object.fromEntries(
            Object.entries(env).filter(([, value]) => value !== undefined),
          ),
        ),
      )
      .pipe(Effect.result),
  );

describe("config", () => {
  it("starts without AGENT_TOKEN; defaults for ports, bucket, version and registry", async () => {
    const result = await parse(baseEnv);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.port).toBe(3001);
    expect(result.success.relayPort).toBe(3002);
    expect(result.success.s3Bucket).toBe("cg-profiles");
    expect(result.success.cgVersion).toBe("dev");
    expect(result.success.registry._tag).toBe("None");
    expect(result.success.publicUrl).toBe("https://game.example.ru");
    expect(result.success.s3PublicEndpoint).toBe("https://s3.game.example.ru");
    expect(Redacted.value(result.success.s3SecretKey)).toBe("secret-key");
    expect(Redacted.value(result.success.profileKey)).toBe(testProfileKey);
  });

  it("requires the public URL with an http(s) scheme, S3 and PROFILE_KEY", async () => {
    for (const env of [
      { ...baseEnv, ORCHESTRATOR_PUBLIC_URL: undefined },
      { ...baseEnv, ORCHESTRATOR_PUBLIC_URL: "game.example.ru" },
      { ...baseEnv, S3_PUBLIC_ENDPOINT: undefined },
      { ...baseEnv, S3_ACCESS_KEY: undefined },
      { ...baseEnv, S3_SECRET_KEY: undefined },
      { ...baseEnv, PROFILE_KEY: undefined },
    ]) {
      const result = await parse(env);
      expect(result._tag).toBe("Failure");
    }
  });

  it("public URL is an origin only, a trailing slash is dropped", async () => {
    for (const [value, expected] of [
      ["https://game.example.ru", "https://game.example.ru"],
      ["https://game.example.ru/", "https://game.example.ru"],
      ["http://127.0.0.1:3001", "http://127.0.0.1:3001"],
      ["http://127.0.0.1:3001/", "http://127.0.0.1:3001"],
    ] as const) {
      const result = await parse({
        ...baseEnv,
        ORCHESTRATOR_PUBLIC_URL: value,
      });
      expect(result._tag).toBe("Success");
      if (result._tag === "Success")
        expect(result.success.publicUrl).toBe(expected);
    }
    for (const value of [
      "https://game.example.ru/app",
      "https://game.example.ru//",
      "https://game.example.ru?x=1",
      "https://game.example.ru/?x=1",
      "https://game.example.ru#top",
      "https://user@game.example.ru",
      "https://game.example.ru /",
      "ftp://game.example.ru",
      "https://",
    ]) {
      const result = await parse({
        ...baseEnv,
        ORCHESTRATOR_PUBLIC_URL: value,
      });
      expect(result._tag).toBe("Failure");
    }
  });

  it("requires RELAY_SECRET of at least 32 characters without echoing it", async () => {
    const ok = await parse(baseEnv);
    expect(ok._tag).toBe("Success");
    if (ok._tag === "Success")
      expect(Redacted.value(ok.success.relaySecret)).toBe(testRelaySecret);
    const short = "s".repeat(31);
    for (const value of [undefined, short]) {
      const result = await parse({ ...baseEnv, RELAY_SECRET: value });
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(String(result.failure)).not.toContain(short);
    }
  });

  it("rejects a PROFILE_KEY that is not base64 of 32 bytes without echoing it", async () => {
    const short = Buffer.alloc(31, 7).toString("base64");
    for (const key of [short, "x".repeat(44)]) {
      const result = await parse({ ...baseEnv, PROFILE_KEY: key });
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ConfigError");
        expect(String(result.failure)).not.toContain(key);
      }
    }
  });

  it("registry needs all three REGISTRY_* or none", async () => {
    const registry = {
      REGISTRY_SERVER: "registry.example.ru",
      REGISTRY_USERNAME: "cg-pull",
      REGISTRY_PASSWORD: "registry-s3cr3t",
    };
    const full = await parse({ ...baseEnv, ...registry, CG_VERSION: "1.4.0" });
    expect(full._tag).toBe("Success");
    if (full._tag === "Success") {
      expect(full.success.cgVersion).toBe("1.4.0");
      const value = full.success.registry;
      expect(value._tag).toBe("Some");
      if (value._tag === "Some") {
        expect(value.value.server).toBe("registry.example.ru");
        expect(value.value.username).toBe("cg-pull");
        expect(Redacted.value(value.value.password)).toBe("registry-s3cr3t");
      }
    }
    for (const missing of Object.keys(registry)) {
      const result = await parse({
        ...baseEnv,
        ...registry,
        [missing]: undefined,
      });
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(String(result.failure)).not.toContain("registry-s3cr3t");
    }
  });

  it("agent WebSocket URL follows the public URL scheme", () => {
    expect(agentWebsocketUrl("https://g.example")).toBe(
      "wss://g.example/agent",
    );
    expect(agentWebsocketUrl("https://g.example/")).toBe(
      "wss://g.example/agent",
    );
    expect(agentWebsocketUrl("http://127.0.0.1:3001")).toBe(
      "ws://127.0.0.1:3001/agent",
    );
  });
});

describe("config SEED_KEY", () => {
  it("rejects a missing, empty or non-32-byte key without echoing it", async () => {
    const short = Buffer.alloc(31, 7).toString("base64");
    const long = Buffer.alloc(33, 7).toString("base64");
    const notBase64 = `${"!".repeat(43)}=`;
    for (const env of [
      { SEED_KEY: undefined },
      { SEED_KEY: "" },
      { SEED_KEY: short },
      { SEED_KEY: long },
      { SEED_KEY: notBase64 },
    ]) {
      const result = await parse({ ...baseEnv, ...env });
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ConfigError");
        if (env.SEED_KEY !== undefined && env.SEED_KEY !== "")
          expect(String(result.failure)).not.toContain(env.SEED_KEY);
      }
    }
  });

  it("accepts base64 of exactly 32 bytes", async () => {
    const key = Buffer.alloc(32, 9).toString("base64");
    const result = await parse({ ...baseEnv, SEED_KEY: key });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success")
      expect(Redacted.value(result.success.seedKey)).toBe(key);
  });
});
