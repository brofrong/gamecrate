// Общие правила способов входа: синтетические email, какие провайдеры дают вход, когда можно отвязать.

/** Синтетический email Steam/Telegram (`steam_<id>@...`, `tg_<id>@...`) — не настоящая почта пользователя. */
export const SYNTHETIC_EMAIL = /^(steam|tg)_\d+@/i;

export const isSyntheticEmail = (email: string): boolean =>
  SYNTHETIC_EMAIL.test(email);

/** Идентификаторы провайдеров Better Auth, которыми можно войти. */
export type LoginProviderId =
  "google" | "yandex" | "pocket-id" | "telegram" | "steam";

/** Провайдеры, дающие вход сами по себе; `steam` сюда не входит (см. спеку). */
export const LOGIN_CAPABLE: ReadonlySet<string> = new Set<LoginProviderId>([
  "google",
  "yandex",
  "pocket-id",
  "telegram",
]);

/**
 * Можно ли отвязать `providerId`: после удаления всех его рядов у пользователя должен
 * остаться хоть один способ входа — другой `LOGIN_CAPABLE`-провайдер или подтверждённый
 * настоящий email.
 */
export const canUnlink = (
  accounts: ReadonlyArray<{ readonly providerId: string }>,
  providerId: string,
  user: { readonly email: string | null; readonly emailVerified: boolean },
): boolean => {
  const remaining = accounts.filter(
    (account) => account.providerId !== providerId,
  );
  const hasOtherLoginMethod = remaining.some((account) =>
    LOGIN_CAPABLE.has(account.providerId),
  );
  const emailIsLoginMethod =
    user.emailVerified && user.email !== null && !isSyntheticEmail(user.email);
  return hasOtherLoginMethod || emailIsLoginMethod;
};
