// `/library`: сетка игр пользователя, «Обновить» (синхронизация со Steam), шапка с выходом,
// запуск игры («Играть» → session.start → /session/$id), «Вернуться в игру» и привязка
// Steam для пользователя без него (`ConnectSteam`); `?error=` из привязки — тост один раз.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppHeader } from "@/components/AppHeader";
import { type LibraryPlay, LibraryContent } from "@/components/LibraryContent";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import {
  SteamQrLogin,
  SteamQrLoginDialog,
  type SteamQrLoginComponent,
} from "@/components/SteamQrLogin";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { authErrorMessage } from "@/lib/authErrors";
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

/**
 * Карточка для пользователя без привязанного Steam: без него библиотека пуста.
 * Кнопка открывает `SteamQrLogin` в модальном окне вместо старой OpenID-привязки.
 * `QrLogin` — только для тестов (подмена настоящего компонента фейком).
 */
export function ConnectSteam({
  onDone,
  QrLogin = SteamQrLogin,
}: {
  onDone: () => void;
  QrLogin?: SteamQrLoginComponent;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <p className="text-lg font-medium">Подключите Steam</p>
      <p className="text-sm text-muted-foreground">
        Мы не просим пароль: Steam сам подтвердит, что аккаунт твой
      </p>
      <Button onClick={() => setOpen(true)}>Подключить Steam</Button>
      <SteamQrLoginDialog
        open={open}
        title="Подключите Steam"
        onDone={() => {
          setOpen(false);
          onDone();
        }}
        QrLogin={QrLogin}
      />
    </div>
  );
}

function LibraryPage() {
  const { error } = libraryRoute.useSearch();
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

  // Тост об ошибке привязки показываем один раз, на монтаж.
  useEffect(() => {
    if (error !== undefined) toast.error(authErrorMessage(error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <ConnectSteam
            onDone={() => {
              reloadMe();
              void refresh(refreshLibraryArgs);
            }}
          />
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
  // Better Auth возвращает ошибку привязки Steam как `/library?error=...` (errorCallbackURL).
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  component: LibraryPage,
});
