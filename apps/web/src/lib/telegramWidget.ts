// Загрузка Telegram Login Widget (`telegram-widget.js`) и вызов его JS-API
// (`Telegram.Login.auth`) — скрипт грузится лениво и один раз, параллельные
// вызовы делят один и тот же промис загрузки.
import type { TelegramAuthData } from "@cg/rpc";

const WIDGET_SRC = "https://telegram.org/js/telegram-widget.js?22";

declare global {
  interface Window {
    Telegram?: {
      Login: {
        auth: (
          options: { bot_id: string; request_access: false },
          callback: (data: TelegramAuthData | false | undefined) => void,
        ) => void;
      };
    };
  }
}

let loadPromise: Promise<void> | null = null;

const loadWidget = (): Promise<void> => {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error("TELEGRAM_WIDGET_LOAD_FAILED"));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
};

/** Открывает всплывающее окно Telegram-логина; `null` — пользователь его закрыл. */
export const telegramAuth = async (
  botId: string,
): Promise<TelegramAuthData | null> => {
  await loadWidget();
  return new Promise<TelegramAuthData | null>((resolve) => {
    window.Telegram?.Login.auth(
      { bot_id: botId, request_access: false },
      (data) => resolve(data || null),
    );
  });
};
