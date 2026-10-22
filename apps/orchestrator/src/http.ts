// HTTP-роутер оркестратора: /healthz и RPC агентов по WebSocket (/agent).
import { createHash, timingSafeEqual } from "node:crypto";
import { Db } from "@cg/db";
import { AgentNotConnected, AgentRpcs } from "@cg/rpc";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AgentHub } from "./AgentHub";
import { OrchestratorConfig } from "./config";
import * as SessionRepo from "./SessionRepo";

const HealthRoute = HttpRouter.add(
  "GET",
  "/healthz",
  HttpServerResponse.text("ok"),
);

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * Проверка `Authorization: Bearer <AGENT_TOKEN>` за постоянное время: сравниваются
 * SHA-256 обеих строк (одинаковой длины), так что время не зависит ни от
 * совпадающего префикса, ни от длины токена.
 */
export const isAgentAuthorized = (
  authorization: string | undefined,
  agentToken: Redacted.Redacted<string>,
): boolean =>
  timingSafeEqual(
    sha256(authorization ?? ""),
    sha256(`Bearer ${Redacted.value(agentToken)}`),
  );

/**
 * WebSocket-протокол RPC на `GET /agent`: без верного Bearer-токена → 401 до
 * апгрейда. Проверять можно только на апгрейде: заголовки RPC-сообщений
 * контролирует клиент.
 */
const AgentWebsocketProtocol = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const { protocol, httpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    const router = yield* HttpRouter.HttpRouter;
    const { agentToken } = yield* OrchestratorConfig;

    yield* router.add(
      "GET",
      "/agent",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!isAgentAuthorized(request.headers.authorization, agentToken))
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        return yield* httpEffect;
      }),
    );
    return protocol;
  }),
);

/**
 * Хендлеры `agent.*`: делегируют AgentHub, соединение — по id WebSocket-клиента.
 * `agent.profileCommit` — compare-and-set версии в `profiles`
 * (`SessionRepo.commitProfile`); по соединению без `agent.connect` —
 * AgentNotConnected (агент повторит).
 */
export const AgentRpcHandlers = AgentRpcs.toLayer(
  Effect.gen(function* () {
    const hub = yield* AgentHub;
    const db = yield* Db;
    return AgentRpcs.of({
      "agent.connect": (payload, { client }) => hub.connect(client.id, payload),
      "agent.report": (report, { client }) => hub.report(client.id, report),
      "agent.profileCommit": (commit, { client }) =>
        Effect.gen(function* () {
          const workerId = hub.workerOf(client.id);
          if (workerId === undefined) return yield* new AgentNotConnected();
          const result = yield* SessionRepo.commitProfile(commit).pipe(
            Effect.provideService(Db, db),
            Effect.orDie,
          );
          yield* Effect.logInfo("Profile commit", {
            userId: commit.userId,
            baseVersion: commit.baseVersion,
            accepted: result.accepted,
            workerId,
          });
          return result;
        }),
    });
  }),
);

/** Effect RPC агентов по WebSocket на `/agent` (сериализация NDJSON). */
const AgentRpcRoute = RpcServer.layer(AgentRpcs).pipe(
  Layer.provide(AgentWebsocketProtocol),
  Layer.provide(AgentRpcHandlers),
  Layer.provide(RpcSerialization.layerNdjson),
);

/** Всё приложение оркестратора; запускается через `HttpRouter.serve` (main.ts). */
export const HttpApp = Layer.mergeAll(HealthRoute, AgentRpcRoute);
