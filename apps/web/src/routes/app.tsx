// `/app`: новая главная после входа — сетка AppShell (полоска разделов/нижняя панель)
// и четыре дочерних маршрута. Страницы под ними — заглушки (`data-testid`), контент
// добавят следующие задачи; этот каркас отвечает только за авторизацию и вёрстку.
import { useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate, Outlet } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { AppShell } from "@/components/app/AppShell";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { useStalled } from "@/lib/useStalled";
import { meAtom, resultErrorTag } from "@/rpc";
import { rootRoute } from "./__root";

function AppLayout() {
  const me = useAtomValue(meAtom);
  const [stalled, restartWait] = useStalled(AsyncResult.isInitial(me));

  if (resultErrorTag(me) === "Unauthorized") {
    return <Navigate to="/login" search={{ next: window.location.pathname }} />;
  }

  if (AsyncResult.isFailure(me) || stalled) {
    return <ServerUnreachable onRetry={restartWait} />;
  }

  if (!AsyncResult.isSuccess(me)) return null;

  return (
    <AppShell user={me.value}>
      <Outlet />
    </AppShell>
  );
}

function MyGamesPage() {
  return <div data-testid="my-games" />;
}

function TrendingPage() {
  return <div data-testid="trending" />;
}

function CratePage() {
  return <div data-testid="crate" />;
}

function TimePage() {
  return <div data-testid="time" />;
}

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: AppLayout,
});

/** Поля фильтров библиотеки (см. `lib/libraryFilters.ts`), здесь — только как строки URL. */
type AppIndexSearch = Partial<
  Record<"status" | "sort" | "proton" | "chips" | "q", string>
> & { focus?: "q" };

function toOptionalStrings(
  search: Record<string, unknown>,
): Partial<Record<"status" | "sort" | "proton" | "chips" | "q", string>> {
  const out: Partial<
    Record<"status" | "sort" | "proton" | "chips" | "q", string>
  > = {};
  for (const key of ["status", "sort", "proton", "chips", "q"] as const) {
    const value = search[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  // Полный разбор (`parseSearch`) — у страницы-заглушки, когда добавят фильтры (следующая задача).
  validateSearch: (search: Record<string, unknown>): AppIndexSearch => ({
    ...toOptionalStrings(search),
    ...(search.focus === "q" ? { focus: "q" as const } : {}),
  }),
  component: MyGamesPage,
});

export const appTrendingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/trending",
  component: TrendingPage,
});

export const appCrateRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/crate",
  component: CratePage,
});

export const appTimeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/time",
  validateSearch: (search: Record<string, unknown>): { month?: string } =>
    typeof search.month === "string" ? { month: search.month } : {},
  component: TimePage,
});
