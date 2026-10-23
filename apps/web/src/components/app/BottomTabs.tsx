// Нижняя панель на телефонах (`/app`, < md): те же пять разделов, что и в Rail,
// но в виде вкладок с подписями.
import { Link } from "@tanstack/react-router";
import { BarChart3, Clock, LayoutGrid, Package } from "lucide-react";
import type { ComponentType } from "react";

type Tab = {
  readonly to:
    "/app" | "/app/trending" | "/app/crate" | "/app/time" | "/profile";
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
};

function ProfileAvatar() {
  return (
    <span
      aria-hidden
      className="size-6 rounded-full bg-gradient-to-br from-[#3cc2ff] via-[#3a6cff] to-[#5b2fff]"
    />
  );
}

const TABS: ReadonlyArray<Tab> = [
  { to: "/app", label: "Мои игры", icon: LayoutGrid },
  { to: "/app/trending", label: "В тренде", icon: BarChart3 },
  { to: "/app/crate", label: "Из ящика", icon: Package },
  { to: "/app/time", label: "Время", icon: Clock },
  { to: "/profile", label: "Профиль", icon: ProfileAvatar },
];

export function BottomTabs() {
  return (
    <nav
      aria-label="Разделы"
      className="flex h-[84px] items-start justify-between border-t border-white/10 bg-[#0d0f14]/95 px-1 pt-2"
    >
      {TABS.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          activeOptions={{ exact: true }}
          activeProps={{ "aria-current": "page", className: "text-[#eef1ff]" }}
          className="flex flex-1 flex-col items-center gap-1 text-[10px] font-medium text-[#8a90a8]"
        >
          {to === "/profile" ? <Icon /> : <Icon className="size-6" />}
          {label}
        </Link>
      ))}
    </nav>
  );
}
