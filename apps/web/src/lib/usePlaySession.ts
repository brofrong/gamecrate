// Запуск игры с главной `/app` — общий для `MyGamesPage` (библиотека, «Запускал
// недавно») и `TrendingPage` («В тренде»): активная сессия пользователя, запуск
// новой («Играть») и переход к активной («Вернуться в игру»). Ошибки
// `session.start` разбирает `reportStartError` — его же зовёт «Играть снова»
// на экране сессии.
import { accessDeniedReason, noMinutesReason, noServerReason } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { toast } from "sonner";
import { currentBrand } from "@/brands";
import type { LibraryPlay } from "@/lib/cardAction";
import {
  activeSessionAtom,
  errorTag,
  startSessionArgs,
  startSessionAtom,
} from "@/rpc";

/**
 * Тост (или уход на вход) по `_tag` ошибки `session.start`:
 * `GameNotOwned`/`AccessDenied`/`NoServer`/`NoMinutes`/`Unauthorized`/остальное.
 * `NoMinutes` (спека §4, §7) — минут по тарифу не осталось: тост с «Докупить» на
 * страницу тарифов-заглушку; без роутера под рукой (зовётся и из статических
 * мест вроде `playAgain`) — прямой переход, как у `Unauthorized`.
 */
export function reportStartError(tag: string | undefined): void {
  if (tag === "GameNotOwned") {
    toast.error("Эта игра не найдена в вашей библиотеке Steam");
  } else if (tag === "AccessDenied") {
    toast.error(accessDeniedReason);
  } else if (tag === "NoServer") {
    toast.error(noServerReason);
  } else if (tag === "NoMinutes") {
    toast.error(noMinutesReason, {
      action: {
        // У партнёрской витрины покупки нет — там же страница подписки.
        label:
          currentBrand().monetization.kind === "own" ? "Докупить" : "Подписка",
        onClick: () => window.location.assign("/app/plans"),
      },
    });
  } else if (tag === "Unauthorized") {
    window.location.assign("/");
  } else {
    toast.error("Не удалось начать игру. Попробуйте ещё раз.");
  }
}

export function usePlaySession() {
  const active = useAtomValue(activeSessionAtom);
  const start = useAtomSet(startSessionAtom, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [startingAppId, setStartingAppId] = useState<number | null>(null);

  const activeSession = AsyncResult.isSuccess(active)
    ? active.value
    : undefined;
  const openSession = (id: string) =>
    void navigate({ to: "/session/$id", params: { id } });

  const onPlay = async (appId: number) => {
    setStartingAppId(appId);
    const exit = await start(startSessionArgs(appId));
    setStartingAppId(null);
    if (Exit.isSuccess(exit)) {
      openSession(exit.value.id);
      return;
    }
    reportStartError(errorTag(exit.cause));
  };

  const play: LibraryPlay = {
    active: activeSession,
    startingAppId,
    onPlay: (appId) => void onPlay(appId),
    onResume: () => {
      if (activeSession) openSession(activeSession.id);
    },
  };

  return { active, activeSession, play };
}
