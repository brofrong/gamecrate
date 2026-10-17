// HTTP-роутер: /healthz, Better Auth (/api/auth/*), Effect RPC по WebSocket (/rpc), статика SPA.
import { AppRpcs } from "@cg/rpc";
import { Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AdminRpcHandlers } from "./admin/rpc";
import { BetterAuth } from "./auth/auth";
import { RpcMiddlewares } from "./auth/currentUser";
import { AuthRpcHandlers } from "./auth/rpc";
import { AppConfig, type AppConfigValues } from "./config";
import { LibraryRpcHandlers } from "./library/rpc";

const HealthRoute = HttpRouter.add(
  "GET",
  "/healthz",
  HttpServerResponse.text("ok"),
);

/** Все запросы `/api/auth/*` (GET и POST) обрабатывает Better Auth. */
const AuthRoute = HttpRouter.use((router) =>
  BetterAuth.use((auth) =>
    router.add("*", "/api/auth/*", (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap((webRequest) =>
          Effect.promise(() => auth.handler(webRequest)),
        ),
        Effect.map(HttpServerResponse.fromWeb),
        Effect.orDie,
      ),
    ),
  ),
);

/** Хендлеры всех RPC-групп `AppRpcs` и мидлвары. Новая группа: добавить её хендлеры сюда. */
export const RpcHandlers = Layer.mergeAll(
  AuthRpcHandlers,
  AdminRpcHandlers,
  LibraryRpcHandlers,
  RpcMiddlewares,
);

/** Origin, которым разрешён WebSocket `/rpc`: origin `PUBLIC_URL` + `ALLOWED_ORIGINS`. */
export const rpcAllowedOrigins = (
  config: AppConfigValues,
): ReadonlySet<string> =>
  new Set([new URL(config.publicUrl).origin, ...config.allowedOrigins]);

/**
 * WebSocket-протокол RPC на `GET /rpc` с проверкой Origin на HTTP-апгрейде.
 *
 * Защита от cross-site WebSocket hijacking: cookie сессии SameSite=Lax уходит и с
 * соседних поддоменов (*.brofrong.ru — тот же site), поэтому чужой Origin (или его
 * отсутствие) → 403 до апгрейда. Проверять можно только здесь: заголовки RPC-сообщений
 * контролирует клиент — RpcServer склеивает `upgradeHeaders.concat(message.headers)`,
 * и клиент может подменить любой заголовок в каждом сообщении, так что AuthMiddleware
 * не может доверять Origin.
 */
const RpcWebsocketProtocol = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const { protocol, httpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    const router = yield* HttpRouter.HttpRouter;
    const allowedOrigins = rpcAllowedOrigins(yield* AppConfig);

    yield* router.add(
      "GET",
      "/rpc",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const origin = request.headers.origin;
        if (origin === undefined || !allowedOrigins.has(origin))
          return HttpServerResponse.text("Forbidden origin", { status: 403 });
        return yield* httpEffect;
      }),
    );
    return protocol;
  }),
);

/** Effect RPC по WebSocket на `/rpc` (сериализация NDJSON). */
const RpcRoute = RpcServer.layer(AppRpcs).pipe(
  Layer.provide(RpcWebsocketProtocol),
  Layer.provide(RpcHandlers),
  Layer.provide(RpcSerialization.layerNdjson),
);

/** Остальные GET — файлы из `webDistDir`; неизвестные страницы → `index.html` (SPA). */
const StaticRoute = Layer.unwrap(
  AppConfig.useSync((config) =>
    HttpStaticServer.layer({ root: config.webDistDir, spa: true }),
  ),
);

/** Всё приложение; запускается через `HttpRouter.serve` (main.ts) или `toWebHandler` (тесты). */
export const HttpApp = Layer.mergeAll(
  HealthRoute,
  AuthRoute,
  RpcRoute,
  StaticRoute,
);
