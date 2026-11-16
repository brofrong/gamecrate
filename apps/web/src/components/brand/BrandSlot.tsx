// Подмена страницы витриной по ключу: есть override у текущей витрины — рисуем его
// (в Suspense), иначе — обычный компонент. Остальные пропсы уходят тому, что выбрано.
import { type ComponentType, Suspense } from "react";
import { type OverrideKey, useBrand } from "@/brands";

export function BrandSlot<P extends object>({
  name,
  fallback: Fallback,
  ...props
}: { name: OverrideKey; fallback: ComponentType<P> } & P) {
  const Override = useBrand().overrides[name] as ComponentType<P> | undefined;
  const passed = props as unknown as P;
  if (Override === undefined) return <Fallback {...passed} />;
  return (
    <Suspense fallback={null}>
      <Override {...passed} />
    </Suspense>
  );
}
