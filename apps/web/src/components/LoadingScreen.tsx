// Экран загрузки до появления игры (спека 2026-10-27-loading-screen §2, макет B): размытый
// арт игры на фоне, слева обложка, справа название, этапы списком и общая полоска.
// Лежит поверх трансляции в `Player` — та подключается под ним и не пересоздаётся.
import type { SessionView } from "@cg/rpc";
import { ArrowLeft, Check, Monitor } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { coverUrl, heroUrl } from "@/lib/gameHero";
import {
  type LoadingStep,
  loadingProgress,
  loadingSteps,
} from "@/lib/loadingSteps";
import { cn } from "@/lib/utils";

/** Сколько ждать окна игры на этапе «Загружаем игру», прежде чем подсказать «Показать экран». */
export const LOADING_HINT_MS = 3 * 60_000;

function StepDot({ status }: { status: LoadingStep["status"] }) {
  if (status === "done") {
    return (
      <span className="flex size-5 flex-none items-center justify-center rounded-full bg-brand-blue text-white">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "size-5 flex-none rounded-full",
        status === "now"
          ? "animate-spin border-2 border-brand-cyan border-t-transparent"
          : "border-[1.5px] border-white/25",
      )}
    />
  );
}

export function LoadingScreen({
  view,
  msInStage,
  onCancel,
  onReveal,
}: {
  view: SessionView;
  /** Сколько мс клиент видит текущий этап — для полоски и подсказки. */
  msInStage: number;
  /** «Отменить» — тот же `session.stop`, что и выход из игры. */
  onCancel: () => void;
  /** «Показать экран»; нет — трансляции ещё нет, и кнопки тоже. */
  onReveal: (() => void) | undefined;
}) {
  // Картинки нет (или CDN не ответил) — остаётся тёмный фон бренда, без значка битой картинки.
  const [backdropOk, setBackdropOk] = useState(true);
  const [coverOk, setCoverOk] = useState(true);
  const steps = loadingSteps(view);
  const progress = loadingProgress(view, msInStage);
  const waitHint =
    view.stage === "loading" && msInStage >= LOADING_HINT_MS
      ? "Похоже, игра ждёт вас на экране"
      : null;

  return (
    <section
      aria-label="Загрузка игры"
      className="absolute inset-0 z-20 overflow-y-auto bg-brand-bg text-brand-text"
    >
      <div aria-hidden className="absolute inset-0 overflow-hidden">
        {backdropOk && (
          <img
            src={heroUrl(view.appId)}
            alt=""
            onError={() => setBackdropOk(false)}
            className="absolute -inset-5 size-[calc(100%+2.5rem)] max-w-none object-cover blur-[14px] saturate-[1.2]"
          />
        )}
        <div className="absolute inset-0 bg-brand-bg/70" />
      </div>

      <div className="relative flex min-h-full flex-col">
        <header className="flex items-start justify-between gap-4 p-3 sm:p-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="text-brand-text/60 hover:bg-white/10 hover:text-brand-text dark:hover:bg-white/10"
          >
            <ArrowLeft />
            Отменить
          </Button>
          {onReveal && (
            <div className="flex max-w-64 flex-col items-end gap-2 text-right">
              <Button
                variant="ghost"
                size="sm"
                onClick={onReveal}
                className="border border-white/20 bg-white/10 text-brand-text/85 hover:bg-white/15 hover:text-brand-text dark:hover:bg-white/15"
              >
                <Monitor />
                Показать экран
              </Button>
              {waitHint && (
                <p className="text-sm font-medium text-brand-cyan">
                  {waitHint}
                </p>
              )}
              {view.state === "starting" && (
                <p className="text-xs text-brand-text/60">
                  Если появилось окно входа Steam — отсканируйте QR-код в
                  мобильном приложении Steam
                </p>
              )}
            </div>
          )}
        </header>

        {/* Узкий экран — обложка над списком, широкий — слева от него. */}
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pt-2 pb-10 sm:flex-row sm:gap-10 sm:px-10">
          {coverOk && (
            <img
              src={coverUrl(view.appId)}
              alt=""
              onError={() => setCoverOk(false)}
              className="aspect-[2/3] w-36 flex-none rounded-lg object-cover shadow-[0_8px_30px_rgba(0,0,0,0.6)] sm:h-[min(60vh,28rem)] sm:w-auto"
            />
          )}
          <div className="flex w-full max-w-md flex-col gap-5">
            <h1 className="text-2xl font-bold sm:text-3xl">{view.gameName}</h1>
            <ol className="flex flex-col gap-3">
              {steps.map((step) => (
                <li
                  // Ключ без процента: строка скачивания не пересоздаётся на каждом
                  // проценте — спиннер не дёргается.
                  key={step.label.split(" · ")[0]}
                  aria-current={step.status === "now" ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-3",
                    step.status === "now" && "font-semibold",
                    step.status === "next" && "text-brand-text/60",
                  )}
                >
                  <StepDot status={step.status} />
                  {step.label}
                </li>
              ))}
            </ol>
            <div
              role="progressbar"
              aria-label="Загрузка"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              className="h-1 overflow-hidden rounded-full bg-white/12"
            >
              <div
                className="h-full rounded-full bg-linear-to-r from-brand-cyan via-brand-blue to-brand-violet transition-[width] duration-1000 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            {view.state === "installing" && (
              <p className="text-sm text-brand-text/60">
                Время установки не входит в игровое
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
