// «Из ящика» (`/app/crate`): свои игры — фанатские ПК-порты вне Steam (спека
// 2026-11-03-free-games). Сетка тех же плиток, что в «Мои игры» (`GameTile`, подпись
// «бесплатно»), по названию; клик — страница игры. Список — свои игры из
// `library.list` (api отдаёт только открытые игрокам), в «Мои игры» их нет.
import { isOwnAppId } from "@cg/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GameTile } from "@/components/app/GameTile";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { Skeleton } from "@/components/ui/skeleton";
import { libraryAtom } from "@/rpc";

const GRID_CLASS_NAME =
  "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 wide:grid-cols-5";

function CrateSkeleton() {
  return (
    <div className={GRID_CLASS_NAME}>
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={`crate-skeleton-${i}`}
          data-testid="crate-skeleton"
          className="flex flex-col gap-2"
        >
          <Skeleton className="aspect-[460/215] rounded-[14px]" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

export function CratePage() {
  const library = useAtomValue(libraryAtom);
  const reloadLibrary = useAtomRefresh(libraryAtom);

  const games = AsyncResult.isSuccess(library)
    ? library.value.entries
        .filter((entry) => isOwnAppId(entry.appId))
        .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    : [];

  return (
    <>
      <h1 className="text-2xl font-bold text-[#eef1ff]">Из ящика</h1>
      <p className="text-sm text-[#8a90a8]">
        Игры, в которые можно играть без Steam
      </p>
      {AsyncResult.isFailure(library) ? (
        <ServerUnreachable onRetry={reloadLibrary} />
      ) : !AsyncResult.isSuccess(library) ? (
        <CrateSkeleton />
      ) : games.length === 0 ? (
        <p className="text-sm text-[#8a90a8]">Пока пусто</p>
      ) : (
        <div className={GRID_CLASS_NAME}>
          {games.map((game) => (
            <GameTile key={game.appId} game={game} />
          ))}
        </div>
      )}
    </>
  );
}
