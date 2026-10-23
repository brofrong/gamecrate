// `/app`: новая главная после входа — сетка AppShell (полоска разделов/нижняя панель)
// и четыре дочерних маршрута. «Мои игры» — страница целиком (Task 10); «В тренде»,
// «Из ящика», «Время» — пока заглушки (`data-testid`), их содержимое добавит Task 12.
import { useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate, Outlet } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { AppShell } from "@/components/app/AppShell";
import { MyGamesPage } from "@/components/app/MyGamesPage";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { parseSearch, toSearch } from "@/lib/libraryFilters";
import { useStalled } from "@/lib/useStalled";
import { activeSessionAtom, meAtom, resultErrorTag } from "@/rpc";
import { rootRoute } from "./__root";

function AppLayout() {
  const me = useAtomValue(meAtom);
  const active = useAtomValue(activeSessionAtom);
  const [stalled, restartWait] = useStalled(AsyncResult.isInitial(me));

  if (resultErrorTag(me) === "Unauthorized") {
    return <Navigate to="/login" search={{ next: window.location.pathname }} />;
  }

  if (AsyncResult.isFailure(me) || stalled) {
    return <ServerUnreachable onRetry={restartWait} />;
  }

  if (!AsyncResult.isSuccess(me)) return null;

  const session = AsyncResult.isSuccess(active) ? active.value : null;

  return (
    <AppShell user={me.value} installing={session?.state === "installing"}>
      <Outlet />
    </AppShell>
  );
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

/**
 * Поля фильтров библиотеки (`lib/libraryFilters.ts`) плюс `focus` (фокус на поле
 * поиска — ссылка «Поиск» в полоске разделов) и `error` (ошибка привязки Steam,
 * возвращается в `errorCallbackURL` у `linkSteam("/app")`, см. `routes/library.tsx`).
 * Поля фильтров — `string | undefined` (не `Filters`): это ровно то, что несёт URL —
 * `chips` в адресе — одна строка через запятую (`toSearch`), а не массив. TanStack
 * Router держит адрес синхронным с тем, что вернул `validateSearch`, поэтому «пустой
 * адрес = фильтров нет» (спека §4.2) требует не писать в объект поля, равные
 * умолчанию — иначе бывший `/app` стал бы `/app?status=all&sort=recent&...` при
 * каждом заходе. `toSearch(parseSearch(search))` ровно это и даёт: валидирует через
 * `parseSearch`, затем оставляет только поля, отличные от `DEFAULT_FILTERS` (как и
 * при записи фильтров из `FilterBar`/`FilterSheet`) — без приведения типов, раз сам
 * тип честно строковый. Читатели (`MyGamesPage`) собирают полные `Filters` через
 * `parseSearch(search)`.
 */
type AppIndexSearch = Partial<
  Record<"status" | "sort" | "proton" | "chips" | "q", string>
> & {
  focus?: "q";
  error?: string;
};

export const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): AppIndexSearch => ({
    ...toSearch(parseSearch(search)),
    ...(search.focus === "q" ? { focus: "q" as const } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
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
