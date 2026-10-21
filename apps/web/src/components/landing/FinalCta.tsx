// Финальный призыв перед футером.
import { SteamButton } from "./SteamButton";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden py-[120px] text-center">
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(58,108,255,0.16),rgba(0,0,0,0)_65%)]" />
      <div className="relative mx-auto max-w-[1180px] px-7">
        <h2 className="mb-[18px] text-[clamp(34px,5vw,64px)] leading-none font-extrabold tracking-[-0.04em]">
          Твои игры <span className="text-gradient">ждут</span>.
        </h2>
        <p className="mb-[30px] text-lg text-brand-muted">
          Войди через Steam и выбери, во что сегодня.
        </p>
        <SteamButton variant="primary" />
      </div>
    </section>
  );
}
