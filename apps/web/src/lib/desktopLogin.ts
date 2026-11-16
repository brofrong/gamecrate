// Вход в десктоп-приложение через системный браузер (Google и другие OAuth не пускают
// webview): адреса страниц и разбор токена. Сами страницы — `routes/loginDesktop.tsx`,
// ссылку `gamecrate://` разбирает приложение (`apps/desktop/src-tauri/src/deep_link.rs`).
import type { AuthProviders } from "@cg/rpc";
import type { SocialProvider } from "@/auth";

/** Куда вернуть браузер после OAuth: там уже есть сессия, осталось выдать токен. */
export const DESKTOP_DONE_PATH = "/login/desktop?done=1";

/** Ошибка обмена токена в окне приложения. */
export const DESKTOP_ERROR_PATH = "/login?error=DESKTOP_TOKEN";

const PROVIDER_KEY: Readonly<Record<SocialProvider, keyof AuthProviders>> = {
  google: "google",
  yandex: "yandex",
  telegram: "telegram",
  "pocket-id": "pocketId",
};

/** Страница `/login/desktop` для системного браузера; адрес — сайт, открытый в окне приложения. */
export const desktopLoginUrl = (provider: SocialProvider): string =>
  `${window.location.origin}/login/desktop?provider=${encodeURIComponent(provider)}`;

/** `provider` из адреса — только включённый на этой странице способ входа, иначе `null`. */
export const browserProvider = (
  raw: unknown,
  providers: AuthProviders,
): SocialProvider | null => {
  if (typeof raw !== "string" || !Object.hasOwn(PROVIDER_KEY, raw)) return null;
  const provider = raw as SocialProvider;
  return providers[PROVIDER_KEY[provider]] ? provider : null;
};

/** Формат токена — тот же, что пропускает приложение. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/** Ссылка, которой браузер отдаёт токен приложению. */
export const desktopAuthLink = (token: string): string =>
  `gamecrate://auth?token=${encodeURIComponent(token)}`;

/** Токен из фрагмента `#token=…` (`/login/desktop/finish`); нет или кривой — `null`. */
export const tokenFromHash = (hash: string): string | null => {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token !== null && TOKEN.test(token) ? token : null;
};
