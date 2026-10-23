// Копия `CardAction`/`cardAction` из `GameCard.tsx` и `LibraryPlay`/`cardAction` из
// `LibraryContent.tsx` — чистая версия без React, для тестов и для главной `/app`.
// Исходные файлы не трогаем: ими владеет другой поток до переключения на эту копию.
import type { SessionView } from "@cg/rpc";

/**
 * Что делает кнопка карточки:
 * - `play` — «Играть» (`pending` — эта игра уже запускается, `disabled` — запускается
 *   другая или активная сессия ещё не известна);
 * - `resume` — у этой игры активная сессия: «Вернуться в игру»;
 * - `blocked` — активна сессия другой игры: «Играть» неактивна с подсказкой.
 */
export type CardAction =
  | {
      readonly kind: "play";
      readonly pending: boolean;
      readonly disabled: boolean;
      readonly onPlay: () => void;
    }
  | { readonly kind: "resume"; readonly onResume: () => void }
  | { readonly kind: "blocked" };

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

/** Одна активная сессия на пользователя: у её игры — «Вернуться в игру», у остальных «Играть» неактивна. */
export function cardAction(
  game: { appId: number },
  play: LibraryPlay,
): CardAction {
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
