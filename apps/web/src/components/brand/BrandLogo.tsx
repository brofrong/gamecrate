// Логотип текущей витрины: GameCrate рисует анимированный знак, партнёр — свой.
import type * as React from "react";
import { useBrand } from "@/brands";

export function BrandLogo(
  props: React.ComponentProps<ReturnType<typeof useBrand>["Logo"]>,
) {
  const { Logo } = useBrand();
  return <Logo {...props} />;
}
