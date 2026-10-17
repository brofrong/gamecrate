// Текущий пользователь RPC и реализации мидлваров AuthMiddleware / AdminMiddleware.
import {
  AdminMiddleware,
  AuthMiddleware,
  CurrentUser,
  Forbidden,
  Unauthorized,
} from "@cg/rpc";
import { Effect, Layer, Option } from "effect";
import { BetterAuth } from "./auth";

export { CurrentUser, type CurrentUserShape } from "@cg/rpc";

/**
 * Сессия Better Auth по заголовкам RPC-запроса. По WebSocket это заголовки
 * запроса апгрейда (в т. ч. cookie), их RpcServer добавляет к каждому сообщению.
 */
export const AuthMiddlewareLive: Layer.Layer<
  AuthMiddleware,
  never,
  BetterAuth
> = Layer.effect(
  AuthMiddleware,
  BetterAuth.useSync((auth) =>
    AuthMiddleware.of((effect, { headers }) =>
      auth.currentUser(headers).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Unauthorized()),
            onSome: (user) => Effect.provideService(effect, CurrentUser, user),
          }),
        ),
      ),
    ),
  ),
);

/** Роль не admin → Forbidden. */
export const AdminMiddlewareLive: Layer.Layer<AdminMiddleware> = Layer.succeed(
  AdminMiddleware,
  AdminMiddleware.of((effect) =>
    CurrentUser.use((user) =>
      user.role === "admin" ? effect : Effect.fail(new Forbidden()),
    ),
  ),
);

/** Все RPC-мидлвары приложения. */
export const RpcMiddlewares: Layer.Layer<
  AuthMiddleware | AdminMiddleware,
  never,
  BetterAuth
> = Layer.mergeAll(AuthMiddlewareLive, AdminMiddlewareLive);
