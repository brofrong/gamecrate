// Финальный призыв перед футером.
import { PlayButton } from "./PlayButton";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden py-[120px] text-center">
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgb(var(--brand-accent-2-rgb)/0.16),rgba(0,0,0,0)_65%)]" />
      <div className="relative mx-auto max-w-[1180px] px-7">
        <h2 className="mb-[18px] text-[clamp(34px,5vw,64px)] leading-none font-extrabold tracking-[-0.04em]">
          Твои игры <span className="text-gradient">ждут</span>.
        </h2>
        <p className="mb-[30px] text-lg text-brand-muted">
          Войди и выбери, во что сегодня.
        </p>
        <PlayButton variant="primary" />
      </div>
    </section>
  );
}
