// Словарь кодов ошибок входа/привязки (Better Auth, наши хуки на `/unlink-account`,
// плагин Telegram, `sendEmailCode`) → текст тоста для пользователя.
const MESSAGES: Record<string, string> = {
  STEAM_ACCOUNT_ALREADY_LINKED: "Этот Steam уже привязан к другому аккаунту",
  ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER:
    "Этот аккаунт уже привязан к другому пользователю GameCrate",
  LAST_LOGIN_METHOD: "Нельзя отвязать последний способ входа",
  INVALID_OTP: "Неверный код",
  OTP_EXPIRED: "Код устарел, отправь новый",
  TOO_MANY_ATTEMPTS: "Слишком много попыток, запроси новый код",
  TELEGRAM_INVALID_SIGNATURE: "Telegram не подтвердил вход",
  TELEGRAM_EXPIRED: "Telegram не подтвердил вход",
  TELEGRAM_INVALID_BODY: "Telegram не подтвердил вход",
  TELEGRAM_ALREADY_LINKED: "Этот Telegram уже привязан к другому аккаунту",
  TELEGRAM_SESSION_REQUIRED: "Чтобы привязать Telegram, сначала войди",
  MAIL_FAILED: "Не удалось отправить письмо, попробуй позже",
};

const FALLBACK = "Провайдер не подтвердил вход, попробуй ещё раз";

export const authErrorMessage = (code: string | undefined): string =>
  (code && MESSAGES[code]) || FALLBACK;
