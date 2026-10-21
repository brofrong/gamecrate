// FAQ в виде чата: вопрос — пузырь справа («Ты»), ответ — слева со знаком GameCrate.
// Сообщения проявляются, когда доезжают до экрана (ответ — с задержкой 250 мс);
// без IntersectionObserver или при reduced motion видно всё сразу.
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";
import { faq } from "./data";
import { SectionHead } from "./SectionHead";

const ANSWER_DELAY_MS = 250;

export function FaqChat() {
  const reduced = usePrefersReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set());
  const revealAll = reduced || typeof IntersectionObserver === "undefined";

  useEffect(() => {
    const list = listRef.current;
    if (!list || revealAll) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const index = Number((e.target as HTMLElement).dataset.msg);
          io.unobserve(e.target);
          timers.push(
            setTimeout(
              () => setShown((prev) => new Set(prev).add(index)),
              (index % 2) * ANSWER_DELAY_MS,
            ),
          );
        }
      },
      { threshold: 0.4 },
    );
    for (const el of list.querySelectorAll("[data-msg]")) io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [revealAll]);

  const messages = faq.flatMap(({ q, a }) => [
    { me: true, text: q },
    { me: false, text: a },
  ]);

  return (
    <section id="faq" className="relative py-[110px]">
      <div className="mx-auto max-w-[1180px] px-7">
        <SectionHead label="FAQ" title="Обычно спрашивают" />
        <div ref={listRef} className="grid max-w-[720px] gap-3.5">
          {messages.map((m, i) => (
            <div
              key={m.text}
              data-msg={i}
              className={cn(
                "flex items-end gap-3 transition-[opacity,transform] duration-500",
                m.me && "flex-row-reverse",
                revealAll || shown.has(i)
                  ? "opacity-100"
                  : "translate-y-3 opacity-0",
              )}
            >
              <div
                aria-hidden="true"
                className={cn(
                  "flex size-[34px] shrink-0 items-center justify-center rounded-full text-sm font-bold",
                  m.me ? "bg-[#23284a]" : "bg-brand-gradient p-1.5",
                )}
              >
                {m.me ? "Ты" : <Logo iconOnly height={20} title="GameCrate" />}
              </div>
              <div
                className={cn(
                  "max-w-[78%] rounded-[18px] px-4 py-3 text-[15px] leading-normal",
                  m.me
                    ? "rounded-br-md bg-brand-blue text-white"
                    : "rounded-bl-md border border-brand-line bg-brand-card text-[#d6d9f2]",
                )}
              >
                {m.text}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
