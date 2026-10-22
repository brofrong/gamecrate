// Авторизация RPC: ошибки, текущий пользователь, мидлвары и группа `auth.*`.
import { Context, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

/** Нет сессии Better Auth (не вошёл или сессия истекла). */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
) {}

/** Сессия есть, но роли не хватает (например, игрок вызывает `admin.*`). */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {},
) {}

export const Role = Schema.Literals(["player", "admin"]);
export type Role = typeof Role.Type;

/** Пользователь текущей сессии — то, что отдаёт `auth.me`. */
export const CurrentUserShape = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
  role: Role,
  /** SteamID64; у пользователей Pocket ID — null. */
  steamId: Schema.NullOr(Schema.String),
  /** Настоящий email пользователя; null — только синтетический (Steam/Telegram) или нет. */
  email: Schema.NullOr(Schema.String),
  emailVerified: Schema.Boolean,
});
export type CurrentUserShape = typeof CurrentUserShape.Type;

/** Пользователь текущей сессии в хендлерах RPC (его кладёт `AuthMiddleware`). */
export class CurrentUser extends Context.Service<
  CurrentUser,
  CurrentUserShape
>()("@cg/rpc/CurrentUser") {}

/** Требует сессию Better Auth (cookie запроса апгрейда WebSocket), даёт `CurrentUser`. */
export class AuthMiddleware extends RpcMiddleware.Service<
  AuthMiddleware,
  { provides: CurrentUser }
>()("@cg/rpc/AuthMiddleware", { error: Unauthorized }) {}

/** Пропускает только `role: "admin"`. Нужен `CurrentUser`, поэтому добавляется до `AuthMiddleware`. */
export class AdminMiddleware extends RpcMiddleware.Service<
  AdminMiddleware,
  { requires: CurrentUser }
>()("@cg/rpc/AdminMiddleware", { error: Forbidden }) {}

export const AuthRpcs = RpcGroup.make(
  Rpc.make("auth.me", { success: CurrentUserShape }),
).middleware(AuthMiddleware);

/** Какие способы входа включены на сервере — для страницы логина (до сессии). */
export const AuthProviders = Schema.Struct({
  google: Schema.Boolean,
  yandex: Schema.Boolean,
  pocketId: Schema.Boolean,
  telegram: Schema.NullOr(
    Schema.Struct({ botId: Schema.String, botUsername: Schema.String }),
  ),
});
export type AuthProviders = typeof AuthProviders.Type;

/** Публичная группа `auth.*`: без мидлваров, доступна без сессии. */
export const PublicAuthRpcs = RpcGroup.make(
  Rpc.make("auth.providers", { success: AuthProviders }),
);
