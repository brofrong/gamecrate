// Экраны сессии без стрима: сохранение, итог, ошибка, «сессия не найдена». Очередь,
// установка и запуск — экран загрузки (`LoadingScreen` в `Player`).
import { type SessionView, steamLoginRequiredReason } from "@cg/rpc";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  LoaderCircle,
  SearchX,
} from "lucide-react";
import type * as React from "react";
import {
  SteamQrLogin,
  type SteamQrLoginComponent,
} from "@/components/SteamQrLogin";
import { Button } from "@/components/ui/button";

/** Игровое время: «1 ч 12 мин», «1 ч 05 мин»; меньше часа — «10 мин». */
export function formatPlayed(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0
    ? `${rest} мин`
    : `${hours} ч ${String(rest).padStart(2, "0")} мин`;
}

function StatusScreen({
  icon,
  title,
  gameName,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  gameName?: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          {icon}
        </div>
        {gameName && (
          <p className="text-sm text-muted-foreground">{gameName}</p>
        )}
        <p className="text-lg font-medium">{title}</p>
        {children}
      </div>
    </main>
  );
}

const spinner = <LoaderCircle className="size-6 animate-spin" />;

function LibraryButton({ onLibrary }: { onLibrary: () => void }) {
  return <Button onClick={onLibrary}>В библиотеку</Button>;
}

function Reason({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function Played({ seconds }: { seconds: number }) {
  return <p className="text-sm">{`Вы играли ${formatPlayed(seconds)}`}</p>;
}

/** Состояние сессии, когда стрим не показан. */
export function SessionStatus({
  view,
  onLibrary,
  onPlayAgain,
  QrLogin = SteamQrLogin,
}: {
  view: SessionView;
  onLibrary: () => void;
  /** «Готово» на экране QR после пропавшего входа — запустить игру заново. */
  onPlayAgain: () => void;
  QrLogin?: SteamQrLoginComponent;
}) {
  const { gameName } = view;
  switch (view.state) {
    case "stopping":
      return (
        <StatusScreen
          icon={spinner}
          title="Сохраняем прогресс…"
          gameName={gameName}
        />
      );
    case "ended":
      // Причина у `ended` — сессию закрыл сервер (таймаут запуска, игрок не
      // вернулся): не успех, но и не ошибка.
      return view.failReason ? (
        <StatusScreen
          icon={
            <CircleMinus
              data-icon="neutral"
              className="size-6 text-muted-foreground"
            />
          }
          title="Сессия завершена"
          gameName={gameName}
        >
          <Reason text={view.failReason} />
          <Played seconds={view.playedSeconds} />
          <LibraryButton onLibrary={onLibrary} />
        </StatusScreen>
      ) : (
        <StatusScreen
          icon={<CircleCheck className="size-6 text-emerald-400" />}
          title={`Сессия завершена. Вы играли ${formatPlayed(view.playedSeconds)}`}
          gameName={gameName}
        >
          <LibraryButton onLibrary={onLibrary} />
        </StatusScreen>
      );
    case "failed": {
      // Игра успела идти — сбой прервал её, а не помешал запуску.
      const played = view.playedSeconds > 0;
      // Установщик не дождался входа в Steam внутри контейнера: показываем тот же
      // экран с QR, что и при первом подключении, вместо общей ошибки запуска (§3.2).
      if (!played && view.failReason === steamLoginRequiredReason) {
        return (
          <main className="flex min-h-dvh items-center justify-center px-6">
            <div className="flex max-w-md flex-col items-center gap-4 text-center">
              {gameName && (
                <p className="text-sm text-muted-foreground">{gameName}</p>
              )}
              <QrLogin title="Войдите в Steam ещё раз" onDone={onPlayAgain} />
              <LibraryButton onLibrary={onLibrary} />
            </div>
          </main>
        );
      }
      return (
        <StatusScreen
          icon={<CircleAlert className="size-6 text-destructive" />}
          title={played ? "Игра прервалась" : "Не удалось запустить игру"}
          gameName={gameName}
        >
          {view.failReason && <Reason text={view.failReason} />}
          {played && <Played seconds={view.playedSeconds} />}
          <LibraryButton onLibrary={onLibrary} />
        </StatusScreen>
      );
    }
    default:
      // playing / idle_warning / disconnected, а стрим ещё не готов (queued/installing/
      // starting сюда не попадают — их показывает экран загрузки).
      return (
        <StatusScreen
          icon={spinner}
          title="Подключаемся к стриму…"
          gameName={gameName}
        />
      );
  }
}

/** Сессии нет или она чужая. */
export function SessionMissing({ onLibrary }: { onLibrary: () => void }) {
  return (
    <StatusScreen
      icon={<SearchX className="size-6" />}
      title="Сессия не найдена"
    >
      <LibraryButton onLibrary={onLibrary} />
    </StatusScreen>
  );
}
