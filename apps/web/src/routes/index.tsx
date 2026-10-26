// `/`: лендинг; вошедшего пользователя уводим на главную `/app`.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import type { CurrentUserShape } from "@cg/rpc";
import { FullscreenLoader } from "@/components/FullscreenLoader";
import { LandingPage } from "@/components/landing/LandingPage";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { useStalled } from "@/lib/useStalled";
import { meAtom, resultErrorTag } from "@/rpc";
import { rootRoute } from "./__root";

/** Какой экран показать по состоянию `auth.me` и флагу «ждём слишком долго». */
export const indexView = (
  me: AsyncResult.AsyncResult<CurrentUserShape, { readonly _tag: string }>,
  stalled: boolean,
): "library" | "landing" | "unreachable" | "loading" => {
  if (AsyncResult.isSuccess(me)) return "library";
  if (resultErrorTag(me) === "Unauthorized") return "landing";
  // Любая другая ошибка или слишком долгое ожидание — сервер недоступен.
  if (AsyncResult.isFailure(me) || stalled) return "unreachable";
  return "loading";
};

function IndexPage() {
  const me = useAtomValue(meAtom);
  const refreshMe = useAtomRefresh(meAtom);
  const [stalled, restartWait] = useStalled(AsyncResult.isInitial(me));

  const view = indexView(me, stalled);
  if (view === "library") return <Navigate to="/app" />;
  if (view === "landing") return <LandingPage />;
  if (view === "unreachable") {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <ServerUnreachable
          onRetry={() => {
            restartWait();
            refreshMe();
          }}
        />
      </main>
    );
  }
  return <FullscreenLoader />;
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});
