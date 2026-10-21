// Кнопка входа через Steam: `primary` — бренд-градиент («Играть»), `ghost` — полупрозрачная
// с иконкой Steam («Войти через Steam»). Пока идёт запрос — спиннер и disabled.
import { LoaderCircle } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSteamLogin } from "@/lib/useSteamLogin";

export function SteamIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("size-5 fill-current", className)}
    >
      <path d="M11.98 0C5.67 0 .5 4.86.01 11.03l6.44 2.66a3.38 3.38 0 0 1 2.14-.6l2.87-4.15v-.06a4.53 4.53 0 1 1 4.53 4.53h-.1l-4.08 2.92.01.17a3.4 3.4 0 0 1-6.74.66L.47 15.33A12 12 0 1 0 11.98 0Zm-4.45 18.2-1.48-.6a2.55 2.55 0 1 0 1.4-3.5l1.53.63a1.88 1.88 0 1 1-1.45 3.47Zm11.5-9.37a3.02 3.02 0 1 0-6.04 0 3.02 3.02 0 0 0 6.04 0Zm-5.28 0a2.27 2.27 0 1 1 4.54 0 2.27 2.27 0 0 1-4.54 0Z" />
    </svg>
  );
}

export function SteamButton({
  variant,
  children,
  className,
}: {
  variant: "primary" | "ghost";
  children?: React.ReactNode;
  className?: string;
}) {
  const { login, pending } = useSteamLogin();
  const primary = variant === "primary";
  return (
    <Button
      size="lg"
      onClick={login}
      disabled={pending}
      className={cn(
        "h-12 rounded-xl px-6 text-[15px] font-semibold transition-[transform,box-shadow] hover:-translate-y-px",
        primary
          ? "bg-brand-gradient text-white shadow-[0_10px_30px_rgba(60,110,255,0.35)] hover:shadow-[0_14px_40px_rgba(60,110,255,0.5)]"
          : "h-10 border border-white/12 bg-white/6 px-4 text-sm text-brand-text backdrop-blur-md hover:bg-white/10",
        className,
      )}
    >
      {pending ? (
        <LoaderCircle className="animate-spin" />
      ) : (
        !primary && <SteamIcon className="size-[18px]" />
      )}
      {children ?? (primary ? "Играть" : "Войти через Steam")}
    </Button>
  );
}
