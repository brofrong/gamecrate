// Адреса картинок и магазина Steam по `appId` (у себя не хранятся): страница игры
// (спека 2026-10-27-app-cards-and-game-page §3.5, §4.1) и экран загрузки сессии.
// У своей игры (`isOwnAppId`) картинки — наши, статикой сайта `/own-games/<appId>/`.
import { isOwnAppId, ownGameAssetUrl } from "@cg/rpc";

/** Широкая картинка шапки `library_hero.jpg` (не у всех игр есть — запас `headerUrl`). */
export const heroUrl = (appId: number) =>
  isOwnAppId(appId)
    ? ownGameAssetUrl(appId, "hero.jpg")
    : `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_hero.jpg`;

/** Вертикальная обложка `library_600x900.jpg` (экран загрузки сессии). */
export const coverUrl = (appId: number) =>
  isOwnAppId(appId)
    ? ownGameAssetUrl(appId, "cover.jpg")
    : `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;

/** Страница игры в магазине Steam. */
export const storeUrl = (appId: number) =>
  `https://store.steampowered.com/app/${appId}`;
