// Хендлеры группы `auth.*`.
import { AuthRpcs, CurrentUser } from "@cg/rpc";

export const AuthRpcHandlers = AuthRpcs.toLayer({
  "auth.me": () => CurrentUser,
});
