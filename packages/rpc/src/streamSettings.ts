// Настройки стрима, хранимые в аккаунте (таблица `user_stream_settings`): качество,
// битрейт, разрешение, отладка, раскладка клавиатуры и признаки «обход меню пройден» и «обучение
// полному экрану пройдено» (спека §4). Читаются при
// каждом запуске игры — следующая сессия на любом устройстве открывается с ними.
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthMiddleware } from "./auth";

/** «Авто» — Selkies сам подстраивает битрейт под сеть; «ручной» — фиксированный потолок. */
export const StreamQuality = Schema.Literals(["auto", "manual"]);
export type StreamQuality = typeof StreamQuality.Type;

/** Разрешения ручного режима (§4.1); «По окну» убрано — смена разрешения роняет Unity-игры. */
export const StreamResolution = Schema.Literals(["720p", "1080p", "1440p"]);
export type StreamResolution = typeof StreamResolution.Type;

/** Режим отладочной статистики над стримом (§3): «Выкл» / «Коротко» / «Подробно». */
export const DebugMode = Schema.Literals(["off", "short", "detailed"]);
export type DebugMode = typeof DebugMode.Type;

/** Границы ручного битрейта (Мбит/с, целые) и потолок «Авто». */
export const minBitrateMbps = 2;
export const maxBitrateMbps = 40;
export const autoBitrateMbps = 20;

/**
 * Настройки стрима (спека §4).
 * - `bitrateMbps` — потолок ручного режима; при плохой сети Selkies всё равно снизит.
 * - `resolution` — ручной режим, применяется со следующего запуска игры (§4.1): идущая
 *   сессия разрешение не меняет.
 * - `menuTourSeen` — подсказка у меню («Здесь настройки игры и выход») и обход его разделов
 *   пройдены (правка владельца 2026-11-05; заменил `menuSeen` — обход новый, его видят все).
 *   Ключ необязателен на входе, как `fullscreenTutorialSeen`; `menuSeen` из старых вкладок —
 *   лишний ключ, схема его отбрасывает.
 * - `localLayout` — клавиши уходят в игру символами раскладки игрока (для чатов на русском);
 *   по умолчанию — по физическому месту, как на английской (игры ждут WASD на любой раскладке).
 * - `fullscreenTutorialSeen` — обучение полному экрану («Играй на весь экран», «зажми Esc»)
 *   пройдено. Ключ необязателен на входе: вкладки со старым сайтом сохраняют настройки без него,
 *   и `save` не должен им отказывать (без ключа — `false`, обучение покажется ещё раз).
 */
export const StreamSettings = Schema.Struct({
  quality: StreamQuality,
  bitrateMbps: Schema.Int.check(
    Schema.isBetween({ minimum: minBitrateMbps, maximum: maxBitrateMbps }),
  ),
  resolution: StreamResolution,
  debug: DebugMode,
  menuTourSeen: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  localLayout: Schema.Boolean,
  fullscreenTutorialSeen: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
});
export type StreamSettings = typeof StreamSettings.Type;

/** Значения по умолчанию: автобитрейт, 1080p, отладка выкл, подсказки не показаны, клавиши по месту. */
export const defaultStreamSettings: StreamSettings = {
  quality: "auto",
  bitrateMbps: autoBitrateMbps,
  resolution: "1080p",
  debug: "off",
  menuTourSeen: false,
  localLayout: false,
  fullscreenTutorialSeen: false,
};

/** Декодирует поле схемой, неизвестное/битое значение — умолчание этого поля. */
const decodeField = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  fallback: S["Type"],
): S["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  return decoded._tag === "Some" ? decoded.value : fallback;
};

/**
 * Декодирует сохранённое значение поле за полем: не объект — умолчания целиком;
 * иначе каждое поле декодируется отдельно, неизвестное/битое — умолчание этого поля
 * (а не всей записи), лишние ключи отбрасываются. Старое значение `resolution: "window"`
 * («По окну», убрано спекой) тоже не проходит схему — откатывается на `"1080p"`.
 */
export const decodeStreamSettings = (value: unknown): StreamSettings => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return defaultStreamSettings;
  const record = value as Record<string, unknown>;
  return {
    quality: decodeField(
      StreamQuality,
      record["quality"],
      defaultStreamSettings.quality,
    ),
    bitrateMbps: decodeField(
      StreamSettings.fields.bitrateMbps,
      record["bitrateMbps"],
      defaultStreamSettings.bitrateMbps,
    ),
    resolution: decodeField(
      StreamResolution,
      record["resolution"],
      defaultStreamSettings.resolution,
    ),
    debug: decodeField(DebugMode, record["debug"], defaultStreamSettings.debug),
    menuTourSeen: decodeField(
      Schema.Boolean,
      record["menuTourSeen"],
      defaultStreamSettings.menuTourSeen,
    ),
    localLayout: decodeField(
      Schema.Boolean,
      record["localLayout"],
      defaultStreamSettings.localLayout,
    ),
    fullscreenTutorialSeen: decodeField(
      Schema.Boolean,
      record["fullscreenTutorialSeen"],
      defaultStreamSettings.fullscreenTutorialSeen,
    ),
  };
};

/** Размер экрана стрима в пикселях. */
export type DisplaySize = { readonly width: number; readonly height: number };

/** Размеры разрешений ручного режима (§4.1) — единственные допустимые размеры экрана. */
export const streamDisplaySizes: Record<StreamResolution, DisplaySize> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
};

/** Размер по умолчанию: «Авто», неизвестное значение или отсутствие настроек. */
export const defaultDisplaySize: DisplaySize = streamDisplaySizes["1080p"];

/** Размер экрана для команды агенту: «Авто» → умолчание, ручной режим → его разрешение. */
export const displaySizeOf = (settings: StreamSettings): DisplaySize =>
  settings.quality === "auto"
    ? defaultDisplaySize
    : streamDisplaySizes[settings.resolution];

/**
 * Проверка размера против белого списка (агент и оркестратор проверяют его же):
 * не из трёх допустимых размеров — умолчание 1920×1080.
 */
export const allowedDisplaySize = (value: unknown): DisplaySize => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("width" in value) ||
    !("height" in value)
  )
    return defaultDisplaySize;
  const { width, height } = value as { width: unknown; height: unknown };
  const match = Object.values(streamDisplaySizes).find(
    (size) => size.width === width && size.height === height,
  );
  return match ?? defaultDisplaySize;
};

/**
 * - `streamSettings.get` — настройки стрима текущего пользователя (умолчания, если
 *   записи нет или она битая).
 * - `streamSettings.save` — сохраняет и возвращает сохранённое значение.
 */
export const StreamSettingsRpcs = RpcGroup.make(
  Rpc.make("streamSettings.get", { success: StreamSettings }),
  Rpc.make("streamSettings.save", {
    payload: StreamSettings,
    success: StreamSettings,
  }),
).middleware(AuthMiddleware);
