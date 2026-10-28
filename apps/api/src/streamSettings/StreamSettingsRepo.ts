// Настройки стрима пользователя (таблица `user_stream_settings`, спека §4): чтение
// (с откатом на умолчания по полю, `decodeStreamSettings`) и upsert.
import { Db, userStreamSettings } from "@cg/db";
import {
  decodeStreamSettings,
  defaultStreamSettings,
  type StreamSettings,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

/**
 * Настройки стрима пользователя. Записи нет — значения по умолчанию; битая запись —
 * умолчания по отдельным полям (`decodeStreamSettings`). Ошибки БД — дефекты.
 */
export const loadStreamSettings = (
  userId: string,
): Effect.Effect<StreamSettings, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ value: userStreamSettings.value })
      .from(userStreamSettings)
      .where(eq(userStreamSettings.userId, userId))
      .pipe(Effect.orDie);
    if (row === undefined) return defaultStreamSettings;
    return decodeStreamSettings(row.value);
  });

/** Сохраняет настройки (значение уже проверено схемой RPC) и возвращает их. */
export const saveStreamSettings = (
  userId: string,
  value: StreamSettings,
): Effect.Effect<StreamSettings, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Ровно поля схемы: лишние ключи payload в БД не попадают.
    const stored: StreamSettings = {
      quality: value.quality,
      bitrateMbps: value.bitrateMbps,
      resolution: value.resolution,
      debug: value.debug,
      menuSeen: value.menuSeen,
    };
    yield* db
      .insert(userStreamSettings)
      .values({ userId, value: stored })
      .onConflictDoUpdate({
        target: userStreamSettings.userId,
        set: { value: stored, updatedAt: new Date() },
      })
      .pipe(Effect.orDie);
    return stored;
  });
