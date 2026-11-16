// Реестр витрин фронта: название, логотип, способ монетизации и подмены страниц по
// домену. Витрину выбирает api (`<html data-brand>`), здесь она только читается.
import { BRANDS, type BrandId, type BrandMeta, isBrandId } from "@cg/brands";
import type { AuthProviders } from "@cg/rpc";
import type * as React from "react";
import { createContext, createElement, useContext } from "react";
import { beeline } from "./beeline";
import { gamecrate } from "./gamecrate";

/** Как витрина зарабатывает: свои тарифы или подписка у партнёра. */
export type Monetization =
  /** GameCrate: тарифы, цены, «Докупить». */
  | { readonly kind: "own" }
  | {
      readonly kind: "partner";
      readonly title: string;
      readonly text: string;
      readonly url: string | null;
    };

/** Страницы, которые витрина может подменить целиком. */
export type OverrideKey =
  "landing" | "loginPanel" | "landingPlans" | "plansPage";

export type WebBrand = BrandMeta & {
  readonly Logo: React.ComponentType<{
    height?: number;
    iconOnly?: boolean;
    progress?: number;
    title?: string;
  }>;
  /** Слоган рядом с названием (футер); `null` — без слогана. */
  readonly tagline: string | null;
  readonly monetization: Monetization;
  readonly overrides: Partial<
    Record<OverrideKey, React.LazyExoticComponent<React.ComponentType>>
  >;
};

export const WEB_BRANDS: Readonly<Record<BrandId, WebBrand>> = {
  gamecrate: { ...BRANDS.gamecrate, ...gamecrate },
  beeline: { ...BRANDS.beeline, ...beeline },
};

/** `data-brand` у <html> → WebBrand; неизвестное значение или атрибута нет → gamecrate. */
export const currentBrand = (): WebBrand => {
  const id =
    typeof document === "undefined"
      ? undefined
      : document.documentElement.dataset.brand;
  return WEB_BRANDS[id !== undefined && isBrandId(id) ? id : "gamecrate"];
};

const BrandContext = createContext<WebBrand | null>(null);

/** Витрина текущей страницы; в тестах её задаёт `BrandProvider`. */
export const useBrand = (): WebBrand =>
  useContext(BrandContext) ?? currentBrand();

export const BrandProvider: React.FC<{
  brand: WebBrand;
  children: React.ReactNode;
}> = ({ brand, children }) =>
  createElement(BrandContext.Provider, { value: brand }, children);

/** Токен `data-oauth` → поле `AuthProviders` (в атрибуте `pocket-id`, в схеме `pocketId`). */
const TOKEN_TO_PROVIDER: Readonly<Record<string, keyof AuthProviders>> = {
  google: "google",
  yandex: "yandex",
  "pocket-id": "pocketId",
  telegram: "telegram",
};

/**
 * Фильтр `AuthProviders` по `data-oauth` (включённые на этом домене способы входа):
 * атрибута нет (dev) — без фильтра; атрибут пустой — все способы выключены.
 */
export const providersForPage = (
  providers: AuthProviders,
  dataOauth: string | undefined,
): AuthProviders => {
  if (dataOauth === undefined) return providers;
  const enabled = new Set(
    dataOauth
      .split(/\s+/)
      .map((token) => TOKEN_TO_PROVIDER[token])
      .filter((key): key is keyof AuthProviders => key !== undefined),
  );
  return {
    google: providers.google && enabled.has("google"),
    yandex: providers.yandex && enabled.has("yandex"),
    pocketId: providers.pocketId && enabled.has("pocketId"),
    telegram: providers.telegram && enabled.has("telegram"),
  };
};

/** `providersForPage` с `data-oauth` текущей страницы. */
export const pageProviders = (providers: AuthProviders): AuthProviders =>
  providersForPage(providers, document.documentElement.dataset.oauth);
