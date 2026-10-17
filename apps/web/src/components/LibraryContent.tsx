// Содержимое /library по `LibraryView`: приватный профиль, Steam недоступен, пусто или сетка игр.
import type { LibraryEntry, LibraryView, SessionView } from "@cg/rpc";
import { CloudOff, Gamepad2 } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { type CardAction, GameCard } from "./GameCard";
import { PrivateProfile } from "./PrivateProfile";

/** Запуск игр из библиотеки. */
export type LibraryPlay = {
  /** Активная сессия пользователя; `undefined` — ещё не загружена. */
  readonly active: SessionView | null | undefined;
  /** Игра, для которой сейчас выполняется `session.start`. */
  readonly startingAppId: number | null;
  readonly onPlay: (appId: number) => void;
  /** Перейти к активной сессии. */
  readonly onResume: () => void;
};

type Props = {
  view: LibraryView;
  onRefresh: () => void;
  refreshing: boolean;
  play: LibraryPlay;
};

/** Одна активная сессия на пользователя: у её игры — «Вернуться в игру», у остальных «Играть» неактивна. */
export function cardAction(game: LibraryEntry, play: LibraryPlay): CardAction {
  const { active, startingAppId } = play;
  if (active && active.appId === game.appId) {
    return { kind: "resume", onResume: play.onResume };
  }
  if (active) return { kind: "blocked" };
  return {
    kind: "play",
    pending: startingAppId === game.appId,
    disabled: active === undefined || startingAppId !== null,
    onPlay: () => play.onPlay(game.appId),
  };
}

function Notice({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        {icon}
      </div>
      <p className="text-lg font-medium">{title}</p>
      {children}
    </div>
  );
}

export function LibraryContent({ view, onRefresh, refreshing, play }: Props) {
  if (view._tag === "Private") {
    return <PrivateProfile onRefresh={onRefresh} refreshing={refreshing} />;
  }

  if (view.entries.length === 0) {
    // syncedAt === null: первая синхронизация со Steam не удалась — это не «пустая библиотека».
    if (view.syncedAt === null) {
      return (
        <Notice
          icon={<CloudOff className="size-6" />}
          title="Steam сейчас недоступен. Попробуйте обновить позже."
        >
          <Button onClick={onRefresh} disabled={refreshing}>
            Обновить
          </Button>
        </Notice>
      );
    }
    return (
      <Notice
        icon={<Gamepad2 className="size-6" />}
        title="В библиотеке пока нет игр"
      >
        <p className="text-sm text-muted-foreground">
          Купленные в Steam игры появятся здесь после обновления.
        </p>
      </Notice>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
      {view.entries.map((game) => (
        <li key={game.appId}>
          <GameCard game={game} action={cardAction(game, play)} />
        </li>
      ))}
    </ul>
  );
}
