// Предупреждение о простое поверх стрима: «Вы ещё здесь?», обратный отсчёт до idleDeadline.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Как часто обновлять отсчёт (чаще секунды — чтобы цифра не «залипала» на границе). */
const TICK_MS = 250;

/** Оставшееся время «m:ss» (округление вверх: «0:00» — только когда срок вышел). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function IdlePrompt({
  deadline,
  onHere,
  now = Date.now,
}: {
  /** ISO 8601 автозакрытия сессии. */
  deadline: string;
  onHere: () => void;
  /** Часы (подменяются в тестах). */
  now?: () => number;
}) {
  const deadlineMs = Date.parse(deadline);
  const [left, setLeft] = useState(() => deadlineMs - now());

  useEffect(() => {
    setLeft(deadlineMs - now());
    const timer = setInterval(() => setLeft(deadlineMs - now()), TICK_MS);
    return () => clearInterval(timer);
  }, [deadlineMs, now]);

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 px-6">
      <div
        role="alertdialog"
        aria-labelledby="idle-title"
        className="flex max-w-sm flex-col items-center gap-4 rounded-lg border bg-background p-6 text-center shadow-lg"
      >
        <p id="idle-title" className="text-xl font-semibold">
          Вы ещё здесь?
        </p>
        <p className="text-sm text-muted-foreground">
          {`Сессия закроется через ${formatCountdown(left)}`}
        </p>
        <Button size="lg" onClick={onHere} autoFocus>
          Я здесь
        </Button>
      </div>
    </div>
  );
}
