// `/app`: главная после входа — сетка AppShell (полоска разделов/нижняя панель)
// и дочерние маршруты: «Мои игры», «В тренде», «Из ящика», «Время», страница игры.
import { useAtomValue } from "@effect/atom-react";
import {
  createRoute,
  Navigate,
  Outlet,
  redirect,
  useMatchRoute,
} from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { AppShell } from "@/components/app/AppShell";
import { CratePage } from "@/components/app/CratePage";
import { GamePage } from "@/components/app/game/GamePage";
import { MyGamesPage } from "@/components/app/MyGamesPage";
import { TimePage } from "@/components/app/TimePage";
import { TrendingPage } from "@/components/app/TrendingPage";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { parseSearch, toSearch } from "@/lib/libraryFilters";
import { useStalled } from "@/lib/useStalled";
import { meAtom, resultErrorTag } from "@/rpc";
import { rootRoute } from "./__root";

function AppLayout() {
  const me = useAtomValue(meAtom);
  const [stalled, restartWait] = useStalled(AsyncResult.isInitial(me));
  // Страница игры — без правой колонки: ей нечего туда класть, а пустое место мешало.
  const wide = useMatchRoute()({ to: "/app/game/$appId" }) !== false;

  if (resultErrorTag(me) === "Unauthorized") {
    return <Navigate to="/login" search={{ next: window.location.pathname }} />;
  }

  if (AsyncResult.isFailure(me) || stalled) {
    return <ServerUnreachable onRetry={restartWait} />;
  }

  if (!AsyncResult.isSuccess(me)) return null;

  return (
    <AppShell user={me.value} wide={wide}>
      <Outlet />
    </AppShell>
  );
}

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: AppLayout,
});

/**
 * Поля фильтров библиотеки (`lib/libraryFilters.ts`) плюс `focus` (фокус на поле
 * поиска — ссылка «Поиск» в полоске разделов) и `error` (ошибка привязки Steam,
 * возвращается в `errorCallbackURL` у `linkSteam("/app")`; старый `/library?error=...`
 * редиректит сюда же, см. `routes/library.tsx`).
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
  // Чип «Играть бесплатно» был фильтром `?status=free`; свои игры переехали на
  // «Из ящика», старые ссылки ведут туда. `validateSearch` такой статус уже отбросил —
  // смотрим в сырую строку адреса.
  beforeLoad: ({ location }) => {
    if (new URLSearchParams(location.searchStr).get("status") === "free") {
      throw redirect({ to: "/app/crate", replace: true });
    }
  },
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

/**
 * Страница игры `/app/game/$appId` (спека 2026-10-27 §3.5). `appId` разбирается в
 * число в `params.parse`; нечисло или не положительное — редирект на `/app`.
 */
function GameRoutePage() {
  const { appId } = appGameRoute.useParams();
  if (!Number.isInteger(appId) || appId <= 0) return <Navigate to="/app" />;
  return <GamePage appId={appId} />;
}

export const appGameRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/game/$appId",
  params: {
    parse: ({ appId }) => ({ appId: Number(appId) }),
    stringify: ({ appId }) => ({ appId: String(appId) }),
  },
  component: GameRoutePage,
});
