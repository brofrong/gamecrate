// Фиксированная шапка лендинга: прозрачная наверху, после 40px скролла — фон с блюром.
// Логотип сворачивается в GC-куб по прогрессу скролла; якоря скрыты уже < 860px.
import { useEffect, useState } from "react";
import { useBrand } from "@/brands";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { useScrollProgress } from "@/components/brand/useScrollProgress";
import { cn } from "@/lib/utils";
import { PlayButton } from "./PlayButton";

export const navLinks = [
  ["#how", "Как работает"],
  ["#tech", "Технология"],
  ["#plans", "Тарифы"],
  ["#ach", "Ачивки"],
  ["#faq", "FAQ"],
] as const;

export function LandingNav() {
  const brand = useBrand();
  const progress = useScrollProgress();
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={cn(
        "fixed inset-x-0 top-0 z-50 border-b border-transparent transition-[background-color,border-color] duration-300",
        solid &&
          "solid border-brand-line bg-[rgba(5,6,15,0.7)] backdrop-blur-[14px]",
      )}
    >
      <div className="mx-auto flex h-[68px] max-w-[1180px] items-center justify-between px-7">
        <a href="#top" className="flex items-center" aria-label={brand.name}>
          <BrandLogo progress={progress} height={36} title={brand.name} />
        </a>
        <div className="hidden items-center gap-7 text-sm text-brand-muted min-[860px]:flex">
          {navLinks.map(([href, name]) => (
            <a
              key={href}
              href={href}
              className="transition-colors hover:text-brand-text"
            >
              {name}
            </a>
          ))}
        </div>
        <PlayButton variant="ghost" />
      </div>
    </nav>
  );
}
