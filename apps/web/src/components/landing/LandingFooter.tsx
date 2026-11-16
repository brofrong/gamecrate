// Футер лендинга: знак, имя и слоган, копирайт и упоминание Valve.
import { useBrand } from "@/brands";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { DownloadLink } from "@/components/DownloadLink";

export function LandingFooter() {
  const brand = useBrand();
  return (
    <footer className="border-t border-brand-line py-9 text-[13px] text-brand-muted">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3.5 px-7">
        <span className="flex items-center gap-2.5 text-[15px] font-semibold text-brand-text">
          <BrandLogo iconOnly height={22} />
          {brand.tagline === null
            ? brand.name
            : `${brand.name} · ${brand.tagline}`}
        </span>
        <span className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <DownloadLink className="font-medium text-brand-text hover:underline" />
          <span>
            © 2026 {brand.name}. Steam является торговой маркой Valve Corporation.
          </span>
        </span>
      </div>
    </footer>
  );
}
