// Вход в десктоп-приложение через системный браузер (Google и другие OAuth не пускают
// webview): адреса страниц, `state` окна и разбор ссылки. Сами страницы —
// `routes/loginDesktop.tsx`, ссылку `gamecrate://` разбирает приложение
// (`apps/desktop/src-tauri/src/deep_link.rs`).
//
// `state` привязывает вход к окну, которое его начало: окно кладёт случайный `state` в свой
// `sessionStorage`, он идёт через браузер (и OAuth) обратно в ссылке `gamecrate://auth`, и
// `/login/desktop/finish` меняет токен, только если `state` совпал. Иначе чужой сайт мог бы
// отдать приложению токен своей учётки (login CSRF).
import type { AuthProviders } from "@cg/rpc";
import type { SocialProvider } from "@/auth";

/** Ошибка обмена токена в окне приложения. */
export const DESKTOP_ERROR_PATH = "/login?error=DESKTOP_TOKEN";

/** Ключ `sessionStorage` окна приложения со `state` начатого входа. */
export const DESKTOP_STATE_KEY = "gamecrate.desktopLoginState";

const PROVIDER_KEY: Readonly<Record<SocialProvider, keyof AuthProviders>> = {
  google: "google",
  yandex: "yandex",
  telegram: "telegram",
  "pocket-id": "pocketId",
};

/** Формат токена — тот же, что пропускает приложение. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/** Формат `state` — тот же, что пропускает приложение. */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;

/** `state` из адреса — только правильного формата, иначе `null`. */
export const validState = (raw: unknown): string | null =>
  typeof raw === "string" && STATE.test(raw) ? raw : null;

/** Новый `state`: 32 случайных байта в base64url (43 символа). */
export const newDesktopState = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

/**
 * Окно приложения: новый `state` в `sessionStorage`. Хранилище недоступно — исключение (вход
 * без `state` всё равно не завершится, браузер открывать незачем).
 */
export const rememberDesktopState = (): string => {
  const state = newDesktopState();
  window.sessionStorage.setItem(DESKTOP_STATE_KEY, state);
  return state;
};

/** Окно приложения: сохранённый `state` (или `null`); из хранилища он удаляется в любом случае. */
export const takeDesktopState = (): string | null => {
  let saved: string | null = null;
  try {
    saved = window.sessionStorage.getItem(DESKTOP_STATE_KEY);
  } catch {
    // хранилище недоступно — значит, и сохранённого нет
  }
  try {
    window.sessionStorage.removeItem(DESKTOP_STATE_KEY);
  } catch {
    // нечего удалять
  }
  return saved;
};

/** Страница `/login/desktop` для системного браузера; адрес — сайт, открытый в окне приложения. */
export const desktopLoginUrl = (
  provider: SocialProvider,
  state: string,
): string =>
  `${window.location.origin}/login/desktop?${new URLSearchParams({ provider, state })}`;

/** Куда вернуть браузер после OAuth: там уже есть сессия, осталось подтвердить вход. */
export const desktopDonePath = (state: string): string =>
  `/login/desktop?${new URLSearchParams({ done: "1", state })}`;

/** `provider` из адреса — только включённый на этой странице способ входа, иначе `null`. */
export const browserProvider = (
  raw: unknown,
  providers: AuthProviders,
): SocialProvider | null => {
  if (typeof raw !== "string" || !Object.hasOwn(PROVIDER_KEY, raw)) return null;
  const provider = raw as SocialProvider;
  return providers[PROVIDER_KEY[provider]] ? provider : null;
};

/** Ссылка, которой браузер отдаёт токен приложению. */
export const desktopAuthLink = (token: string, state: string): string =>
  `gamecrate://auth?${new URLSearchParams({ token, state })}`;

/**
 * Токен и `state` из фрагмента `#token=…&state=…` (`/login/desktop/finish`); чего-то нет или
 * формат кривой — `null`.
 */
export const fromHash = (
  hash: string,
): { token: string; state: string } | null => {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  const state = validState(params.get("state"));
  return token !== null && TOKEN.test(token) && state !== null
    ? { token, state }
    : null;
};
