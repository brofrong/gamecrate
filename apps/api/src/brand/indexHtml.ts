// Витрина в `index.html`: сервер подставляет бренд и доступные способы входа до первой отрисовки,
// чтобы не было вспышки чужой темы. Фронт читает `data-brand` и `data-oauth` у `<html>`.
import { type BrandMeta, normalizeHost } from "@cg/brands";
import type { AppConfigValues } from "../config";
import { authProviders } from "../auth/providers";

export type OAuthFlags = {
  google: boolean;
  yandex: boolean;
  pocketId: boolean;
  telegram: boolean;
};

/**
 * Флаги провайдеров для хоста: провайдер настроен (как `authProviders`) И хост входит в
 * `oauthHosts.<провайдер>`. Без хоста — всё выключено.
 */
export const oauthForHost = (
  config: AppConfigValues,
  host: string | undefined,
): OAuthFlags => {
  if (host === undefined) {
    return { google: false, yandex: false, pocketId: false, telegram: false };
  }
  const normalized = normalizeHost(host);
  const configured = authProviders(config);
  return {
    google: configured.google && config.oauthHosts.google.has(normalized),
    yandex: configured.yandex && config.oauthHosts.yandex.has(normalized),
    pocketId: configured.pocketId && config.oauthHosts.pocketId.has(normalized),
    telegram: configured.telegram && config.oauthHosts.telegram.has(normalized),
  };
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** `data-oauth`: включённые способы через пробел в порядке `google yandex pocket-id telegram`. */
const oauthAttribute = (oauth: OAuthFlags): string =>
  [
    oauth.google ? "google" : null,
    oauth.yandex ? "yandex" : null,
    oauth.pocketId ? "pocket-id" : null,
    oauth.telegram ? "telegram" : null,
  ]
    .filter((token) => token !== null)
    .join(" ");

/** Заменяет значение атрибута `content` у `<meta>` с заданным началом (`name="x"`/`property="x"`). */
const replaceMetaContent = (html: string, key: string, value: string): string =>
  html.replace(
    new RegExp(`(<meta\\s+${key}\\s+content=")[^"]*(")`),
    (_match, open: string, close: string) =>
      `${open}${escapeHtml(value)}${close}`,
  );

/** Заменяет `href` у `<link rel="<rel>" …>`. */
const replaceLinkHref = (html: string, rel: string, href: string): string =>
  html.replace(
    new RegExp(`(<link\\s+rel="${rel}"[^>]*?\\shref=")[^"]*(")`),
    (_match, open: string, close: string) =>
      `${open}${escapeHtml(href)}${close}`,
  );

/**
 * Подставляет витрину в собранный `index.html`: `<html … data-brand data-oauth>`, `<title>`,
 * meta description/og:title/og:description/theme-color; при `brand.icons` — `href` у
 * `rel="icon"` и `rel="apple-touch-icon"`. Значения экранируются для HTML.
 */
export const renderIndexHtml = (
  template: string,
  brand: BrandMeta,
  oauth: OAuthFlags,
): string => {
  let html = template.replace(
    /<html\b([^>]*)>/,
    (_match, attributes: string) =>
      `<html${attributes.replace(/\sdata-(?:brand|oauth)="[^"]*"/g, "")} data-brand="${escapeHtml(brand.id)}" data-oauth="${oauthAttribute(oauth)}">`,
  );
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    () => `<title>${escapeHtml(brand.title)}</title>`,
  );
  html = replaceMetaContent(html, 'name="theme-color"', brand.themeColor);
  html = replaceMetaContent(html, 'name="description"', brand.description);
  html = replaceMetaContent(html, 'property="og:title"', brand.title);
  html = replaceMetaContent(
    html,
    'property="og:description"',
    brand.description,
  );
  if (brand.icons !== null) {
    html = replaceLinkHref(html, "icon", brand.icons.favicon);
    html = replaceLinkHref(
      html,
      "apple-touch-icon",
      brand.icons.appleTouchIcon,
    );
  }
  return html;
};
