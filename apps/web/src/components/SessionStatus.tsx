// Экраны сессии без стрима: очередь, запуск, сохранение, итог, ошибка, «сессия не найдена».
import type { SessionView } from "@cg/rpc";
import {
  CircleAlert,
  CircleCheck,
  Hourglass,
  LoaderCircle,
  SearchX,
} from "lucide-react";
import type * as React from "react";
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

/** Состояние сессии, когда стрим не показан. */
export function SessionStatus({
  view,
  onLibrary,
}: {
  view: SessionView;
  onLibrary: () => void;
}) {
  const { gameName } = view;
  switch (view.state) {
    case "queued":
      return (
        <StatusScreen
          icon={<Hourglass className="size-6" />}
          title="Ждём свободный сервер…"
          gameName={gameName}
        />
      );
    case "starting":
      return (
        <StatusScreen
          icon={spinner}
          title="Запускаем игру…"
          gameName={gameName}
        />
      );
    case "stopping":
      return (
        <StatusScreen
          icon={spinner}
          title="Сохраняем прогресс…"
          gameName={gameName}
        />
      );
    case "ended":
      return (
        <StatusScreen
          icon={<CircleCheck className="size-6 text-emerald-400" />}
          title={`Сессия завершена. Вы играли ${formatPlayed(view.playedSeconds)}`}
          gameName={gameName}
        >
          <LibraryButton onLibrary={onLibrary} />
        </StatusScreen>
      );
    case "failed":
      return (
        <StatusScreen
          icon={<CircleAlert className="size-6 text-destructive" />}
          title="Не удалось запустить игру"
          gameName={gameName}
        >
          {view.failReason && (
            <p className="text-sm text-muted-foreground">{view.failReason}</p>
          )}
          <LibraryButton onLibrary={onLibrary} />
        </StatusScreen>
      );
    default:
      // playing / idle_warning / disconnected, а стрим ещё не готов.
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
