// Кнопка-ссылка лендинга: `primary` — бренд-градиент («Играть»), `ghost` — полупрозрачная
// («Войти»). Для невошедшего ведёт на `/login`; для вошедшего (`LandingAuth` из
// `LandingPage`) — в библиотеку `/app`, и «Войти» становится «В библиотеку».
import { Link } from "@tanstack/react-router";
import { createContext, use } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Вошёл ли пользователь — задаёт `LandingPage`, читают кнопки по всему лендингу. */
export const LandingAuth = createContext<{ signedIn: boolean }>({
  signedIn: false,
});

export function PlayButton({
  variant,
  children,
  className,
}: {
  variant: "primary" | "ghost";
  children?: React.ReactNode;
  className?: string;
}) {
  const { signedIn } = use(LandingAuth);
  const primary = variant === "primary";
  const label = primary ? "Играть" : signedIn ? "В библиотеку" : "Войти";
  return (
    <Button
      asChild
      size="lg"
      className={cn(
        "h-12 rounded-xl px-6 text-[15px] font-semibold transition-[transform,box-shadow] hover:-translate-y-px",
        primary
          ? "bg-brand-gradient text-white shadow-[0_10px_30px_rgba(60,110,255,0.35)] hover:shadow-[0_14px_40px_rgba(60,110,255,0.5)]"
          : "h-10 border border-white/12 bg-white/6 px-4 text-sm text-brand-text backdrop-blur-md hover:bg-white/10",
        className,
      )}
    >
      <Link to={signedIn ? "/app" : "/login"}>{children ?? label}</Link>
    </Button>
  );
}
