// HTTP-роутер: /healthz, Better Auth (/api/auth/*), Effect RPC по WebSocket (/rpc),
// прокси стрима (/stream/<id>/*), раздача десктоп-сборок (/download/desktop/*),
// статика SPA (`index.html` по витрине хоста, brand/route.ts).
import { AppRpcs } from "@cg/rpc";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AccountRpcHandlers } from "./account/rpc";
import { AdminRpcHandlers } from "./admin/rpc";
import { BetterAuth } from "./auth/auth";
import { RpcMiddlewares } from "./auth/currentUser";
import { AuthRpcHandlers, PublicAuthRpcHandlers } from "./auth/rpc";
import { BrandedStaticRoute } from "./brand/route";
import { AppConfig, rpcAllowedOrigins } from "./config";
import { DesktopReleases } from "./download/DesktopReleases";
import { DesktopRoutes, DesktopUpload } from "./download/routes";
import { LibraryRpcHandlers } from "./library/rpc";
import { SessionEvents } from "./session/SessionEvents";
import { SessionRpcHandlers } from "./session/rpc";
import { StreamProxyRoute } from "./session/streamProxy";
import { SteamLoginRpcHandlers } from "./steamLogin/rpc";
import { StreamSettingsRpcHandlers } from "./streamSettings/rpc";
import { TimeRpcHandlers } from "./time/rpc";

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
  PublicAuthRpcHandlers,
  AccountRpcHandlers,
  AdminRpcHandlers,
  LibraryRpcHandlers,
  SessionRpcHandlers.pipe(Layer.provide(SessionEvents.layer)),
  TimeRpcHandlers,
  SteamLoginRpcHandlers,
  StreamSettingsRpcHandlers,
  RpcMiddlewares,
);

export { rpcAllowedOrigins } from "./config";

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

/**
 * Раздача десктоп-сборок `/download/desktop/*` — публично; выкладка (`PUT`) — по
 * `DESKTOP_UPLOAD_TOKEN`. Хранилище и токен берёт из окружения само (`DESKTOP_S3_*`, без ключей —
 * 404), поэтому в `HttpApp` они не входят зависимостью и остальным тестам/деплоям ничего нового
 * не нужно.
 */
const DesktopDownloadRoute = DesktopRoutes.pipe(
  Layer.provide(DesktopReleases.layer),
  Layer.provide(DesktopUpload.layer),
);

/** Всё приложение; запускается через `HttpRouter.serve` (main.ts) или `toWebHandler` (тесты). */
export const HttpApp = Layer.mergeAll(
  HealthRoute,
  AuthRoute,
  RpcRoute,
  StreamProxyRoute,
  DesktopDownloadRoute,
  BrandedStaticRoute,
);
