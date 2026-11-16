// Витрина GameCrate: анимированный логотип, свои тарифы, без подмен страниц.
import type { BrandMeta } from "@cg/brands";
import { Logo } from "@/components/brand/Logo";
import type { WebBrand } from "..";

export const gamecrate: Omit<WebBrand, keyof BrandMeta> = {
  Logo,
  tagline: "Games in containers",
  monetization: { kind: "own" },
  overrides: {},
};
