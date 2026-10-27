// Страница игры `/app/game/<appId>` (спека 2026-10-27 §3.5): шапка, слева медиа,
// описание и достижения, справа совместимость, факты и сессии. Правой колонки
// `AppShell` здесь нет — средняя занимает всю ширину. Рисует всё, что знает: без
// `details` остаются шапка, совместимость, ссылка на Steam и короткая заметка.
// `GameNotFound` — экран «Этой игры нет в твоей библиотеке».
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Gamepad2 } from "lucide-react";
import { StickySlot } from "@/components/app/AppShell";
import { Panel } from "@/components/app/Panel";
import { CompatPanel } from "@/components/app/game/CompatPanel";
import { FactsPanel } from "@/components/app/game/FactsPanel";
import { GameHero, HeroButton } from "@/components/app/game/GameHero";
import { SessionsPanel } from "@/components/app/game/SessionsPanel";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cardAction } from "@/lib/cardAction";
import { usePlaySession } from "@/lib/usePlaySession";
import { useStalled } from "@/lib/useStalled";
import { gameAtom, resultErrorTag } from "@/rpc";

function GameSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-[180px] rounded-[18px] md:h-[280px]" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Skeleton className="h-64 rounded-[20px]" />
        <Skeleton className="h-64 rounded-[20px]" />
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Gamepad2 className="size-6" />
      </div>
      <p className="text-lg font-medium">Этой игры нет в твоей библиотеке</p>
      <Button asChild>
        <Link to="/app">К моим играм</Link>
      </Button>
    </div>
  );
}

export function GamePage({ appId }: { appId: number }) {
  const atom = gameAtom(appId);
  const result = useAtomValue(atom);
  const reload = useAtomRefresh(atom);
  const [stalled, restartWait] = useStalled(AsyncResult.isInitial(result));
  const { play } = usePlaySession();
  const now = new Date();

  if (resultErrorTag(result) === "GameNotFound") return <NotFound />;
  if (AsyncResult.isFailure(result) || stalled)
    return (
      <ServerUnreachable
        onRetry={() => {
          restartWait();
          reload();
        }}
      />
    );
  if (!AsyncResult.isSuccess(result)) return <GameSkeleton />;

  const game = result.value;
  const action = game.inLibrary ? cardAction(game, play) : null;

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/app"
        className="w-fit text-sm text-[#8a90a8] hover:text-[#eef1ff]"
      >
        ← Мои игры
      </Link>
      <GameHero game={game} action={action} now={now} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-6">
          {game.details === null && (
            <Panel>
              <p className="text-sm text-[#8a90a8]">
                Steam не дал описание этой игры
              </p>
            </Panel>
          )}
        </div>
        <div className="flex flex-col gap-6">
          <CompatPanel game={game} />
          <FactsPanel game={game} />
          {game.inLibrary && <SessionsPanel game={game} now={now} />}
        </div>
      </div>
      {action !== null && (
        <StickySlot>
          <div className="px-3 pb-2">
            <HeroButton game={game} action={action} className="w-full" />
          </div>
        </StickySlot>
      )}
    </div>
  );
}
