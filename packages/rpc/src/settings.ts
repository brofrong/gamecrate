// Настройки сессий, хранимые в таблице `settings` под ключом `"session"`.
import { Schema } from "effect";

/** Ключ записи в таблице `settings` для `SessionSettings`. */
export const sessionSettingsKey = "session";

/**
 * Настройки таймингов сессии (спека §6): применяются на лету, в том числе
 * к уже идущим таймерам.
 * - `idleWarningMinutes` — простой до предупреждения (1–120 мин).
 * - `idleGraceMinutes` — время ответить на предупреждение (1–30 мин).
 * - `disconnectGraceMinutes` — ожидание возврата после отключения (1–60 мин).
 * - `startTimeoutMinutes` — таймаут запуска сессии (5–60 мин).
 */
export const SessionSettings = Schema.Struct({
  idleWarningMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 120 }),
  ),
  idleGraceMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 30 }),
  ),
  disconnectGraceMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 60 }),
  ),
  startTimeoutMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: 5, maximum: 60 }),
  ),
});
export type SessionSettings = typeof SessionSettings.Type;

/** Значения по умолчанию, применяются, когда в `settings` нет записи `"session"`. */
export const defaultSessionSettings: SessionSettings = {
  idleWarningMinutes: 15,
  idleGraceMinutes: 2,
  disconnectGraceMinutes: 5,
  startTimeoutMinutes: 15,
};
