// Синхронизация библиотеки Steam, обновление тиров ProtonDB и представление для `library.*`.
import type { Db } from "@cg/db";
import {
  type LibraryEntry,
  type LibraryView,
  ProtonTier,
  type SteamUnavailable,
} from "@cg/rpc";
import { Cause, DateTime, Effect, Schema } from "effect";
import { ProtonDb } from "../steam/ProtonDb";
import { SteamApi } from "../steam/SteamApi";
import * as LibraryRepo from "./LibraryRepo";

/** Вертикальная обложка Steam 600×900 (фолбэк на `header.jpg` — на фронте). */
export const coverUrl = (appId: number) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900_2x.jpg`;

/** Тир ProtonDB перепроверяется не чаще раза в сутки. */
const tierMaxAgeMillis = 24 * 60 * 60 * 1000;
/** Одновременных запросов к ProtonDB. */
const tierConcurrency = 4;

const isProtonTier = Schema.is(ProtonTier);

/**
 * Фоновую работу некому вернуть ошибку: логируем её (кроме прерывания при
 * остановке сервера) и завершаемся успешно. В сообщениях нет ключа Steam:
 * `SteamUnavailable` несёт только `reason`, ошибки БД — SQL и его параметры.
 */
const logFailure =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | void, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError(message, Cause.pretty(cause)),
      ),
    );

/**
 * Синхронизирует библиотеку со Steam. `Private` — профиль скрывает игры: ставится
 * `libraryPrivate`, сохранённая библиотека не меняется. `Synced` — библиотека
 * заменена списком из Steam. Ошибки БД — дефекты.
 */
export const syncLibrary = (
  userId: string,
  steamId: string,
): Effect.Effect<"Private" | "Synced", SteamUnavailable, Db | SteamApi> =>
  Effect.gen(function* () {
    const steam = yield* SteamApi;
    const owned = yield* steam.getOwnedGames(steamId);
    if (owned._tag === "Private") {
      yield* LibraryRepo.markPrivate(userId).pipe(Effect.orDie);
      return "Private" as const;
    }
    const now = yield* DateTime.nowAsDate;
    yield* LibraryRepo.replaceLibrary(userId, owned.games, now).pipe(
      Effect.orDie,
    );
    return "Synced" as const;
  }).pipe(Effect.withSpan("LibraryService.syncLibrary"));

/**
 * Обновляет тиры ProtonDB для игр, тир которых не проверялся или старше 24 ч.
 * До 4 запросов одновременно. Не падает: сбои логируются (сам ProtonDb уже
 * сводит 404/сеть/таймаут к `pending`).
 */
export const refreshTiers = (
  appIds: ReadonlyArray<number>,
): Effect.Effect<void, never, Db | ProtonDb> =>
  Effect.gen(function* () {
    const proton = yield* ProtonDb;
    const now = yield* DateTime.nowAsDate;
    const stale = yield* LibraryRepo.staleTierAppIds(
      appIds,
      new Date(now.getTime() - tierMaxAgeMillis),
    );
    yield* Effect.forEach(
      stale,
      (appId) =>
        Effect.gen(function* () {
          const tier = yield* proton.fetchTier(appId);
          const checkedAt = yield* DateTime.nowAsDate;
          yield* LibraryRepo.setTier(appId, tier, checkedAt);
        }).pipe(
          logFailure("ProtonDB tier update failed"),
          Effect.annotateLogs({ appId }),
        ),
      { concurrency: tierConcurrency, discard: true },
    );
  }).pipe(
    logFailure("ProtonDB tier refresh failed"),
    Effect.withSpan("LibraryService.refreshTiers"),
  );

/** `refreshTiers` для всех игр пользователя (запускается в фоне после синхронизации). */
export const refreshUserTiers = (
  userId: string,
): Effect.Effect<void, never, Db | ProtonDb> =>
  LibraryRepo.ownedAppIds(userId).pipe(
    Effect.flatMap(refreshTiers),
    logFailure("ProtonDB tier refresh failed"),
    Effect.annotateLogs({ userId }),
  );

/** Пора ли синхронизировать до ответа: у Steam-пользователя ещё не было синхронизации. */
export const needsInitialSync = (
  userId: string,
): Effect.Effect<boolean, never, Db> =>
  LibraryRepo.libraryState(userId).pipe(
    Effect.orDie,
    Effect.map(
      (state) => state !== undefined && state.librarySyncedAt === null,
    ),
  );

/** Библиотека пользователя из БД. */
export const libraryView = (
  userId: string,
): Effect.Effect<LibraryView, never, Db> =>
  Effect.gen(function* () {
    const state = yield* LibraryRepo.libraryState(userId);
    if (state?.libraryPrivate) return { _tag: "Private" } as const;
    const rows = yield* LibraryRepo.listEntries(userId);
    const entries = rows.map((row): LibraryEntry => ({
      appId: row.appId,
      name: row.name,
      playtimeMinutes: row.playtimeMinutes,
      protonTier: isProtonTier(row.protonTier) ? row.protonTier : "pending",
      coverUrl: coverUrl(row.appId),
    }));
    return {
      _tag: "Ready",
      entries,
      syncedAt: state?.librarySyncedAt?.toISOString() ?? null,
    } as const;
  }).pipe(Effect.orDie);

/**
 * Фоновая синхронизация при входе: для пользователя со `steamId` — `syncLibrary`,
 * затем `refreshUserTiers`. Не падает: недоступность Steam и прочие сбои логируются.
 */
export const syncOnLogin = (
  userId: string,
): Effect.Effect<void, never, Db | SteamApi | ProtonDb> =>
  Effect.gen(function* () {
    const state = yield* LibraryRepo.libraryState(userId).pipe(Effect.orDie);
    if (!state?.steamId) return;
    const result = yield* syncLibrary(userId, state.steamId);
    if (result === "Synced") yield* refreshUserTiers(userId);
  }).pipe(
    Effect.catchTag("SteamUnavailable", (error) =>
      Effect.logWarning("Steam library sync on login failed", {
        reason: error.reason,
      }),
    ),
    logFailure("Steam library sync on login failed"),
    Effect.annotateLogs({ userId }),
  );
