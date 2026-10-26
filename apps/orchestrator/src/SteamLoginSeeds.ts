// Входы в Steam, посеянные пользователем (Task 5 — QR-раннер), в памяти
// процесса оркестратора: привязаны к `userId`, а не к конкретной сессии или
// задаче установки — Scheduler/InstallDispatcher прикладывают их к следующей
// команде этого пользователя. Запись живёт `SEED_TTL`; `get` сам удаляет
// просроченную и отдаёт `null`, так что состояние не растёт без присмотра.
// Никогда не логировать содержимое (`SteamLoginSeed.accountName`/`refreshToken`
// — `Redacted`, но сам факт put/clear логировать можно только по `userId`).
import type { SteamLoginSeed } from "@cg/rpc";
import { Clock, Context, Duration, Effect, Layer } from "effect";

/** Срок жизни посеянного входа без использования (спека §4). */
export const SEED_TTL = Duration.hours(24);

export interface SteamLoginSeedsShape {
  /** Положить (или заменить) вход пользователя; срок — `SEED_TTL` от этого момента. */
  readonly put: (userId: string, seed: SteamLoginSeed) => Effect.Effect<void>;
  /** Вход пользователя, если он есть и не просрочен; иначе `null`. */
  readonly get: (userId: string) => Effect.Effect<SteamLoginSeed | null>;
  /** Убрать вход пользователя (принятый посеянный коммит профиля). */
  readonly clear: (userId: string) => Effect.Effect<void>;
}

const make = Effect.sync(() => {
  const entries = new Map<
    string,
    { seed: SteamLoginSeed; expiresAt: number }
  >();

  const put: SteamLoginSeedsShape["put"] = (userId, seed) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      entries.set(userId, {
        seed,
        expiresAt: now + Duration.toMillis(SEED_TTL),
      });
    });

  const get: SteamLoginSeedsShape["get"] = (userId) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const entry = entries.get(userId);
      if (entry === undefined) return null;
      if (now >= entry.expiresAt) {
        entries.delete(userId);
        return null;
      }
      return entry.seed;
    });

  const clear: SteamLoginSeedsShape["clear"] = (userId) =>
    Effect.sync(() => {
      entries.delete(userId);
    });

  return { put, get, clear } satisfies SteamLoginSeedsShape;
});

export class SteamLoginSeeds extends Context.Service<
  SteamLoginSeeds,
  SteamLoginSeedsShape
>()("@cg/orchestrator/SteamLoginSeeds") {
  static readonly layer: Layer.Layer<SteamLoginSeeds> = Layer.effect(
    SteamLoginSeeds,
    make,
  );
}
