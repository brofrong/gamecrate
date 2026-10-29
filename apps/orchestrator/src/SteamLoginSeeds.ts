// Входы в Steam, посеянные пользователем (Task 5 — QR-раннер): привязаны к
// `userId`, а не к конкретной сессии или задаче установки — Scheduler/
// InstallDispatcher прикладывают их к следующей команде этого пользователя.
// Хранятся в Postgres (`steam_login_seeds`), поэтому переживают перезапуск
// оркестратора. Имя аккаунта и refresh-токен — только зашифрованными
// (AES-256-GCM ключом `SEED_KEY`, `sealed` = base64 `iv ‖ tag ‖ шифротекст`;
// AAD — `userId` и `steamId`, так что строку не переложить другому
// пользователю). Запись живёт `SEED_TTL`; `get` сам удаляет просроченную и
// отдаёт `null`, `put` попутно удаляет просроченные строки всех пользователей.
// Если вход не используется (игрок не запускает игру и не входит заново),
// эти попутные удаления не сработают — именно для этого случая `pruneExpired`
// зовёт ежедневная чистка в `SteamLoginRunner` (спека §4: запись уходит «по
// сроку», а не только при следующем обращении), так что таблица не растёт
// без присмотра даже без активности.
// Никогда не логировать содержимое (`SteamLoginSeed.accountName`/`refreshToken`
// — `Redacted`, но сам факт put/clear/порчи логировать можно только по `userId`).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Db, steamLoginSeeds } from "@cg/db";
import type { SteamLoginSeed } from "@cg/rpc";
import { and, eq, lt, lte, sql } from "drizzle-orm";
import { Clock, Context, Duration, Effect, Layer, Redacted } from "effect";
import { OrchestratorConfig } from "./config";

/** Срок жизни посеянного входа без использования (спека §4). */
export const SEED_TTL = Duration.hours(24);

/** Длина ключа AES-256, IV (96 бит — рекомендация NIST) и тега GCM. */
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface SteamLoginSeedsShape {
  /** Положить (или заменить) вход пользователя; срок — `SEED_TTL` от этого момента. */
  readonly put: (userId: string, seed: SteamLoginSeed) => Effect.Effect<void>;
  /**
   * Вход пользователя, если он есть и не просрочен; иначе `null`. Просроченная
   * или нерасшифровываемая (другой `SEED_KEY`, порча) строка удаляется.
   * `putAt` — момент `put` (ISO, мс): метка, по которой `clear` уберёт
   * именно этот вход.
   */
  readonly get: (userId: string) => Effect.Effect<SteamLoginSeed | null>;
  /**
   * Убрать вход пользователя (принятый посеянный коммит профиля). С `putAt` —
   * только вход, положенный в этот момент (до мс, как отдал `get`): вход,
   * положенный заново, пока шла сессия, остаётся. Без `putAt` (агент без
   * метки) — любой. Возвращает, убрана ли строка.
   */
  readonly clear: (userId: string, putAt?: Date) => Effect.Effect<boolean>;
  /**
   * Убрать вход пользователя, положенный раньше `at` (админ сбросил вход Steam
   * в момент `at`, `user.steam_login_reset_at`); положенный в `at` или позже —
   * остаётся: пользователь вошёл заново уже после сброса.
   */
  readonly clearOlderThan: (userId: string, at: Date) => Effect.Effect<void>;
  /**
   * Удалить просроченные строки всех пользователей на момент `at` — независимо
   * от того, случится ли ещё чей-то `get`/`put`. Возвращает число удалённых
   * строк. Зовётся ежедневной чисткой `SteamLoginRunner` рядом с
   * `pruneFinished` (спека §4).
   */
  readonly pruneExpired: (at: Date) => Effect.Effect<number>;
}

/** Секретная часть входа, которая шифруется. */
interface Secret {
  readonly accountName: string;
  readonly refreshToken: string;
}

/** Привязка шифротекста к строке: без совпадения `userId`/`steamId` не расшифруется. */
const aadOf = (userId: string, steamId: string) =>
  Buffer.from(JSON.stringify([userId, steamId]), "utf8");

const seal = (
  key: Buffer,
  userId: string,
  steamId: string,
  secret: Secret,
): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(aadOf(userId, steamId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secret), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
};

/** Расшифровать `sealed`; другой ключ, чужая строка или порча — `null`. */
const open = (
  key: Buffer,
  userId: string,
  steamId: string,
  sealed: string,
): Secret | null => {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length <= IV_LENGTH + TAG_LENGTH) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      raw.subarray(0, IV_LENGTH),
      { authTagLength: TAG_LENGTH },
    );
    decipher.setAAD(aadOf(userId, steamId));
    decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)),
      decipher.final(),
    ]).toString("utf8");
    const value: unknown = JSON.parse(plaintext);
    if (
      typeof value === "object" &&
      value !== null &&
      "accountName" in value &&
      typeof value.accountName === "string" &&
      "refreshToken" in value &&
      typeof value.refreshToken === "string"
    )
      return {
        accountName: value.accountName,
        refreshToken: value.refreshToken,
      };
    return null;
  } catch {
    return null;
  }
};

