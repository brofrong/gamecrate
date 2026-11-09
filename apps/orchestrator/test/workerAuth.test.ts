import { describe, expect, it } from "bun:test";
import { Db, regions, sha256Hex, workerCredentials, workers } from "@cg/db";
import { DbTest } from "@cg/db/test";
import type { AgentConnect } from "@cg/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Redacted,
  References,
  type Scope,
  Stream,
} from "effect";
import { HttpRouter } from "effect/http";
import { TestClock } from "effect/testing";
import { AgentHub, type AgentHubEvent } from "../src/AgentHub";
import { HttpApp } from "../src/http";
import { WorkerAuth } from "../src/WorkerAuth";
import { SteamLoginSeedsTest } from "./seedKey";
import { seedWorker, TestOrchestratorConfig, testProfileKey } from "./support";

const SPB_TOKEN = "cgw_spb-1-test-token";
const MSK_TOKEN = "cgw_msk-1-test-token";
const CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** HTTP-приложение оркестратора как функция `Request → Response`. */
type Http = (request: Request) => Effect.Effect<Response>;

type Env = Db | AgentHub | WorkerAuth | Scope.Scope;

/**
 * Свежая БД и настоящий хаб; `WorkerAuth` (с фоновой проверкой отзыва) и
 * тело теста — на тестовых часах, пул БД — на настоящих. HTTP-приложение
 * (`HttpRouter.toWebHandler`) — на тех же Db, хабе и `WorkerAuth`.
 */
const run = <A, E>(body: (http: Http) => Effect.Effect<A, E, Env>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const auth = Context.get(
          yield* Layer.build(WorkerAuth.layer),
          WorkerAuth,
        );
        const services = yield* Effect.context<Db | AgentHub>();
        const web = HttpRouter.toWebHandler(
          HttpApp.pipe(
            Layer.provide(SteamLoginSeedsTest),
            Layer.provide(
              Layer.succeedContext(Context.add(services, WorkerAuth, auth)),
            ),
            Layer.provide(TestOrchestratorConfig),
            Layer.provide(BunHttpServer.layerHttpServices),
            Layer.provideMerge(
              Layer.succeed(References.MinimumLogLevel, "Error"),
            ),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
        const http: Http = (request) =>
          Effect.promise(() => web.handler(request));
        return yield* body(http).pipe(Effect.provideService(WorkerAuth, auth));
      }).pipe(Effect.provide(TestClock.layer())),
    ).pipe(
      Effect.provide(AgentHub.layer.pipe(Layer.provideMerge(DbTest))),
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );

/** Регион `spb` и сервер `spb-1` в нём с кодом подключения `CODE`, истекающим в `expiresAt`. */
const seedEnrolling = (expiresAt: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [region] = yield* db
      .insert(regions)
      .values({ code: "spb", name: "Санкт-Петербург" })
      .returning();
    yield* db
      .insert(workers)
      .values({ id: "spb-1", publicIp: "", slots: 0, regionId: region!.id });
    yield* db.insert(workerCredentials).values({
      workerId: "spb-1",
      enrollCodeHash: sha256Hex(CODE),
      enrollExpiresAt: expiresAt,
    });
  });

