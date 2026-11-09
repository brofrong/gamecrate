// RemoteConfig: GET /agent/config с главного (задача 3), Bearer WORKER_TOKEN.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Logger, Redacted, References } from "effect";
import { fetchRemoteConfig } from "../src/RemoteConfig";

const token = `cgw_${"a".repeat(43)}`;
const profileKey = Buffer.from(new Uint8Array(32)).toString("base64");

/** Тело успешного ответа `GET /agent/config` (оркестратор, задача 3). */
const okBody = {
  s3: {
    endpoint: "http://cg-rustfs:9000",
    bucket: "cg-profiles",
    accessKey: "access-key-0123456789",
    secretKey: "secret-key-0123456789",
  },
  profileKey,
};

let server: ReturnType<typeof Bun.serve>;
let url: string;
/** Ответы по очереди для следующих запросов; пусто — всегда 200 с `okBody`. */
let responses: Array<Response> = [];
let authorizations: Array<string | undefined> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      authorizations.push(request.headers.get("authorization") ?? undefined);
      const next = responses.shift();
      return next ?? Response.json(okBody);
    },
  });
  url = `http://127.0.0.1:${server.port}/agent/config`;
});

afterAll(() => server.stop(true));

const run = <A, E>(effect: Effect.Effect<A, E>) => {
  responses = [];
  authorizations = [];
  return Effect.runPromise(effect);
};

describe("fetchRemoteConfig", () => {
  it("fetches config with bearer token", () =>
    run(
      Effect.gen(function* () {
        const config = yield* fetchRemoteConfig(url, Redacted.make(token));
        expect(authorizations).toEqual([`Bearer ${token}`]);
        expect(config.s3Endpoint).toBe("http://cg-rustfs:9000");
        expect(config.s3Bucket).toBe("cg-profiles");
        expect(Redacted.value(config.s3AccessKey)).toBe(
          "access-key-0123456789",
        );
        expect(Redacted.value(config.s3SecretKey)).toBe(
          "secret-key-0123456789",
        );
        expect(Redacted.value(config.profileKey)).toBe(profileKey);
      }),
    ));

  it(
    "retries until the orchestrator answers",
    () =>
      run(
        Effect.gen(function* () {
          responses = [
            new Response("service unavailable", { status: 503 }),
            new Response("service unavailable", { status: 503 }),
          ];
          const config = yield* fetchRemoteConfig(url, Redacted.make(token));
          expect(authorizations.length).toBe(3);
          expect(config.s3Endpoint).toBe("http://cg-rustfs:9000");
        }).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
      ),
    15_000,
  );

  it("retries on 401 (token may be re-issued)", () =>
    run(
      Effect.gen(function* () {
        responses = [new Response("unauthorized", { status: 401 })];
        const config = yield* fetchRemoteConfig(url, Redacted.make(token));
        expect(authorizations.length).toBe(2);
        expect(config.s3Endpoint).toBe("http://cg-rustfs:9000");
      }).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
    ));

  it("does not retry a malformed response (bad profileKey)", () =>
    run(
      Effect.gen(function* () {
        responses = [
          Response.json({ ...okBody, profileKey: "not-base64-32-bytes" }),
        ];
        const error = yield* Effect.flip(
          fetchRemoteConfig(url, Redacted.make(token)),
        );
        expect(error._tag).toBe("RemoteConfigInvalid");
        // Один запрос — ни одного повтора неверных данных.
        expect(authorizations.length).toBe(1);
      }).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
    ));

  it("does not log secrets", () => {
    const logged: Array<unknown> = [];
    const capture = Logger.make(({ message }) => {
      logged.push(message);
    });
    return run(
      Effect.gen(function* () {
        responses = [new Response("unavailable", { status: 503 })];
        yield* fetchRemoteConfig(url, Redacted.make(token));
        const text = JSON.stringify(logged);
        expect(text).toContain("Waiting for orchestrator config");
        expect(text).not.toContain("access-key-0123456789");
        expect(text).not.toContain("secret-key-0123456789");
        expect(text).not.toContain(profileKey);
        expect(text).not.toContain(token);
      }).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      ),
    );
  });
});
