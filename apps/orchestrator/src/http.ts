// HTTP-роутер оркестратора: /healthz и RPC агентов по WebSocket (/agent).
import { createHash, timingSafeEqual } from "node:crypto";
import { Db } from "@cg/db";
import { AgentNotConnected, AgentRpcs, type ProfileCommit } from "@cg/rpc";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AgentHub } from "./AgentHub";
import { OrchestratorConfig } from "./config";
import * as SessionRepo from "./SessionRepo";
import { SteamLoginSeeds } from "./SteamLoginSeeds";

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
 * Коммит профиля (`SessionRepo.commitProfile`), затем — если его как раз
 * приняли и он был посеян (`steamLoginSeeded`) — `SteamLoginSeeds.clear`:
 * профиль пользователя уже хранит вход, сеять его снова незачем. С меткой
 * `steamLoginPutAt` снимается только посеянный вход: положенный игроком
 * заново, пока шла сессия, ждёт следующего запуска. Отклонённый
 * (устаревшая `baseVersion`) или не посеянный коммит вход не трогает — он
 * ждёт следующую попытку или истечёт по `SEED_TTL`. Принятый коммит с эхом
 * `steamLoginResetAt` (агент стёр вход Steam по сбросу админа) снимает пометку
 * сброса, если она не новее эха (`SessionRepo.clearSteamLoginReset`): новый
 * сброс, сделанный во время сессии, ждёт следующего запуска. Итог — в лог
 * (только флаги, без самого входа); `workerId` — агент, приславший коммит.
 * Коммит уже принят, когда снимается пометка: сбой самого снятия (DB-сбой)
 * не должен превращать принятый коммит в сбой для агента — он только
 * логируется предупреждением (M2), а пометка остаётся и снимется следующим
 * коммитом с тем же или более поздним эхом (`clearSteamLoginReset` всё равно
 * её захватит).
 */
export const applyProfileCommit = (commit: ProfileCommit, workerId: string) =>
  Effect.gen(function* () {
    const seeds = yield* SteamLoginSeeds;
    const result = yield* SessionRepo.commitProfile(commit);
    // Метка посева — та же ISO-строка, что ушла в `steamLogin.putAt` команды;
    // нечитаемая не снимает вход (он истечёт по `SEED_TTL`), но стоит знать,
    // что такое пришло — предупреждение ниже, только id.
    const seedPutAt =
      commit.steamLoginPutAt === undefined || commit.steamLoginPutAt === null
        ? undefined
        : new Date(commit.steamLoginPutAt);
    const seedPutAtUnreadable =
      seedPutAt !== undefined && Number.isNaN(seedPutAt.getTime());
    if (result.accepted && commit.steamLoginSeeded && seedPutAtUnreadable)
      yield* Effect.logWarning(
        "Profile commit has an unreadable Steam login seed label",
        { userId: commit.userId, workerId },
      );
    const seedCleared =
      result.accepted && commit.steamLoginSeeded && !seedPutAtUnreadable
        ? yield* seeds.clear(commit.userId, seedPutAt)
        : false;
    // Эхо — та же ISO-строка, что ушла в команде; нечитаемое не снимает пометку.
    const resetEcho =
      commit.steamLoginResetAt === undefined
        ? undefined
        : new Date(commit.steamLoginResetAt);
    const steamLoginResetCleared =
      result.accepted &&
      resetEcho !== undefined &&
      !Number.isNaN(resetEcho.getTime())
        ? yield* SessionRepo.clearSteamLoginReset(
            commit.userId,
            resetEcho,
          ).pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning(
                "Clearing Steam login reset mark failed, commit stays accepted",
                {
                  userId: commit.userId,
                  workerId,
                  error:
                    defect instanceof Error ? defect.message : String(defect),
                },
              ).pipe(Effect.as(false)),
            ),
          )
        : false;
    yield* Effect.logInfo("Profile commit", {
      userId: commit.userId,
      baseVersion: commit.baseVersion,
      accepted: result.accepted,
      steamLoginSeeded: commit.steamLoginSeeded,
      seedCleared,
      steamLoginResetCleared,
      workerId,
    });
    return result;
  });

/**
 * Хендлеры `agent.*`: делегируют AgentHub, соединение — по id WebSocket-клиента.
 * `agent.profileCommit` — `applyProfileCommit`; по соединению без
 * `agent.connect` — AgentNotConnected (агент повторит).
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
          return yield* applyProfileCommit(commit, workerId).pipe(
            Effect.provideService(Db, db),
            Effect.orDie,
          );
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
