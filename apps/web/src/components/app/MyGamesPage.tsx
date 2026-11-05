// «Мои игры» (`/app`, спека §4.2 и 2026-10-27 §3.3–3.4) — главная страница после
// входа: заголовок со сводкой, строка поиска с кнопкой «Фильтры» (панель на десктопе,
// шторка на телефоне) и чипы,
// «Запускал недавно» (те же плитки, подпись — дата · длительность), секции сетки по
// статусу облака по 24 плитки с «Показать ещё» (сброс раскрытия — `key` секции от
// фильтров). Фильтры живут в адресе маршрута (`?status=...`), адрес с фильтром
// переживает перезагрузку страницы. Своих игр в сетке нет — они на «Из ящика»
// (`/app/crate`), здесь — только в «Запускал недавно»; игроку без Steam под «Подключите
// Steam» ссылка туда, если открытые свои игры есть.
import { isOwnAppId, type LibraryView } from "@cg/rpc";
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
  libraryGames,
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

  const allEntries = AsyncResult.isSuccess(library)
    ? library.value.entries
    : [];
  const entries = libraryGames(allEntries);
  const hasOwnGames = allEntries.some((entry) => isOwnAppId(entry.appId));
  const steamProfile =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value.steamProfile
      : false;
  const total = entries.length;
  const readyCount = entries.filter(
    (entry) => entry.cloud._tag === "Ready",
  ).length;
  const syncedAt =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value.syncedAt
      : null;
  const readyLibrary =
    AsyncResult.isSuccess(library) && library.value._tag === "Ready"
      ? library.value
      : undefined;

  const hasRecent =
    filters.q.trim().length === 0 &&
    AsyncResult.isSuccess(recent) &&
    recent.value.length > 0;

  // «Запускал недавно» и секции сетки: и для обычной библиотеки, и над
  // «Подключите Steam»/заметкой о закрытом профиле (там — только недавние).
  const grid = (
    <>
      {hasRecent && AsyncResult.isSuccess(recent) && (
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
      {applyFilters(entries, filters, { steamProfile }).map((group) => (
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
  );

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
        countFor={(f) => countMatching(entries, f, { steamProfile })}
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
        <>
          {hasRecent && grid}
          <ConnectSteam
            onDone={() => {
              reloadMe();
              void onRefresh();
            }}
          />
          {hasOwnGames && (
            <Link
              to="/app/crate"
              className="mx-auto text-sm font-medium text-[#3cc2ff] hover:text-[#eef1ff]"
            >
              Без Steam можно играть в играх «Из ящика» →
            </Link>
          )}
        </>
      ) : !AsyncResult.isSuccess(library) ? (
        <LibrarySkeleton />
      ) : library.value._tag === "Private" ? (
        <>
          {hasRecent && grid}
          <PrivateProfile
            onRefresh={() => void onRefresh()}
            refreshing={refreshing}
          />
        </>
      ) : entries.length === 0 && !hasRecent ? (
        <EmptyNotice
          view={library.value}
          onRefresh={() => void onRefresh()}
          refreshing={refreshing}
        />
      ) : (
        grid
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
      {/* От md до xl правой колонки нет — её панели под списком, который догружается при
          прокрутке, и до «Сессии» не докрутить (владелец, 2026-11-05). Там та же компактная
          карточка, что на телефоне, — закреплена внизу экрана; распорка не даёт ей закрыть
          последние плитки. */}
      {activeSession && (
        <>
          <div aria-hidden className="hidden h-16 md:block xl:hidden" />
          <div
            data-testid="tablet-session"
            className="fixed right-3 bottom-4 z-40 hidden w-[380px] md:block xl:hidden"
          >
            <ActiveSessionPanel
              session={activeSession}
              onResume={play.onResume}
              compact
            />
          </div>
        </>
      )}
    </>
  );
}
