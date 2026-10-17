// `/library`: сетка игр пользователя, «Обновить» (синхронизация со Steam), шапка с выходом.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate } from "@tanstack/react-router";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { signInWithSteam } from "@/auth";
import { AppHeader } from "@/components/AppHeader";
import { LibraryContent } from "@/components/LibraryContent";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  errorTag,
  libraryAtom,
  meAtom,
  refreshLibraryArgs,
  refreshLibraryAtom,
  resultErrorTag,
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
  const reload = useAtomRefresh(libraryAtom);
  const refresh = useAtomSet(refreshLibraryAtom, { mode: "promiseExit" });
  const [refreshing, setRefreshing] = useState(false);

  if (
    resultErrorTag(me) === "Unauthorized" ||
    resultErrorTag(library) === "Unauthorized"
  ) {
    return <Navigate to="/" />;
  }

  const user = AsyncResult.isSuccess(me) ? me.value : undefined;

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
        {user !== undefined && user.steamId === null ? (
          // Pocket ID: у админа нет Steam-аккаунта, библиотеки быть не может.
          <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
            <p className="text-lg font-medium">
              Библиотека доступна после входа через Steam
            </p>
            <Button onClick={() => void signInWithSteam()}>
              Войти через Steam
            </Button>
          </div>
        ) : (
          AsyncResult.match(library, {
            onInitial: () => <LibrarySkeleton />,
            onFailure: () => (
              <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
                <p className="text-lg font-medium">
                  Не удалось загрузить библиотеку
                </p>
                <Button onClick={reload}>Повторить</Button>
              </div>
            ),
            onSuccess: ({ value }) => (
              <LibraryContent
                view={value}
                onRefresh={() => void onRefresh()}
                refreshing={refreshing}
              />
            ),
          })
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
