// Полоска разделов слева на десктопе/планшете (`/app`): четыре основных раздела,
// «Поиск» (ведёт на /app с `?focus=q`) и аватар-ссылка на /profile. Закреплена на весь
// экран минус отступы сетки (`h-[calc(100dvh-3rem)]`): логотип всегда у верха, аватар
// у низа, при прокрутке содержимого не уезжает (спека 2026-10-27 §3.1).
import { Link } from "@tanstack/react-router";
import { BarChart3, Clock, LayoutGrid, Package, Search } from "lucide-react";
import type { ComponentType } from "react";
import type { CurrentUserShape } from "@cg/rpc";
import { UserAvatar } from "@/components/app/UserAvatar";
import { useBrand } from "@/brands";
import { BrandLogo } from "@/components/brand/BrandLogo";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type SectionLink = {
  readonly to: "/app" | "/app/trending" | "/app/crate" | "/app/time";
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
};

const SECTIONS: ReadonlyArray<SectionLink> = [
  { to: "/app", label: "Мои игры", icon: LayoutGrid },
  { to: "/app/trending", label: "В тренде", icon: BarChart3 },
  { to: "/app/crate", label: "Из ящика", icon: Package },
  { to: "/app/time", label: "Время", icon: Clock },
];

// Имя ссылки для скринридера берётся из `aria-label` на `Link`, поэтому иконке
// достаточно быть декоративной.
function RailIcon({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  children?: React.ReactNode;
}) {
  return (
    <>
      <Icon aria-hidden className="size-5" />
      {children}
    </>
  );
}

const linkClassName =
  "relative flex size-11 items-center justify-center rounded-2xl text-[#8a90a8] transition-colors hover:bg-white/5 hover:text-[#eef1ff]";

export function Rail({ user }: { user: CurrentUserShape }) {
  const brand = useBrand();
  return (
    <nav
      aria-label="Разделы"
      className="flex h-[calc(100dvh-3rem)] w-[84px] flex-col items-center gap-2 rounded-[40px] bg-[#13161d] py-5"
    >
      <Link to="/app" aria-label={brand.name} className="mb-6">
        <BrandLogo iconOnly progress={1} height={36} />
      </Link>
      {SECTIONS.map(({ to, label, icon }) => (
        <Tooltip key={to}>
          <TooltipTrigger asChild>
            <Link
              to={to}
              aria-label={label}
              activeOptions={{ exact: true }}
              activeProps={{
                "aria-current": "page",
                className: "bg-[#262a36] text-[#eef1ff]",
              }}
              className={linkClassName}
            >
              <RailIcon icon={icon} />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/app"
            search={{ focus: "q" }}
            aria-label="Поиск"
            className={linkClassName}
          >
            <RailIcon icon={Search} />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Поиск</TooltipContent>
      </Tooltip>
      <Link to="/profile" aria-label="Профиль" className="mt-1">
        <UserAvatar user={user} className="size-10" />
      </Link>
    </nav>
  );
}
