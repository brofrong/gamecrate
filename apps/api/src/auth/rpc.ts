// Хендлеры группы `auth.*` (приватные) и публичного `auth.providers`.
import { AuthRpcs, CurrentUser, PublicAuthRpcs } from "@cg/rpc";
import { Effect } from "effect";
import { AppConfig } from "../config";
import { authProviders } from "./providers";

export const AuthRpcHandlers = AuthRpcs.toLayer({
  "auth.me": () => CurrentUser,
});

export const PublicAuthRpcHandlers = PublicAuthRpcs.toLayer(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return PublicAuthRpcs.of({
      "auth.providers": () => Effect.succeed(authProviders(config)),
    });
  }),
);
