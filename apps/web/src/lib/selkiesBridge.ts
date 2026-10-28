// Мост к Selkies 2.0 (спека §5, проверено по `selkies-core.js` образа 2026-10-28): страница
// шлёт настройки в iframe `/stream/<id>/` того же origin через `postMessage` и читает глобалы
// его окна для статистики.
//
// - `{type:"settings", settings:{video_bitrate:<кбит/с>}}` — единственное, что реально нужно
//   отправлять (сервер получает `vb,<n>`); потолок битрейта зависит от режима («авто» —
//   фиксированный потолок контроля заторов `autoBitrateMbps`, ручной — выбранный ползунком).
// - `{type:"statsOpen", open}` включает/выключает сбор статистики самим Selkies — без него
//   `window.stream_stats.latest` остаётся `null`.
// - Selkies сам шлёт себе в своё же окно `{type:"serverSettings", payload}` после применения
//   настроек (в т.ч. если сервер их подрезал) — слушаем `message` на `frame.contentWindow`
//   (не на `window`: Selkies родителю не пишет) и переприменяем свои настройки тем же способом,
//   что и при `attach`.
// - `getStats`/ответ `stats` в выбранном (WebRTC) пути Selkies не работает — поэтому числа не
//   запрашиваются сообщением, а читаются прямо из `window.stream_stats.latest` и
//   `window.stream_client` окна iframe; читаем только перечисленные ниже поля, остальное
//   (включая токен и имя аккаунта Steam) не трогаем и не логируем.
// - Разрешение здесь не трогается вовсе (§4.1, слово владельца 2026-10-28): смена разрешения на
//   лету роняет Unity-игры сменой выходов XRandR, поэтому `setManualResolution`/
//   `resetResolutionToWindow` никогда не отправляются — разрешение следующей сессии агент
//   выставляет сам при старте контейнера.
import { autoBitrateMbps, type StreamSettings } from "@cg/rpc";

/** Единственные сообщения, которые страница шлёт в Selkies (о разрешении — нет, см. выше). */
export type SelkiesMessage =
  | { type: "settings"; settings: { video_bitrate: number } }
  | { type: "statsOpen"; open: boolean };

/** Потолок битрейта (Мбит/с): «авто» — фиксированный потолок контроля заторов, иначе ручной. */
const ceilingMbps = (settings: StreamSettings): number =>
  settings.quality === "auto" ? autoBitrateMbps : settings.bitrateMbps;

/** Сообщения, применяющие текущие настройки: ровно один `settings` с потолком в кбит/с. */
export function settingsMessages(
  settings: StreamSettings,
): ReadonlyArray<SelkiesMessage> {
  return [
    {
      type: "settings",
      settings: { video_bitrate: ceilingMbps(settings) * 1_000 },
    },
  ];
}

/** Сообщения, нужные именно при смене настроек: пусто, если потолок битрейта не изменился. */
export function changedSettingsMessages(
  prev: StreamSettings,
  next: StreamSettings,
): ReadonlyArray<SelkiesMessage> {
  return ceilingMbps(prev) === ceilingMbps(next) ? [] : settingsMessages(next);
}

