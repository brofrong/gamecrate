// Экран сессии: стрим Selkies во весь экран (iframe /stream/<id>/) с плашками поверх,
// либо статус без стрима (SessionStatus).
import type { SessionState, SessionView } from "@cg/rpc";
import { LogOut } from "lucide-react";
import { useEffect, useRef } from "react";
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
import { IdlePrompt } from "./IdlePrompt";
import { SessionStatus } from "./SessionStatus";

/** Состояния, в которых показывается стрим (если он готов). */
const streamStates: ReadonlySet<SessionState> = new Set([
  "starting",
  "playing",
  "idle_warning",
  "disconnected",
]);

export const showsStream = (view: SessionView) =>
  view.streamReady && streamStates.has(view.state);

/** Через сколько перезагрузить iframe, если прокси ответил 5xx (Selkies ещё не поднялся). */
const STREAM_RETRY_MS = 3_000;

/** HTTP-статус документа iframe (тот же origin); `undefined` — неизвестно. */
const frameStatus = (frame: HTMLIFrameElement): number | undefined => {
  try {
    const [entry] =
      frame.contentWindow?.performance.getEntriesByType("navigation") ?? [];
    const status = (entry as { responseStatus?: number } | undefined)
      ?.responseStatus;
    return typeof status === "number" && status > 0 ? status : undefined;
  } catch {
    return undefined;
  }
};

function StreamFrame({
  sessionId,
  onLoad,
}: {
  sessionId: string;
  onLoad: ((frame: HTMLIFrameElement) => void) | undefined;
}) {
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retry.current), []);

  return (
    <iframe
      title="Игра"
      src={`/stream/${sessionId}/`}
      allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write"
      className="absolute inset-0 size-full border-0"
      onLoad={(event) => {
        const frame = event.currentTarget;
        onLoad?.(frame);
        const status = frameStatus(frame);
        if (status !== undefined && status >= 500) {
          clearTimeout(retry.current);
          retry.current = setTimeout(() => {
            try {
              frame.contentWindow?.location.reload();
            } catch {
              frame.src = `/stream/${sessionId}/`;
            }
          }, STREAM_RETRY_MS);
        }
      }}
    />
  );
}

function ExitButton({ onExit }: { onExit: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="absolute top-3 right-3 z-30 opacity-60 hover:opacity-100 focus-visible:opacity-100"
        >
          <LogOut />
          Выйти из игры
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Закончить игру? Прогресс сохранится.
          </AlertDialogTitle>
          <AlertDialogDescription>
            Игра закроется, сохранения синхронизируются со Steam Cloud.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Продолжить играть</AlertDialogCancel>
          <AlertDialogAction onClick={onExit}>Закончить игру</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Player({
  view,
  onExit,
  onHere,
  onLibrary,
  onFrameLoad,
}: {
  view: SessionView;
  /** Пользователь подтвердил «Выйти из игры». */
  onExit: () => void;
  /** «Я здесь» на предупреждении о простое. */
  onHere: () => void;
  onLibrary: () => void;
  /** Документ стрима загружен (на каждую загрузку iframe). */
  onFrameLoad?: (frame: HTMLIFrameElement) => void;
}) {
  if (!showsStream(view)) {
    return <SessionStatus view={view} onLibrary={onLibrary} />;
  }

  // Порядок детей постоянный: iframe первым и без условий — React не пересоздаёт его
  // при смене состояния, и стрим не переподключается.
  return (
    <main className="fixed inset-0 bg-black">
      <StreamFrame sessionId={view.id} onLoad={onFrameLoad} />
      {view.state === "starting" && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
          <p className="max-w-xl rounded-md bg-background/90 px-4 py-2 text-center text-sm shadow-lg">
            Если появилось окно входа Steam — отсканируйте QR-код в мобильном
            приложении Steam
          </p>
        </div>
      )}
      {view.state === "idle_warning" && view.idleDeadline !== null && (
        <IdlePrompt deadline={view.idleDeadline} onHere={onHere} />
      )}
      <ExitButton onExit={onExit} />
    </main>
  );
}
