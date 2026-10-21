// Настройки сессий в таблице `settings` под ключом `"session"`: чтение (с
// откатом на значения по умолчанию) и запись. Оркестратор читает их же на лету.
import { Db, settings } from "@cg/db";
import {
  defaultSessionSettings,
  SessionSettings,
  sessionSettingsKey,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

const decodeSettings = Schema.decodeUnknownEffect(SessionSettings);

/**
 * Настройки сессий. Записи нет — значения по умолчанию; запись не проходит
 * схему — тоже по умолчанию, с предупреждением в логе. Ошибки БД — дефекты.
 */
export const loadSessionSettings: Effect.Effect<SessionSettings, never, Db> =
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, sessionSettingsKey))
      .pipe(Effect.orDie);
    if (row === undefined) return defaultSessionSettings;
    return yield* decodeSettings(row.value).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            "Stored session settings are invalid, using defaults",
            String(error),
          ),
          defaultSessionSettings,
        ),
      ),
    );
  });

/** Сохраняет настройки (значение уже проверено схемой RPC) и возвращает их. */
export const saveSessionSettings = (
  value: SessionSettings,
): Effect.Effect<SessionSettings, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Ровно поля схемы: лишние ключи payload в БД не попадают.
    const stored: SessionSettings = {
      idleWarningMinutes: value.idleWarningMinutes,
      idleGraceMinutes: value.idleGraceMinutes,
      disconnectGraceMinutes: value.disconnectGraceMinutes,
      startTimeoutMinutes: value.startTimeoutMinutes,
    };
    yield* db
      .insert(settings)
      .values({ key: sessionSettingsKey, value: stored })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: stored, updatedAt: new Date() },
      })
      .pipe(Effect.orDie);
    return stored;
  });
