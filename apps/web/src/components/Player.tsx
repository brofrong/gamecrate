// Экран сессии: стрим Selkies во весь экран (iframe /stream/<id>/) с плашками поверх,
// экран загрузки до появления игры (LoadingScreen, поверх ещё скрытого стрима),
// либо статус без стрима (SessionStatus).
import type { SessionState, SessionView } from "@cg/rpc";
import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { showsLoading } from "@/lib/loadingSteps";
import { IdlePrompt } from "./IdlePrompt";
import { LoadingScreen } from "./LoadingScreen";
import { SessionStatus } from "./SessionStatus";
import { SteamQrLogin, type SteamQrLoginComponent } from "./SteamQrLogin";

/** Состояния, в которых показывается стрим (если он готов). */
const streamStates: ReadonlySet<SessionState> = new Set([
  "starting",
  "playing",
  "idle_warning",
  "disconnected",
]);

export const showsStream = (view: SessionView) =>
  view.streamReady && streamStates.has(view.state);

/** Как часто обновлять полоску и подсказку экрана загрузки. */
const LOADING_TICK_MS = 1_000;

/** Пока `active` — перерисовка раз в `LOADING_TICK_MS` (полоска и подсказка). */
function useLoadingTick(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), LOADING_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
}

/** Сколько мс клиент видит `key` неизменным: отсчёт с его последней смены. */
function useMsSince(key: string): number {
  const since = useRef({ key, at: Date.now() });
  if (since.current.key !== key) since.current = { key, at: Date.now() };
  return Date.now() - since.current.at;
}

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
  hidden,
  onLoad,
}: {
  sessionId: string;
  /** Под экраном загрузки: без фокуса и ввода — Tab не уводит клавиши в скрытый стол. */
  hidden: boolean;
  onLoad: ((frame: HTMLIFrameElement) => void) | undefined;
}) {
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retry.current), []);

  return (
    <iframe
      title="Игра"
      src={`/stream/${sessionId}/`}
      allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write"
      inert={hidden}
      aria-hidden={hidden || undefined}
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
  onPlayAgain,
  QrLogin = SteamQrLogin,
}: {
  view: SessionView;
  /** Пользователь подтвердил «Выйти из игры». */
  onExit: () => void;
  /** «Я здесь» на предупреждении о простое. */
  onHere: () => void;
  onLibrary: () => void;
  /** Документ стрима загружен (на каждую загрузку iframe). */
  onFrameLoad?: (frame: HTMLIFrameElement) => void;
  /** Установщик не дождался входа в Steam: «Готово» на экране QR запускает игру заново. */
  onPlayAgain: () => void;
  QrLogin?: SteamQrLoginComponent;
}) {
  // «Показать экран» — до конца сессии на этой странице (состояние клиента, §4.4).
  // Хранится id сессии: «Играть снова» уводит на новую сессию в том же `Player`.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const stream = showsStream(view);
  // Открыть можно только готовую трансляцию — без неё снова экран загрузки.
  const loading = showsLoading(view, revealedId === view.id && stream);
  useLoadingTick(loading);
  // В текущем этапе — с последней смены `state`/`stage`/`installStage`; в
  // состоянии — смена этапа внутри `playing` отсчёт не сбрасывает.
  const msInStage = useMsSince(
    `${view.id}/${view.state}/${view.stage}/${view.installStage}`,
  );
  const msInState = useMsSince(`${view.id}/${view.state}`);

  if (!stream && !loading) {
    return (
      <SessionStatus
        view={view}
        onLibrary={onLibrary}
        onPlayAgain={onPlayAgain}
        QrLogin={QrLogin}
      />
    );
  }

  // Порядок детей постоянный: iframe первым — React не пересоздаёт его при смене
  // состояния и при снятии экрана загрузки, и стрим не переподключается.
  return (
    <main className="fixed inset-0 bg-black">
      {stream && (
        <StreamFrame
          sessionId={view.id}
          hidden={loading}
          onLoad={onFrameLoad}
        />
      )}
      {loading && (
        <LoadingScreen
          view={view}
          msInStage={msInStage}
          msPlaying={view.state === "playing" ? msInState : 0}
          onCancel={onExit}
          onReveal={stream ? () => setRevealedId(view.id) : undefined}
        />
      )}
      {!loading &&
        view.state === "idle_warning" &&
        view.idleDeadline !== null && (
          <IdlePrompt deadline={view.idleDeadline} onHere={onHere} />
        )}
      {!loading && <ExitButton onExit={onExit} />}
    </main>
  );
}
