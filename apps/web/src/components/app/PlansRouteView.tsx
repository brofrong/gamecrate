// Содержимое `/app/plans`: подмена страницы витриной, иначе — по способу монетизации:
// `own` → тарифы и пакеты GameCrate, `partner` → подписка у партнёра без цен.
import { useBrand } from "@/brands";
import { BrandSlot } from "@/components/brand/BrandSlot";
import { PartnerPlansPage } from "./PartnerPlansPage";
import { PlansPage } from "./PlansPage";

export function PlansRouteView() {
  const { monetization } = useBrand();
  return (
    <BrandSlot
      name="plansPage"
      fallback={monetization.kind === "own" ? PlansPage : PartnerPlansPage}
    />
  );
}