const enrollRequest = (body: string) =>
  new Request("http://localhost/agent/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const getRequest = (path: string, token?: string) =>
  new Request(`http://localhost${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const hello = (workerId: string, token: string): AgentConnect => ({
  token: Redacted.make(token),
  workerId,
  publicIp: "203.0.113.7",
  slots: 2,
  udpPortBase: 59000,
  running: [],
  roles: ["worker"],
  installs: [],
});

/** Ждёт событие хаба `tag` для `workerId` (без тайм-аута: часы тестовые). */
const waitEvent = (
  events: PubSub.Subscription<AgentHubEvent>,
  tag: AgentHubEvent["_tag"],
  workerId: string,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* PubSub.take(events);
      if (event._tag === tag && event.workerId === workerId) return event;
    }
  });

describe("enroll", () => {
  it("enroll exchanges a valid code once", () =>
    run((http) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const auth = yield* WorkerAuth;
        yield* seedEnrolling(new Date(Date.now() + 3_600_000));

        const first = yield* http(
          enrollRequest(JSON.stringify({ code: CODE })),
        );
        expect(first.status).toBe(200);
        expect(first.headers.get("cache-control")).toBe("no-store");
        const body = (yield* Effect.promise(() => first.json())) as Record<
          string,
          unknown
        > & { token: string };
        expect(body).toEqual({
          workerId: "spb-1",
          token: expect.any(String),
          regionCode: "spb",
          orchestratorUrl: "wss://game.example.ru/agent",
          version: "1.2.3",
          registry: {
            server: "registry.example.ru",
            username: "cg-pull",
            password: "test-registry-password",
          },
        });
        expect(body.token.startsWith("cgw_")).toBe(true);
        expect(yield* auth.workerOfToken(body.token)).toEqual(
          Option.some("spb-1"),
        );

        // В БД — только хэш нового токена; код снят.
        const [credentials] = yield* db
          .select()
          .from(workerCredentials)
          .where(eq(workerCredentials.workerId, "spb-1"));
        expect(credentials?.tokenHash).toBe(sha256Hex(body.token));
        expect(credentials?.enrollCodeHash).toBeNull();
        expect(credentials?.tokenIssuedAt).toBeInstanceOf(Date);
        expect(credentials?.revokedAt).toBeNull();

        const second = yield* http(
          enrollRequest(JSON.stringify({ code: CODE })),
        );
        expect(second.status).toBe(403);
        expect(yield* Effect.promise(() => second.json())).toEqual({
          error: "Код недействителен или истёк",
        });
      }),
    ));

  it("enroll succeeds only once for concurrent exchanges of one code", () =>
    run((http) =>
      Effect.gen(function* () {
        yield* seedEnrolling(new Date(Date.now() + 3_600_000));
        const statuses = yield* Effect.all(
          Array.from({ length: 5 }, () =>
            http(enrollRequest(JSON.stringify({ code: CODE }))).pipe(
              Effect.map((response) => response.status),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(statuses.filter((status) => status === 200)).toHaveLength(1);
        expect(statuses.filter((status) => status === 403)).toHaveLength(4);
      }),
    ));

  it("enroll refuses an expired code", () =>
    run((http) =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedEnrolling(new Date(Date.now() - 1_000));
        const response = yield* http(
          enrollRequest(JSON.stringify({ code: CODE })),
        );
        expect(response.status).toBe(403);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          error: "Код недействителен или истёк",
        });
        const [credentials] = yield* db
          .select()
          .from(workerCredentials)
          .where(eq(workerCredentials.workerId, "spb-1"));
        expect(credentials?.tokenHash).toBeNull();
      }),
    ));

  it("enroll refuses a wrong code or a malformed body", () =>
    run((http) =>
      Effect.gen(function* () {
        yield* seedEnrolling(new Date(Date.now() + 3_600_000));
        for (const body of [
          JSON.stringify({ code: "ZZZZZZZZZZZZZZZZZZZZZZZZ" }),
          JSON.stringify({ code: 42 }),
          JSON.stringify({}),
          "not json",
        ]) {
          const response = yield* http(enrollRequest(body));
          expect(response.status).toBe(403);
        }
        // Код после неудачных попыток всё ещё действует.
        const ok = yield* http(enrollRequest(JSON.stringify({ code: CODE })));
        expect(ok.status).toBe(200);
      }),
    ));

  it("enroll of a server without a region returns regionCode null", () =>
    run((http) =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db
          .insert(workers)
          .values({ id: "solo-1", publicIp: "", slots: 0 });
        yield* db.insert(workerCredentials).values({
          workerId: "solo-1",
          enrollCodeHash: sha256Hex(CODE),
          enrollExpiresAt: new Date(Date.now() + 3_600_000),
        });
        const response = yield* http(
          enrollRequest(JSON.stringify({ code: CODE })),
        );
        expect(response.status).toBe(200);
        const body = (yield* Effect.promise(() => response.json())) as {
          workerId: string;
          regionCode: string | null;
        };
        expect(body.workerId).toBe("solo-1");
        expect(body.regionCode).toBeNull();
      }),
    ));
});

describe("worker token", () => {
  it("config requires a worker token", () =>
    run((http) =>
      Effect.gen(function* () {
        yield* seedWorker("spb-1", { token: SPB_TOKEN });

        const anonymous = yield* http(getRequest("/agent/config"));
        expect(anonymous.status).toBe(401);
        const wrong = yield* http(getRequest("/agent/config", "cgw_unknown"));
        expect(wrong.status).toBe(401);

        const response = yield* http(getRequest("/agent/config", SPB_TOKEN));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => response.json())).toEqual({
          s3: {
            endpoint: "https://s3.game.example.ru",
            bucket: "cg-profiles",
            accessKey: "test-s3-access",
            secretKey: "test-s3-secret",
          },
          profileKey: testProfileKey,
        });
      }),
    ));

  it("GET /agent with unknown token is 401", () =>
    run((http) =>
      Effect.gen(function* () {
        yield* seedWorker("spb-1", { token: SPB_TOKEN });
        expect((yield* http(getRequest("/agent"))).status).toBe(401);
        expect((yield* http(getRequest("/agent", "cgw_unknown"))).status).toBe(
          401,
        );
        expect(
          (yield* http(
            new Request("http://localhost/agent", {
              headers: { authorization: SPB_TOKEN },
            }),
          )).status,
        ).toBe(401);
      }),
    ));

  it("connect with another worker's id fails with AgentUnauthorized", () =>
    run(() =>
      Effect.gen(function* () {
        const db = yield* Db;
        const hub = yield* AgentHub;
        yield* seedWorker("spb-1", { token: SPB_TOKEN });
        yield* seedWorker("msk-1", { token: MSK_TOKEN });
        const [before] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "msk-1"));

        for (const payload of [
          // Токен spb-1, а id — msk-1.
          hello("msk-1", SPB_TOKEN),
          // Своё имя, но токен неизвестен.
          hello("msk-1", "cgw_unknown"),
        ]) {
          const failure = yield* hub
            .connect(1, payload)
            .pipe(Stream.runDrain, Effect.flip);
          expect(failure._tag).toBe("AgentUnauthorized");
        }

        expect(hub.connected().has("msk-1")).toBe(false);
        const [after] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "msk-1"));
        expect(after).toEqual(before!);
      }),
    ));

  it("revoked worker is kicked and refused", () =>
    run((http) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const hub = yield* AgentHub;
        yield* seedWorker("spb-1", { token: SPB_TOKEN });
        yield* seedWorker("msk-1", { token: MSK_TOKEN });
        const events = yield* hub.subscribe;
        const spb = yield* hub
          .connect(1, hello("spb-1", SPB_TOKEN))
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* waitEvent(events, "Connected", "spb-1");
        yield* hub
          .connect(2, hello("msk-1", MSK_TOKEN))
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* waitEvent(events, "Connected", "msk-1");

        // Как `revoke` админки.
        yield* db
          .update(workerCredentials)
          .set({ tokenHash: null, enrollCodeHash: null, revokedAt: new Date() })
          .where(eq(workerCredentials.workerId, "spb-1"));
        expect(hub.connected().has("spb-1")).toBe(true);

        yield* TestClock.adjust("10 seconds");
        yield* waitEvent(events, "Disconnected", "spb-1");
        expect(hub.connected().has("spb-1")).toBe(false);
        // Поток команд отозванного сервера закрыт; соседний сервер на
        // действующем токене остался подключён.
        yield* Fiber.join(spb);
        expect(hub.connected().has("msk-1")).toBe(true);

        expect((yield* http(getRequest("/agent", SPB_TOKEN))).status).toBe(401);
        expect(
          (yield* http(getRequest("/agent/config", SPB_TOKEN))).status,
        ).toBe(401);
        const again = yield* hub
          .connect(3, hello("spb-1", SPB_TOKEN))
          .pipe(Stream.runDrain, Effect.flip);
        expect(again._tag).toBe("AgentUnauthorized");
      }),
    ));

  it("connection on a token replaced by a new enrollment is kicked", () =>
    run(() =>
      Effect.gen(function* () {
        const db = yield* Db;
        const hub = yield* AgentHub;
        const auth = yield* WorkerAuth;
        yield* seedWorker("spb-1", { token: SPB_TOKEN });
        const events = yield* hub.subscribe;
        yield* hub
          .connect(1, hello("spb-1", SPB_TOKEN))
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* waitEvent(events, "Connected", "spb-1");

        // Админка перевыпустила код, сервер переустановили: старый токен
        // заменён новым.
        yield* db
          .update(workerCredentials)
          .set({
            enrollCodeHash: sha256Hex(CODE),
            enrollExpiresAt: new Date(Date.now() + 3_600_000),
          })
          .where(eq(workerCredentials.workerId, "spb-1"));
        const enrolled = yield* auth.enroll(CODE, new Date());
        expect(Option.isSome(enrolled)).toBe(true);
        expect(yield* auth.workerOfToken(SPB_TOKEN)).toEqual(Option.none());

        yield* TestClock.adjust("10 seconds");
        yield* waitEvent(events, "Disconnected", "spb-1");
        expect(hub.connected().has("spb-1")).toBe(false);
      }),
    ));
});
