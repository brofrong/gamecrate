// Адреса картинок и магазина Steam для страницы игры (спека 2026-10-27 §3.5, §4.1):
// строятся по `appId`, у себя не хранятся.

/** Широкая картинка шапки `library_hero.jpg` (не у всех игр есть — запас `headerUrl`). */
export const heroUrl = (appId: number) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_hero.jpg`;

/** Страница игры в магазине Steam. */
export const storeUrl = (appId: number) =>
  `https://store.steampowered.com/app/${appId}`;
