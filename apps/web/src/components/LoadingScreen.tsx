// Экран загрузки до появления игры (спека 2026-10-27-loading-screen §2, макет B): размытый
// арт игры на фоне, слева обложка, справа название, этапы списком и общая полоска.
// Лежит поверх трансляции в `Player` — та подключается под ним и не пересоздаётся.
import { isOwnAppId, type SessionView } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bell, Check, Monitor } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { coverUrl, heroUrl } from "@/lib/gameHero";
import {
  type LoadingStep,
  loadingProgress,
  loadingSteps,
  loadingTotal,
  stageOverdue,
} from "@/lib/loadingSteps";
import { cn } from "@/lib/utils";

/** «Отменить» с подтверждением: случайный клик не должен обрывать долгую установку. */
function CancelButton({
  installing,
  onCancel,
}: {
  installing: boolean;
  onCancel: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-brand-text/60 hover:bg-white/10 hover:text-brand-text dark:hover:bg-white/10"
        >
          <ArrowLeft />
          Отменить
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {installing ? "Отменить установку?" : "Отменить запуск игры?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {installing
              ? "Установку можно будет начать заново из библиотеки."
              : "Игру можно будет запустить заново из библиотеки."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Ждать дальше</AlertDialogCancel>
          <AlertDialogAction onClick={onCancel}>Да, отменить</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function StepDot({ status }: { status: LoadingStep["status"] }) {
  if (status === "done") {
    return (
      <span className="flex size-5 flex-none items-center justify-center rounded-full bg-brand-blue text-brand-on-accent">
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

/**
 * Кнопка «Сообщить, когда подойдёт очередь» (спека §5 просит сайт самому спросить
 * разрешение при входе в очередь — отступление записано в итоге плана задачи 11:
 * Safari и другие браузеры разрешают запрос `Notification` только по нажатию, не
 * автоматически). Видна только пока разрешение `"default"`; без поддержки
 * `Notification` или при уже решённом разрешении — ничего.
 */
function NotifyWhenReady() {
  const [permission, setPermission] = useState<NotificationPermission | null>(
    () =>
      typeof Notification === "undefined" ? null : Notification.permission,
  );
  if (permission !== "default") return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        if (typeof Notification === "undefined") return;
        void Notification.requestPermission()
          .then(setPermission)
          .catch(() => {});
      }}
      className="self-start border border-white/20 bg-white/10 text-brand-text/85 hover:bg-white/15 hover:text-brand-text dark:hover:bg-white/15"
    >
      <Bell />
      Сообщить, когда подойдёт очередь
    </Button>
  );
}

export function LoadingScreen({
  view,
  msInStage,
  nowServerMs,
  onCancel,
  onReveal,
  higherTariffExists = false,
}: {
  view: SessionView;
  /** Сколько мс клиент видит текущий этап — для полоски, если у этапа нет отметки в `timing`. */
  msInStage: number;
  /**
   * «Сейчас» сервера, мс (часы браузера с поправкой по `timing.serverNow`) — для
   * таймеров и полоски внутри отмеченного этапа.
   */
  nowServerMs: number;
  /** «Отменить» (после подтверждения) — тот же `session.stop`, что и выход из игры. */
  onCancel: () => void;
  /**
   * «Показать экран»; нет — трансляции ещё нет или её пока рано предлагать
   * (`revealDue`), и кнопки тоже.
   */
  onReveal: (() => void) | undefined;
  /**
   * В каталоге тарифа игрока есть открытый тариф с приоритетом очереди выше текущего
   * (`hasHigherTariff`, спека §5/§7) — подсказка «В тарифе выше очередь короче» со
   * ссылкой на страницу тарифов, пока сессия `queued`.
   */
  higherTariffExists?: boolean;
}) {
  // Картинки нет (или CDN не ответил) — остаётся тёмный фон бренда, без значка битой картинки.
  const [backdropOk, setBackdropOk] = useState(true);
  const [coverOk, setCoverOk] = useState(true);
  const steps = loadingSteps(view, nowServerMs);
  const total = loadingTotal(view, nowServerMs);
  const progress = loadingProgress(view, msInStage, nowServerMs);
  // На «Входим в аккаунт» — подсказка про QR (без `timing` — как раньше, весь
  // `starting`; у своей игры входа в Steam нет — и подсказки); на остальных — если
  // этап идёт дольше 2× нормы.
  const qrHint =
    !isOwnAppId(view.appId) &&
    view.state === "starting" &&
    (view.stage === "login" || view.timing === null);
  const slowHint = view.stage !== "login" && stageOverdue(view, nowServerMs);

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
          <CancelButton
            installing={view.state === "installing"}
            onCancel={onCancel}
          />
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
              {slowHint && (
                <p className="text-sm font-medium text-brand-cyan">
                  Дольше обычного — загляните на экран
                </p>
              )}
              {qrHint && (
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
            {total && (
              <p className="text-sm text-brand-text/60 tabular-nums">{total}</p>
            )}
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
            {view.state === "queued" && (
              <div className="flex flex-col items-start gap-2">
                {higherTariffExists && (
                  <Link
                    to="/app/plans"
                    className="text-sm text-brand-cyan underline-offset-2 hover:underline"
                  >
                    В тарифе выше очередь короче
                  </Link>
                )}
                <NotifyWhenReady />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
