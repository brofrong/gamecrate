// «Мои игры» (`/app`, спека §4.2 и 2026-10-27 §3.3–3.4) — главная страница после
// входа: заголовок со сводкой, строка поиска с кнопкой «Фильтры» (панель на десктопе,
// шторка на телефоне) и чипы,
// «Запускал недавно» (те же плитки, подпись — дата · длительность), секции сетки по
// статусу облака по 24 плитки с «Показать ещё» (сброс раскрытия — `key` секции от
// фильтров). Фильтры живут в адресе маршрута (`?status=...`), адрес с фильтром
// переживает перезагрузку страницы.
import type { LibraryView } from "@cg/rpc";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { CloudOff, Gamepad2 } from "lucide-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ActiveSessionPanel } from "@/components/app/ActiveSessionPanel";
import { AsideSlot, StickySlot } from "@/components/app/AppShell";
import { ComingSoonPanel } from "@/components/app/ComingSoonPanel";
import { ConnectSteam } from "@/components/app/ConnectSteam";
import { FilterBar } from "@/components/app/FilterBar";
import { FilterSheet } from "@/components/app/FilterSheet";
import { GameSection, SECTION_PAGE } from "@/components/app/GameSection";
import { GameTile } from "@/components/app/GameTile";
import { InstallsPanel } from "@/components/app/InstallsPanel";
import { SteamPanel } from "@/components/app/SteamPanel";
import { SummaryStrip } from "@/components/app/SummaryStrip";
import { TimePanel } from "@/components/app/TimePanel";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { PrivateProfile } from "@/components/PrivateProfile";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { authErrorMessage } from "@/lib/authErrors";
import { currentMonth, formatRelativeDate } from "@/lib/formatTime";
import { recentCaption } from "@/lib/tileValue";
import {
  applyFilters,
  countMatching,
  type Filters,
  parseSearch,
  type Section,
  toSearch,
} from "@/lib/libraryFilters";
import { usePlaySession } from "@/lib/usePlaySession";
import { useStalled } from "@/lib/useStalled";
import {
  activeSessionAtom,
  errorTag,
  libraryAtom,
  meAtom,
  recentAtom,
  refreshLibraryArgs,
  refreshLibraryAtom,
  timeSummaryAtom,
} from "@/rpc";
import { appIndexRoute } from "@/routes/app";

const SECTION_TITLES: Record<Section, string> = {
  ready: "Готовы к запуску",
  installing: "Нужна установка",
  noprofile: "Нужен вход в Steam",
};

/** Пока `library.list` не ответил — заглушка в форме секции сетки, не пустой экран. */
function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={`skeleton-${i}`} className="flex flex-col gap-2">
          <Skeleton className="aspect-[460/215] rounded-[14px]" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** Пустая библиотека: Steam недоступен (ещё не было синхронизации) или игр пока нет. */
function EmptyNotice({
  view,
  onRefresh,
  refreshing,
}: {
  view: LibraryView & { _tag: "Ready" };
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (view.syncedAt === null) {
    return (
      <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <CloudOff className="size-6" />
        </div>
        <p className="text-lg font-medium">
          Steam сейчас недоступен. Попробуйте обновить позже.
        </p>
        <Button onClick={onRefresh} disabled={refreshing}>
          Обновить
        </Button>
      </div>
    );
  }
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Gamepad2 className="size-6" />
      </div>
      <p className="text-lg font-medium">В библиотеке пока нет игр</p>
      <p className="text-sm text-muted-foreground">
        Купленные в Steam игры появятся здесь после обновления.
      </p>
    </div>
  );
}

