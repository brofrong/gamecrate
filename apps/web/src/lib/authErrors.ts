// Словарь кодов ошибок входа/привязки (Better Auth, наши хуки на `/unlink-account`,
// `sendEmailCode`) → текст тоста для пользователя.
const MESSAGES: Record<string, string> = {
  STEAM_ACCOUNT_ALREADY_LINKED: "Этот Steam уже привязан к другому аккаунту",
  ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER:
    "Этот аккаунт уже привязан к другому пользователю GameCrate",
  LAST_LOGIN_METHOD: "Нельзя отвязать последний способ входа",
  INVALID_OTP: "Неверный код",
  OTP_EXPIRED: "Код устарел, отправь новый",
  TOO_MANY_ATTEMPTS: "Слишком много попыток, запроси новый код",
  MAIL_FAILED: "Не удалось отправить письмо, попробуй позже",
  // Better Auth пускает к отвязке только с сессией младше суток (`freshAge`).
  SESSION_NOT_FRESH: "Для этого войди заново: выйди и зайди снова",
};

const FALLBACK = "Провайдер не подтвердил вход, попробуй ещё раз";

export const authErrorMessage = (code: string | undefined): string =>
  (code && MESSAGES[code]) || FALLBACK;
