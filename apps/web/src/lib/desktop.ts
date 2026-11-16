// Мост сайта к десктоп-приложению (Tauri). «Мы в приложении» определяем по наличию моста
// `window.__TAURI_INTERNALS__`, не по User-Agent. Команды зовём напрямую через `invoke`, без
// пакета `@tauri-apps/api`: сайт не тянет зависимость Tauri. В браузере всё — no-op, ошибки
// моста проглатываются (приложение не должно ломать страницу игры).

type TauriInternals = {
  readonly invoke: (cmd: string, args?: Record<string, unknown>) => unknown;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/** Состояние для трея приложения. */
export type DesktopStatus =
  | { kind: "idle" }
  | { kind: "queued"; position: number; total: number; etaMinutes: number | null }
  | { kind: "starting" }
  | { kind: "playing" };

export type DesktopInfo = { version: string; os: "windows" | "macos" | "linux" };

const bridge = (): TauriInternals | undefined =>
  typeof window === "undefined" ? undefined : window.__TAURI_INTERNALS__;

/** Открыт ли сайт внутри десктоп-приложения. */
export const isDesktop = (): boolean => bridge() !== undefined;

/** Домашняя страница: в приложении лендинга нет, сразу библиотека. */
export const homePath = (): "/" | "/app" => (isDesktop() ? "/app" : "/");

/** Вызов команды: вне приложения — `undefined`, ошибки (в т.ч. синхронные) — тоже. */
const call = async (
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> => {
  const b = bridge();
  if (b === undefined) return undefined;
  try {
    return await b.invoke(cmd, args);
  } catch {
    return undefined;
  }
};

export const desktopNotify = async (
  title: string,
  body: string,
): Promise<void> => {
  await call("notify", { title, body });
};

export const desktopSetStatus = async (status: DesktopStatus): Promise<void> => {
  await call("set_status", { status });
};

export const desktopEnterGameFullscreen = async (): Promise<void> => {
  await call("enter_game_fullscreen");
};

export const desktopExitGameFullscreen = async (): Promise<void> => {
  await call("exit_game_fullscreen");
};

/**
 * DOM-событие приложения о входе в игровой полный экран и выходе из него (в т.ч. средствами
 * ОС: зелёная кнопка, Ctrl+Cmd+F): `detail` — `true`/`false`. Его шлёт Rust
 * (`fullscreen::event_script`) через `eval` — не событие Tauri, чтобы не расширять права сайта.
 */
export const GAME_FULLSCREEN_EVENT = "gamecrate:game-fullscreen";

/** Подписка на [GAME_FULLSCREEN_EVENT]; событие с не-boolean `detail` пропускается. */
export const onDesktopGameFullscreen = (
  listener: (on: boolean) => void,
): (() => void) => {
  const onEvent = (event: Event) => {
    const { detail } = event as CustomEvent<unknown>;
    if (typeof detail === "boolean") listener(detail);
  };
  window.addEventListener(GAME_FULLSCREEN_EVENT, onEvent);
  return () => window.removeEventListener(GAME_FULLSCREEN_EVENT, onEvent);
};

export const desktopOpenExternal = async (url: string): Promise<void> => {
  await call("open_external", { url });
};

const isOs = (v: unknown): v is DesktopInfo["os"] =>
  v === "windows" || v === "macos" || v === "linux";

/** Версия оболочки и ОС; `null` вне приложения, при ошибке или неожиданном ответе. */
export const desktopAppInfo = async (): Promise<DesktopInfo | null> => {
  const raw = await call("app_info");
  if (typeof raw !== "object" || raw === null) return null;
  const { version, os } = raw as Record<string, unknown>;
  if (typeof version !== "string" || !isOs(os)) return null;
  return { version, os };
};
