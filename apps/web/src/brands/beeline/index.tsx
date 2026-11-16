// Витрина билайна: временный логотип, подписка у партнёра вместо тарифов.
import type { BrandMeta } from "@cg/brands";
import type { WebBrand } from "..";
import { BeelineLogo } from "./BeelineLogo";

export const beeline: Omit<WebBrand, keyof BrandMeta> = {
  Logo: BeelineLogo,
  tagline: null,
  monetization: {
    kind: "partner",
    title: "Подписка билайн",
    // Черновик текста — владелец поправит.
    text: "Подписка оформляется в билайне. Когда она активна, все игры доступны без ограничений по тарифу.",
    url: null,
  },
  overrides: {},
};
