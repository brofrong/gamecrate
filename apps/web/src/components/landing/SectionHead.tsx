// Заголовок секции лендинга: подпись капсом, h2, лид.
import type * as React from "react";

export function SectionHead({
  label,
  title,
  children,
  badge,
}: {
  label: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <div className="mb-12 max-w-[680px]">
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5 text-xs font-bold tracking-[0.16em] text-brand-cyan uppercase">
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