const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

const make = (seedKey: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const key = Buffer.from(Redacted.value(seedKey), "base64");
    // Конфиг уже проверил формат; здесь — на случай прямого вызова layerWith.
    if (key.length !== KEY_LENGTH)
      return yield* Effect.die(
        new Error(`SEED_KEY: ожидается ${KEY_LENGTH} байт`),
      );

    const put: SteamLoginSeedsShape["put"] = (userId, seed) =>
      Effect.gen(function* () {
        const putAt = yield* now;
        const expiresAt = new Date(
          putAt.getTime() + Duration.toMillis(SEED_TTL),
        );
        const sealed = seal(key, userId, seed.steamId, {
          accountName: Redacted.value(seed.accountName),
          refreshToken: Redacted.value(seed.refreshToken),
        });
        yield* db
          .delete(steamLoginSeeds)
          .where(lte(steamLoginSeeds.expiresAt, putAt));
        yield* db
          .insert(steamLoginSeeds)
          .values({ userId, steamId: seed.steamId, sealed, putAt, expiresAt })
          .onConflictDoUpdate({
            target: steamLoginSeeds.userId,
            set: { steamId: seed.steamId, sealed, putAt, expiresAt },
          });
      }).pipe(Effect.orDie);

    const get: SteamLoginSeedsShape["get"] = (userId) =>
      Effect.gen(function* () {
        const at = yield* now;
        const [row] = yield* db
          .select()
          .from(steamLoginSeeds)
          .where(eq(steamLoginSeeds.userId, userId));
        if (row === undefined) return null;
        if (at.getTime() >= row.expiresAt.getTime()) {
          yield* db
            .delete(steamLoginSeeds)
            .where(
              and(
                eq(steamLoginSeeds.userId, userId),
                lte(steamLoginSeeds.expiresAt, at),
              ),
            );
          return null;
        }
        const secret = open(key, userId, row.steamId, row.sealed);
        if (secret === null) {
          yield* Effect.logWarning(
            "Steam login seed cannot be decrypted, dropped",
            { userId },
          );
          // Только эту строку: вход, посеянный заново тем временем, остаётся.
          yield* db
            .delete(steamLoginSeeds)
            .where(
              and(
                eq(steamLoginSeeds.userId, userId),
                eq(steamLoginSeeds.sealed, row.sealed),
              ),
            );
          return null;
        }
        return {
          accountName: Redacted.make(secret.accountName),
          steamId: row.steamId,
          refreshToken: Redacted.make(secret.refreshToken),
          putAt: row.putAt.toISOString(),
        } satisfies SteamLoginSeed;
      }).pipe(Effect.orDie);

    const clear: SteamLoginSeedsShape["clear"] = (userId, putAt) =>
      db
        .delete(steamLoginSeeds)
        .where(
          and(
            eq(steamLoginSeeds.userId, userId),
            // Postgres хранит микросекунды, метка `get` — миллисекунды.
            putAt === undefined
              ? undefined
              : sql`date_trunc('milliseconds', ${steamLoginSeeds.putAt}) = ${putAt}`,
          ),
        )
        .returning({ userId: steamLoginSeeds.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        );

    const clearOlderThan: SteamLoginSeedsShape["clearOlderThan"] = (
      userId,
      at,
    ) =>
      db
        .delete(steamLoginSeeds)
        .where(
          and(
            eq(steamLoginSeeds.userId, userId),
            lt(steamLoginSeeds.putAt, at),
          ),
        )
        .pipe(Effect.asVoid, Effect.orDie);

    const pruneExpired: SteamLoginSeedsShape["pruneExpired"] = (at) =>
      db
        .delete(steamLoginSeeds)
        .where(lte(steamLoginSeeds.expiresAt, at))
        .returning({ userId: steamLoginSeeds.userId })
        .pipe(
          Effect.map((rows) => rows.length),
          Effect.orDie,
        );

    return {
      put,
      get,
      clear,
      clearOlderThan,
      pruneExpired,
    } satisfies SteamLoginSeedsShape;
  });

export class SteamLoginSeeds extends Context.Service<
  SteamLoginSeeds,
  SteamLoginSeedsShape
>()("@cg/orchestrator/SteamLoginSeeds") {
  /** Посевы в БД, ключ — данный `SEED_KEY` (base64 ровно 32 байт). */
  static readonly layerWith = (
    seedKey: Redacted.Redacted<string>,
  ): Layer.Layer<SteamLoginSeeds, never, Db> =>
    Layer.effect(SteamLoginSeeds, make(seedKey));

  /** Боевой слой: ключ — `OrchestratorConfig.seedKey` (`SEED_KEY`). */
  static readonly layer: Layer.Layer<
    SteamLoginSeeds,
    never,
    Db | OrchestratorConfig
  > = Layer.unwrap(
    OrchestratorConfig.useSync((config) =>
      SteamLoginSeeds.layerWith(config.seedKey),
    ),
  );
}
