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
import { AppConfig } from "./config";

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
  RpcMiddlewares,
);

/** Effect RPC по WebSocket на `/rpc` (сериализация NDJSON). */
const RpcRoute = RpcServer.layerHttp({
  group: AppRpcs,
  path: "/rpc",
  protocol: "websocket",
}).pipe(
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
