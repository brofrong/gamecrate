// Хендлер группы `streamSettings.*`: настройки стрима текущего пользователя (спека §4).
import { CurrentUser, StreamSettingsRpcs } from "@cg/rpc";
import { Effect } from "effect";
import { loadStreamSettings, saveStreamSettings } from "./StreamSettingsRepo";

export const StreamSettingsRpcHandlers = StreamSettingsRpcs.toLayer({
  "streamSettings.get": () =>
    Effect.gen(function* () {
      const current = yield* CurrentUser;
      return yield* loadStreamSettings(current.id);
    }),
  "streamSettings.save": (payload) =>
    Effect.gen(function* () {
      const current = yield* CurrentUser;
      return yield* saveStreamSettings(current.id, payload);
    }),
});
