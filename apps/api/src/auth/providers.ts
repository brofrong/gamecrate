// Доступные способы входа (для публичного `auth.providers`) из конфигурации сервера.
import type { AuthProviders } from "@cg/rpc";
import { Option } from "effect";
import type { AppConfigValues } from "../config";

/** Pocket ID настроен всегда (его переменные окружения обязательны, см. `config.ts`). */
export const authProviders = (config: AppConfigValues): AuthProviders => ({
  google: Option.isSome(config.google),
  yandex: Option.isSome(config.yandex),
  pocketId: true,
  telegram: Option.isSome(config.telegram),
});
