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
 * - `installTimeoutMinutes` — таймаут установки игры в `installing` (10–720 мин).
 * - `steamLoginTimeoutSeconds` — сколько установщик ждёт сканирования QR
 *   входа в Steam, прежде чем провалить установку (30–600 с, спека §4).
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
  installTimeoutMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: 10, maximum: 720 }),
  ),
  steamLoginTimeoutSeconds: Schema.Int.check(
    Schema.isBetween({ minimum: 30, maximum: 600 }),
  ),
});
export type SessionSettings = typeof SessionSettings.Type;

/** Значения по умолчанию, применяются, когда в `settings` нет записи `"session"`. */
export const defaultSessionSettings: SessionSettings = {
  idleWarningMinutes: 15,
  idleGraceMinutes: 2,
  disconnectGraceMinutes: 5,
  startTimeoutMinutes: 15,
  installTimeoutMinutes: 180,
  steamLoginTimeoutSeconds: 90,
};

/**
 * Дополняет сохранённое значение недостающими полями по умолчанию перед
 * декодированием: запись прежней версии (например, MVP-2 без
 * `installTimeoutMinutes`) сохраняет заданные администратором таймеры, а не
 * откатывается целиком к значениям по умолчанию. Не объект — как есть.
 */
export const withSessionSettingsDefaults = (value: unknown): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...defaultSessionSettings, ...value }
    : value;