export function MyGamesPage() {
  const search = appIndexRoute.useSearch();
  const navigate = appIndexRoute.useNavigate();

  const me = useAtomValue(meAtom);
  const reloadMe = useAtomRefresh(meAtom);
  const library = useAtomValue(libraryAtom);
  const reloadLibrary = useAtomRefresh(libraryAtom);
  const recent = useAtomValue(recentAtom);
  const reloadRecent = useAtomRefresh(recentAtom);
  const reloadActive = useAtomRefresh(activeSessionAtom);
  const summary = useAtomValue(timeSummaryAtom(currentMonth(new Date())));
  const refresh = useAtomSet(refreshLibraryAtom, { mode: "promiseExit" });
  const { active, activeSession, play } = usePlaySession();

  const [refreshing, setRefreshing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [stalled, restartWait] = useStalled(
    AsyncResult.isInitial(library) ||
      AsyncResult.isInitial(recent) ||
      AsyncResult.isInitial(active),
  );

  // Тост об ошибке привязки Steam (`?error=`) показываем один раз, на монтаж.
  useEffect(() => {
    if (search.error !== undefined) toast.error(authErrorMessage(search.error));
    // eslint-disable-next-line react/exhaustive-deps
  }, []);

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

  // `search` объявлен частично опциональным типом (иначе `<Link to="/app" search={{...}}>`
  // в `Rail`/`BottomTabs` требовал бы все поля сразу) — `validateSearch` на самом деле
  // всегда возвращает их все через `parseSearch`; прогоняем через него же здесь, это no-op.
  const filters: Filters = parseSearch(search);
  // Смена фильтров пересоздаёт секции — раскрытие «Показать ещё» сбрасывается.
  const filtersKey = JSON.stringify(toSearch(filters));

  const onFiltersChange = (next: Filters) => {
    void navigate({ search: () => toSearch(next), replace: true });
  };

  const user = AsyncResult.isSuccess(me) ? me.value : undefined;
  if (user === undefined) return null;

  const unreachable =
    AsyncResult.isFailure(library) ||
    AsyncResult.isFailure(recent) ||
    AsyncResult.isFailure(active) ||
    stalled;

  const total =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value.entries.length
      : 0;
  const readyCount =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value.entries.filter((entry) => entry.cloud._tag === "Ready")
          .length
      : 0;
  const syncedAt =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value.syncedAt
      : null;
  const readyLibrary =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value
      : undefined;

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold text-[#eef1ff]">Мои игры</h1>
        {AsyncResult.isSuccess(library) && library.value._tag === "Ready" && (
          <span className="text-sm text-[#8a90a8]">
            {total} игр · {readyCount} готовы ·{" "}
            {syncedAt === null
              ? "ещё не обновлялась"
              : `обновлено ${formatRelativeDate(syncedAt, new Date())}`}
          </span>
        )}
      </div>

      <FilterBar
        filters={filters}
        onChange={onFiltersChange}
        onOpenSheet={() => setSheetOpen(true)}
        total={total}
        focusSearch={search.focus === "q"}
      />

      <FilterSheet
        open={sheetOpen}
        filters={filters}
        onApply={onFiltersChange}
        onClose={() => setSheetOpen(false)}
        countFor={(f) =>
          AsyncResult.isSuccess(library) && library.value._tag === "Ready"
            ? countMatching(library.value.entries, f, {
                steamProfile: library.value.steamProfile,
              })
            : 0
        }
      />

      <SummaryStrip
        user={user}
        view={readyLibrary}
        monthMinutes={
          AsyncResult.isSuccess(summary) ? summary.value.totalMinutes : 0
        }
        activeSession={activeSession ?? null}
      />

      {unreachable ? (
        <ServerUnreachable
          onRetry={() => {
            restartWait();
            reloadLibrary();
            reloadRecent();
            reloadActive();
          }}
        />
      ) : user.steamId === null ? (
        <ConnectSteam
          onDone={() => {
            reloadMe();
            void onRefresh();
          }}
        />
      ) : !AsyncResult.isSuccess(library) ? (
        <LibrarySkeleton />
      ) : library.value._tag === "Private" ? (
        <PrivateProfile
          onRefresh={() => void onRefresh()}
          refreshing={refreshing}
        />
      ) : library.value.entries.length === 0 ? (
        <EmptyNotice
          view={library.value}
          onRefresh={() => void onRefresh()}
          refreshing={refreshing}
        />
      ) : (
        <>
          {filters.q.trim().length === 0 &&
            AsyncResult.isSuccess(recent) &&
            recent.value.length > 0 && (
              <GameSection
                title="Запускал недавно"
                count={recent.value.length}
                scroll
                action={
                  <Link
                    to="/app/time"
                    className="text-sm font-medium text-[#8a90a8] hover:text-[#eef1ff]"
                  >
                    все сессии →
                  </Link>
                }
              >
                {recent.value.map((entry) => (
                  <GameTile
                    key={entry.appId}
                    game={entry}
                    caption={recentCaption(entry, new Date())}
                  />
                ))}
              </GameSection>
            )}
          {applyFilters(library.value.entries, filters, {
            steamProfile: library.value.steamProfile,
          }).map((group) => (
            <GameSection
              key={`${group.section}:${filtersKey}`}
              title={SECTION_TITLES[group.section]}
              count={group.entries.length}
              limit={SECTION_PAGE}
            >
              {group.entries.map((entry) => (
                <GameTile
                  key={entry.appId}
                  game={entry}
                  dimmed={group.section === "noprofile"}
                />
              ))}
            </GameSection>
          ))}
        </>
      )}

      <AsideSlot>
        <SteamPanel
          user={user}
          view={readyLibrary}
          onRefresh={() => void onRefresh()}
          refreshing={refreshing}
          onConnected={() => {
            reloadMe();
            void onRefresh();
          }}
        />
        {activeSession && (
          <ActiveSessionPanel
            session={activeSession}
            onResume={play.onResume}
          />
        )}
        <TimePanel
          summary={AsyncResult.isSuccess(summary) ? summary.value : undefined}
        />
        {activeSession && <InstallsPanel session={activeSession} />}
        <ComingSoonPanel name="Epic Games" />
      </AsideSlot>
      <StickySlot>
        {activeSession && (
          <ActiveSessionPanel
            session={activeSession}
            onResume={play.onResume}
            compact
          />
        )}
      </StickySlot>
    </>
  );
}
