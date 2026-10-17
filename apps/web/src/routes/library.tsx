// `/library`: сетка игр пользователя, «Обновить» (синхронизация со Steam), шапка с выходом,
// запуск игры («Играть» → session.start → /session/$id) и «Вернуться в игру».
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { signInWithSteam } from "@/auth";
import { AppHeader } from "@/components/AppHeader";
import { type LibraryPlay, LibraryContent } from "@/components/LibraryContent";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useStalled } from "@/lib/useStalled";
import { cn } from "@/lib/utils";
import {
  activeSessionAtom,
  errorTag,
  libraryAtom,
  meAtom,
  refreshLibraryArgs,
  refreshLibraryAtom,
  resultErrorTag,
  startSessionArgs,
  startSessionAtom,
} from "@/rpc";
import { rootRoute } from "./__root";

function LibrarySkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
      {Array.from({ length: 14 }, (_, i) => (
        <li key={`skeleton-${i}`} className="flex flex-col gap-2">
          <Skeleton className="aspect-[2/3] rounded-lg" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </li>
      ))}
    </ul>
  );
}

function LibraryPage() {
  const me = useAtomValue(meAtom);
  const library = useAtomValue(libraryAtom);
  const reloadMe = useAtomRefresh(meAtom);
  const reloadLibrary = useAtomRefresh(libraryAtom);
  const active = useAtomValue(activeSessionAtom);
  const reloadActive = useAtomRefresh(activeSessionAtom);
  const refresh = useAtomSet(refreshLibraryAtom, { mode: "promiseExit" });
  const start = useAtomSet(startSessionAtom, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const [startingAppId, setStartingAppId] = useState<number | null>(null);
  const [stalled, restartWait] = useStalled(
    AsyncResult.isInitial(me) ||
      AsyncResult.isInitial(library) ||
      AsyncResult.isInitial(active),
  );

  if (
    resultErrorTag(me) === "Unauthorized" ||
    resultErrorTag(library) === "Unauthorized" ||
    resultErrorTag(active) === "Unauthorized"
  ) {
    return <Navigate to="/" />;
  }

  const activeSession = AsyncResult.isSuccess(active)
    ? active.value
    : undefined;
  const openSession = (id: string) =>
    void navigate({ to: "/session/$id", params: { id } });

  const onPlay = async (appId: number) => {
    setStartingAppId(appId);
    const exit = await start(startSessionArgs(appId));
    setStartingAppId(null);
    if (Exit.isSuccess(exit)) {
      openSession(exit.value.id);
      return;
    }
    const tag = errorTag(exit.cause);
    if (tag === "GameNotOwned") {
      toast.error("Эта игра не найдена в вашей библиотеке Steam");
    } else if (tag === "Unauthorized") {
      window.location.assign("/");
    } else {
      toast.error("Не удалось начать игру. Попробуйте ещё раз.");
    }
  };

  const play: LibraryPlay = {
    active: activeSession,
    startingAppId,
    onPlay: (appId) => void onPlay(appId),
    onResume: () => {
      if (activeSession) openSession(activeSession.id);
    },
  };

  const user = AsyncResult.isSuccess(me) ? me.value : undefined;
  // Любая ошибка, кроме Unauthorized, или слишком долгое ожидание — сервер недоступен.
  const unreachable =
    AsyncResult.isFailure(me) ||
    AsyncResult.isFailure(library) ||
    AsyncResult.isFailure(active) ||
    stalled;
  const retry = () => {
    restartWait();
    reloadMe();
    reloadLibrary();
    reloadActive();
  };

  const onRefresh = async () => {
    setRefreshing(true);
    const exit = await refresh(refreshLibraryArgs);
    setRefreshing(false);
    if (Exit.isSuccess(exit)) return;
    const tag = errorTag(exit.cause);
    if (tag === "SteamUnavailable") {
      toast.warning(
        "Steam сейчас недоступен, показываем сохранённую библиотеку",
      );
    } else if (tag === "Unauthorized") {
      window.location.assign("/");
    } else {
      toast.error("Не удалось обновить библиотеку");
    }
  };

  const count =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value.entries.length
      : undefined;

  return (
    <div className="min-h-dvh">
      <AppHeader user={user}>
        {activeSession && (
          <Button size="sm" onClick={() => openSession(activeSession.id)}>
            <Play />
            Вернуться в игру
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={refreshing || !AsyncResult.isSuccess(library)}
        >
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          Обновить
        </Button>
      </AppHeader>
      <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <div className="mb-6 flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">Библиотека</h1>
          {count !== undefined && count > 0 && (
            <span className="text-sm text-muted-foreground">{count}</span>
          )}
        </div>
        {unreachable ? (
          <ServerUnreachable onRetry={retry} />
        ) : user !== undefined && user.steamId === null ? (
          // Pocket ID: у админа нет Steam-аккаунта, библиотеки быть не может.
          <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
            <p className="text-lg font-medium">
              Библиотека доступна после входа через Steam
            </p>
            <Button onClick={() => void signInWithSteam()}>
              Войти через Steam
            </Button>
          </div>
        ) : AsyncResult.isSuccess(library) ? (
          <LibraryContent
            view={library.value}
            onRefresh={() => void onRefresh()}
            refreshing={refreshing}
            play={play}
          />
        ) : (
          <LibrarySkeleton />
        )}
      </main>
    </div>
  );
}

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryPage,
});
