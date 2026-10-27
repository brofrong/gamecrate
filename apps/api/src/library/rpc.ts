// Хендлеры группы `library.*`: библиотека текущего пользователя.
import type { Db } from "@cg/db";
import { CurrentUser, LibraryRpcs } from "@cg/rpc";
import { DateTime, Effect, FiberSet } from "effect";
import type { ProtonDb } from "../steam/ProtonDb";
import { gameView } from "./GameService";
import {
  libraryView,
  needsInitialSync,
  refreshUserTiers,
  syncLibrary,
} from "./LibraryService";
import { recentGames } from "./RecentRepo";
import { trending } from "./TrendingRepo";

export const LibraryRpcHandlers = LibraryRpcs.toLayer(
  Effect.gen(function* () {
    // Фоновые задачи живут в scope слоя (весь срок работы сервера), а не запроса:
    // ответ RPC их не ждёт, при остановке сервера они прерываются.
    const runFork = yield* FiberSet.makeRuntime<Db | ProtonDb>();

    /** Синхронизация со Steam; после успешной — тиры ProtonDB в фоне. */
    const sync = (userId: string, steamId: string) =>
      syncLibrary(userId, steamId).pipe(
        Effect.tap((result) =>
          result === "Synced"
            ? Effect.sync(() => runFork(refreshUserTiers(userId)))
            : Effect.void,
        ),
      );

    return LibraryRpcs.of({
      // Только из БД; при первом обращении Steam-пользователя — сначала синхронизация.
      // Steam недоступен — отдаём то, что есть в БД.
      "library.list": () =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          if (current.steamId !== null && (yield* needsInitialSync(current.id)))
            yield* sync(current.id, current.steamId).pipe(
              Effect.catchTag("SteamUnavailable", (error) =>
                Effect.logWarning("Initial Steam library sync failed", {
                  userId: current.id,
                  reason: error.reason,
                }),
              ),
            );
          return yield* libraryView(current.id);
        }),
      // Steam недоступен — `SteamUnavailable`, сохранённая библиотека не меняется.
      "library.refresh": () =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          if (current.steamId !== null)
            yield* sync(current.id, current.steamId);
          return yield* libraryView(current.id);
        }),
      // Блок «Недавние» для главной /app.
      "library.recent": () =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          return yield* recentGames(current.id);
        }),
      // Блок «В тренде» для главной /app.
      "library.trending": () =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          return yield* trending(current.id, new Date());
        }),
      // Страница игры /app/game/<appId>.
      "library.game": ({ appId }) =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          const now = yield* DateTime.nowAsDate;
          return yield* gameView(current.id, current.steamId, appId, now);
        }),
    });
  }),
);