/** Числовая статистика стрима за последнюю секунду; не число/не строка в источнике — `null`. */
export type SelkiesSample = {
  readonly fps: number | null;
  readonly mbps: number | null;
  readonly rttMs: number | null;
  readonly decodeMs: number | null;
  readonly jitterMs: number | null;
  readonly lossPercent: number | null;
  readonly framesDropped: number | null;
  readonly codec: string | null;
  readonly resolution: string | null;
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Читает статистику из глобалов окна iframe: `stream_stats.latest` (числа) и `stream_client`
 * (кодек/разрешение). Только перечисленные поля — остальное содержимое этих объектов (включая
 * токен и имя аккаунта Steam) не копируется и не логируется. Нет окна, нет `latest`, неизвестный
 * тип поля или любая ошибка доступа (окно закрыто/недоступно) — `null`.
 */
export function readSelkiesStats(win: Window | null): SelkiesSample | null {
  try {
    if (win === null) return null;
    const globals = win as unknown as {
      stream_stats?: { latest?: unknown };
      stream_client?: unknown;
    };
    const latest = globals.stream_stats?.latest;
    if (latest === null || latest === undefined || typeof latest !== "object")
      return null;
    const latestRecord = latest as Record<string, unknown>;
    const client = globals.stream_client as Record<string, unknown> | undefined;
    return {
      fps: numberOrNull(latestRecord["fps"]),
      mbps: numberOrNull(latestRecord["mbps"]),
      rttMs: numberOrNull(latestRecord["rtt_ms"]),
      decodeMs: numberOrNull(latestRecord["decode_ms"]),
      jitterMs: numberOrNull(latestRecord["jitter_buffer_ms"]),
      lossPercent: numberOrNull(latestRecord["packet_loss_percent"]),
      framesDropped: numberOrNull(latestRecord["frames_dropped"]),
      codec: stringOrNull(client?.["codec"]),
      resolution: stringOrNull(client?.["resolution"]),
    };
  } catch {
    return null;
  }
}

/** На каждую загрузку iframe, на каждую смену настроек и на переключение панели статистики. */
export type SelkiesBridge = {
  /** Переподключается к новому iframe: снимает старый слушатель, шлёт текущие настройки. */
  attach(frame: HTMLIFrameElement): void;
  /** Шлёт только то, что изменилось между `prev` и `next`. */
  update(prev: StreamSettings, next: StreamSettings): void;
  /** Включает/выключает сбор статистики Selkies; значение переживает следующий `attach`. */
  setStatsOpen(open: boolean): void;
  /** Окно текущего iframe (для `readSelkiesStats`) или `null`, если не подключён. */
  frameWindow(): Window | null;
  /** Снимает слушатель и забывает про текущий iframe. */
  detach(): void;
};

/**
 * Мост к Selkies: `getSettings` читается заново при каждом применении (`attach`,
 * переответ `serverSettings`), поэтому сюда достаточно передать геттер над текущим состоянием
 * меню — отдельного хранения настроек внутри моста не нужно.
 */
export function createSelkiesBridge(
  getSettings: () => StreamSettings,
): SelkiesBridge {
  let frame: HTMLIFrameElement | null = null;
  let statsOpen = false;

  const currentWindow = (): Window | null => frame?.contentWindow ?? null;

  // Iframe может быть не готов принять сообщение (ещё не прогрузился/уже выгружается) —
  // не роняем страницу, следующее применение (reload/update) догонит.
  const send = (message: SelkiesMessage): void => {
    const win = currentWindow();
    if (win === null) return;
    try {
      win.postMessage(message, window.location.origin);
    } catch {
      // см. выше
    }
  };

  const applyAll = (): void => {
    for (const message of settingsMessages(getSettings())) send(message);
    if (statsOpen) send({ type: "statsOpen", open: true });
  };

  // Selkies шлёт `serverSettings` себе в своё окно после применения настроек (в т.ч. после
  // санитизации сервером) — переприменяем свои настройки тем же способом, что при `attach`.
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown } | null | undefined;
    if (data !== null && typeof data === "object" && data.type === "serverSettings")
      applyAll();
  };

  const detachListener = (): void => {
    try {
      currentWindow()?.removeEventListener("message", onMessage);
    } catch {
      // окно уже недоступно — переживём.
    }
  };

  return {
    attach(nextFrame) {
      detachListener();
      frame = nextFrame;
      try {
        currentWindow()?.addEventListener("message", onMessage);
      } catch {
        // см. выше
      }
      applyAll();
    },
    update(prev, next) {
      for (const message of changedSettingsMessages(prev, next)) send(message);
    },
    setStatsOpen(open) {
      statsOpen = open;
      send({ type: "statsOpen", open });
    },
    frameWindow() {
      return currentWindow();
    },
    detach() {
      detachListener();
      frame = null;
    },
  };
}
