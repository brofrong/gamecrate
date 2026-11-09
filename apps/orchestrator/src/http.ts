// HTTP-роутер оркестратора: /healthz, RPC агентов по WebSocket (/agent), обмен
// кода подключения (/agent/enroll), конфиг агента (/agent/config) и каналы
// тоннеля стрима (/agent/tunnel/:tunnelId, `Tunnels.ts`). Relay для api — не
// здесь, а на своём внутреннем порту (`relay.ts`).
import { Db } from "@cg/db";
import { AgentNotConnected, AgentRpcs, type ProfileCommit } from "@cg/rpc";
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AgentHub } from "./AgentHub";
import { agentWebsocketUrl, OrchestratorConfig } from "./config";
import * as SessionRepo from "./SessionRepo";
import { SteamLoginSeeds } from "./SteamLoginSeeds";
import { TunnelRoute } from "./Tunnels";
import { bearerToken, WorkerAuth, type WorkerAuthShape } from "./WorkerAuth";

const HealthRoute = HttpRouter.add(
  "GET",
  "/healthz",
  HttpServerResponse.text("ok"),
);

const unauthorized = () =>
  HttpServerResponse.text("Unauthorized", { status: 401 });

/** Ответ с секретами: ни прокси, ни клиент его не кэшируют. */
const secretJson = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

/** Сервер по `Authorization: Bearer <токен сервера>`; нет или не действует — `None`. */
const workerOfRequest = (
  auth: WorkerAuthShape,
  request: HttpServerRequest.HttpServerRequest,
) => {
  const token = bearerToken(request.headers.authorization);
  return token === undefined
    ? Effect.succeed(Option.none<string>())
    : auth.workerOfToken(token);
};

/**
 * WebSocket-протокол RPC на `GET /agent`: без действующего токена сервера в
 * `Authorization: Bearer` → 401 до апгрейда. Какому серверу принадлежит
 * соединение, решает токен внутри `agent.connect` (сверка с `workerId` в
 * хабе): заголовки RPC-сообщений контролирует клиент.
 */
const AgentWebsocketProtocol = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const { protocol, httpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    const router = yield* HttpRouter.HttpRouter;
    const auth = yield* WorkerAuth;

    yield* router.add(
      "GET",
      "/agent",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Option.isNone(yield* workerOfRequest(auth, request)))
          return unauthorized();
        return yield* httpEffect;
      }),
    );
    return protocol;
  }),
);

const EnrollRequest = Schema.Struct({ code: Schema.String });

/**
 * HTTP-маршруты агента вне RPC:
 * - `POST /agent/enroll` `{ code }` — скрипт установки меняет одноразовый
 *   код на постоянный токен сервера (`WorkerAuth.enroll`) и получает всё,
 *   что нужно для первого запуска: адрес WebSocket оркестратора, версию
 *   релиза и учётные данные реестра (только на чтение; `null` — реестр не
 *   задан). Код не подошёл, истёк или тело не то — 403.
 * - `GET /agent/config` с Bearer-токеном сервера — S3 профилей и
 *   `PROFILE_KEY` (спека §3 «Конфиг с главного»: секреты лежат только на
 *   главном); без действующего токена — 401.
 */
const AgentHttpRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const auth = yield* WorkerAuth;
    const config = yield* OrchestratorConfig;

    yield* router.add(
      "POST",
      "/agent/enroll",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(
          EnrollRequest,
        ).pipe(Effect.option);
        const enrolled = Option.isNone(body)
          ? Option.none()
          : yield* auth.enroll(body.value.code, yield* DateTime.nowAsDate);
        if (Option.isNone(enrolled))
          return secretJson({ error: "Код недействителен или истёк" }, 403);
        const { workerId, token, regionCode } = enrolled.value;
        yield* Effect.logInfo("Worker enrolled", { workerId, regionCode });
        return secretJson({
          workerId,
          token,
          regionCode,
          orchestratorUrl: agentWebsocketUrl(config.publicUrl),
          version: config.cgVersion,
          registry: Option.match(config.registry, {
            onNone: () => null,
            onSome: ({ server, username, password }) => ({
              server,
              username,
              password: Redacted.value(password),
            }),
          }),
        });
      }),
    );

    yield* router.add(
      "GET",
      "/agent/config",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Option.isNone(yield* workerOfRequest(auth, request)))
          return unauthorized();
        return secretJson({
          s3: {
            endpoint: config.s3PublicEndpoint,
            bucket: config.s3Bucket,
            accessKey: Redacted.value(config.s3AccessKey),
            secretKey: Redacted.value(config.s3SecretKey),
          },
          profileKey: Redacted.value(config.profileKey),
        });
      }),
    );
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
export const HttpApp = Layer.mergeAll(
  HealthRoute,
  AgentHttpRoutes,
  AgentRpcRoute,
  TunnelRoute,
);
