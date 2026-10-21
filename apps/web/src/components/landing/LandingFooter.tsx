// Футер лендинга: знак, имя и слоган, копирайт и упоминание Valve.
import { Logo } from "@/components/brand/Logo";

export function LandingFooter() {
  return (
    <footer className="border-t border-brand-line py-9 text-[13px] text-brand-muted">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3.5 px-7">
        <span className="flex items-center gap-2.5 text-[15px] font-semibold text-brand-text">
          <Logo iconOnly height={22} />
          GameCrate · Games in containers
        </span>
        <span>
          © 2026 GameCrate. Steam является торговой маркой Valve Corporation.
        </span>
      </div>
    </footer>
  );
}
