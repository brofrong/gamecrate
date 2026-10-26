// `/session/$id`: экран игры. Состояние — поток `session.watch`; пока страница открыта и
// сессия активна — heartbeat каждые 5 с с `inputAgeMs` (мс с последнего ввода).
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { isTerminalSessionState, maxInputAgeMs } from "@cg/rpc";
import { createRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FullscreenLoader } from "@/components/FullscreenLoader";
import { Player } from "@/components/Player";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { SessionMissing } from "@/components/SessionStatus";
import { Button } from "@/components/ui/button";
import { useInputActivity } from "@/lib/inputActivity";
import { useStalled } from "@/lib/useStalled";
import {
  errorTag,
  heartbeatAtom,
  resultErrorTag,
  sessionWatchAtom,
  startSessionArgs,
  startSessionAtom,
  stopSessionAtom,
} from "@/rpc";
import { rootRoute } from "./__root";

/** Период heartbeat (сервер ждёт не реже чем раз в 30 с). */
export const HEARTBEAT_MS = 5_000;

/**
 * `onPlayAgain` для `SessionStatus`/`Player`: запускает ту же игру заново (§3.2,
 * «Готово» на экране QR после пропавшего входа) и переходит на новую сессию.
 * Выделено в чистую функцию — зависимости (`start`/`navigate`) подаются явно,
 * так тест может подставить фейковый RPC-клиент и фейковую навигацию без рендера
 * всего маршрута (которому для этого нужен настоящий сокет `@/rpc`).
 */
export const playAgain = async (
  appId: number,
  deps: {
    readonly start: (
      args: ReturnType<typeof startSessionArgs>,
    ) => Promise<Exit.Exit<{ readonly id: string }, { readonly _tag: string }>>;
    readonly navigate: (to: {
      readonly to: "/session/$id";
      readonly params: { readonly id: string };
    }) => void;
  },
): Promise<void> => {
  const exit = await deps.start(startSessionArgs(appId));
  if (Exit.isSuccess(exit)) {
    deps.navigate({ to: "/session/$id", params: { id: exit.value.id } });
    return;
  }
  const tag = errorTag(exit.cause);
  if (tag === "Unauthorized") {
    window.location.assign("/");
    return;
  }
  toast.error("Не удалось начать игру. Попробуйте ещё раз.");
};

/** Пауза перед переподпиской на `session.watch` после обрыва сокета. */
const RESUBSCRIBE_MS = 2_000;

/**
 * Heartbeat каждые `HEARTBEAT_MS`, пока `enabled`, и сразу при включении.
 * `SessionNotFound` — сессия закончилась или чужая: больше не шлём.
 * Возвращает «послать сейчас».
 */
function useHeartbeat(
  sessionId: string,
  enabled: boolean,
  inputAgeMs: () => number,
) {
  const send = useAtomSet(heartbeatAtom, { mode: "promiseExit" });
  const [gone, setGone] = useState(false);
  const active = enabled && !gone;

  const beat = useCallback(async () => {
    const age = Math.min(inputAgeMs(), maxInputAgeMs);
    const exit = await send({ payload: { sessionId, inputAgeMs: age } });
    if (Exit.isFailure(exit) && errorTag(exit.cause) === "SessionNotFound") {
      setGone(true);
    }
  }, [send, sessionId, inputAgeMs]);

  useEffect(() => {
    if (!active) return;
    void beat();
    // Скрытая вкладка тоже шлёт: браузер может реже будить таймер — это нормально.
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [active, beat]);

  return useCallback(() => {
    if (active) void beat();
  }, [active, beat]);
}

function SessionPage() {
  const { id } = sessionRoute.useParams();
  const navigate = useNavigate();
  const watchAtom = sessionWatchAtom(id);
  const watch = useAtomValue(watchAtom);
  const resubscribe = useAtomRefresh(watchAtom);
  const stop = useAtomSet(stopSessionAtom, { mode: "promiseExit" });
  const start = useAtomSet(startSessionAtom, { mode: "promiseExit" });
  const input = useInputActivity();

  const view = Option.getOrUndefined(AsyncResult.value(watch));
  const tag = resultErrorTag(watch);
  const notFound = tag === "SessionNotFound";
  const unauthorized = tag === "Unauthorized";
  const terminal = view !== undefined && isTerminalSessionState(view.state);
  // Поток жив (или завершился после терминального состояния) — связь в порядке.
  const connected = AsyncResult.isSuccess(watch);
  const [stalled, restartWait] = useStalled(
    !connected && !notFound && !unauthorized,
  );

  // Обрыв сокета: поток падает с RpcClientError — подписываемся заново
  // (первый элемент нового потока — текущее состояние).
  const failedTransiently =
    AsyncResult.isFailure(watch) &&
    !watch.waiting &&
    !notFound &&
    !unauthorized;
  useEffect(() => {
    if (!failedTransiently) return;
    const timer = setTimeout(resubscribe, RESUBSCRIBE_MS);
    return () => clearTimeout(timer);
  }, [failedTransiently, resubscribe]);

  const beatNow = useHeartbeat(
    id,
    view !== undefined && !terminal && !notFound,
    input.ageMs,
  );

  const toLibrary = useCallback(
    () => void navigate({ to: "/app" }),
    [navigate],
  );

  const onHere = useCallback(() => {
    input.touch();
    beatNow();
  }, [input, beatNow]);

  const onExit = useCallback(async () => {
    const exit = await stop({ payload: { sessionId: id } });
    if (Exit.isSuccess(exit)) return;
    const stopTag = errorTag(exit.cause);
    if (stopTag === "SessionNotFound") return;
    if (stopTag === "Unauthorized") {
      window.location.assign("/");
      return;
    }
    toast.error("Не удалось завершить игру. Попробуйте ещё раз.");
  }, [stop, id]);

  const onPlayAgain = useCallback(async () => {
    if (view === undefined) return;
    await playAgain(view.appId, {
      start,
      navigate: (to) => void navigate(to),
    });
  }, [start, view, navigate]);

  const retry = () => {
    restartWait();
    resubscribe();
  };

  if (unauthorized) return <Navigate to="/" />;
  if (notFound) return <SessionMissing onLibrary={toLibrary} />;
  if (view === undefined) {
    return stalled ? (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <ServerUnreachable onRetry={retry} />
      </main>
    ) : (
      <FullscreenLoader />
    );
  }

  return (
    <>
      <Player
        view={view}
        onExit={() => void onExit()}
        onHere={onHere}
        onLibrary={toLibrary}
        onFrameLoad={input.attachFrame}
        onPlayAgain={() => void onPlayAgain()}
      />
      {stalled && (
        // Стрим идёт отдельным соединением и может работать дальше — не закрываем его.
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-md border bg-background/95 px-4 py-2 text-sm shadow-lg">
            Не удалось связаться с сервером
            <Button size="sm" variant="outline" onClick={retry}>
              Повторить
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/session/$id",
  component: SessionPage,
});
