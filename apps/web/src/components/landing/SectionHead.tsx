// Заголовок секции лендинга: подпись капсом, h2, лид.
import type * as React from "react";
import { cn } from "@/lib/utils";

export function SectionHead({
  label,
  title,
  children,
  badge,
  align,
}: {
  label: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  badge?: React.ReactNode;
  /** По центру страницы (FAQ). */
  align?: "center";
}) {
  const centered = align === "center";
  return (
    <div
      className={cn("mb-12 max-w-[680px]", centered && "mx-auto text-center")}
    >
      <div
        className={cn(
          "mb-3.5 flex flex-wrap items-center gap-2.5 text-xs font-bold tracking-[0.16em] text-brand-cyan uppercase",
          centered && "justify-center",
        )}
      >
        {label}
        {badge}
      </div>
      <h2 className="mb-4 text-[clamp(30px,4vw,50px)] leading-[1.05] font-extrabold tracking-[-0.035em]">
        {title}
      </h2>
      {children && (
        <p className="text-[17px] leading-[1.55] text-brand-muted">
          {children}
        </p>
      )}
    </div>
  );
}
