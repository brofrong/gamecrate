// Полоска разделов слева на десктопе/планшете (`/app`): четыре основных раздела,
// «Поиск»/«Установки» (оба ведут на /app с нужным search) и аватар-ссылка на /profile.
import { Link } from "@tanstack/react-router";
import {
  BarChart3,
  Clock,
  Download,
  LayoutGrid,
  Package,
  Search,
} from "lucide-react";
import type { ComponentType } from "react";
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

export function Rail({ installing }: { installing: boolean }) {
  return (
    <nav
      aria-label="Разделы"
      className="sticky top-6 flex w-[84px] flex-col items-center gap-2 rounded-[40px] bg-[#13161d] py-5"
    >
      <div
        aria-hidden
        className="mb-6 size-[30px] rounded-[9px] bg-gradient-to-br from-[#3cc2ff] via-[#3a6cff] to-[#5b2fff]"
      />
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/app"
            search={{ status: "installing" }}
            aria-label="Установки"
            className={linkClassName}
          >
            <RailIcon icon={Download}>
              {installing && (
                <span
                  data-testid="installs-dot"
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-[#ffd166]"
                />
              )}
            </RailIcon>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Установки</TooltipContent>
      </Tooltip>
      <Link
        to="/profile"
        aria-label="Профиль"
        className="mt-1 size-10 rounded-full bg-gradient-to-br from-[#3cc2ff] via-[#3a6cff] to-[#5b2fff]"
      />
    </nav>
  );
}
