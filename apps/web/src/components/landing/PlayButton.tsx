// Кнопка-ссылка на `/login`: `primary` — бренд-градиент («Играть»), `ghost` — полупрозрачная («Войти»).
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PlayButton({
  variant,
  children,
  className,
}: {
  variant: "primary" | "ghost";
  children?: React.ReactNode;
  className?: string;
}) {
  const primary = variant === "primary";
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
      <Link to="/login">{children ?? (primary ? "Играть" : "Войти")}</Link>
    </Button>
  );
}
