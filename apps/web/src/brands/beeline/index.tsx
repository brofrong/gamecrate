// Витрина билайна: фирменный шар, подписка у партнёра вместо тарифов.
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
    // Подписки и их плюсы со старого сайта beeplaycloud.ru. Начисление часов по ним —
    // вместе с API билайна.
    plans: [
      {
        name: "Стандартная подписка",
        price: "75 ₽",
        priceNote: "стоимость подключения, 1 час",
        perks: [
          "получай часы ежедневно",
          "бонусные часы за активное использование",
        ],
      },
      {
        name: "Недельная подписка",
        price: "299 ₽",
        priceNote: "стоимость подключения, 7 часов",
        perks: ["получай часы каждую неделю"],
      },
    ],
  },
  overrides: {},
};
