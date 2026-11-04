// Значение справа на обложке плитки игры (спека 2026-10-27 §3.3) — чистая логика без
// React: одно короткое слово/число, его тон и процент установки для полосы прогресса.
import { type CloudStatus, isOwnAppId, type RecentEntry } from "@cg/rpc";
import {
  formatHoursShort,
  formatMinutes,
  formatRelativeDate,
} from "@/lib/formatTime";

export type TileTone = "muted" | "ok" | "warn";

export type TileValue = {
  readonly text: string;
  readonly tone: TileTone;
  /** Не null только у «качается» с известным процентом — для полосы по нижнему краю. */
  readonly percent: number | null;
};

const muted = (text: string): TileValue => ({
  text,
  tone: "muted",
  percent: null,
});

/**
 * Своя игра — всегда «бесплатно» (Steam ей не нужен, `dimmed` её не трогает); у
 * остальных `dimmed` (у пользователя нет облачного профиля Steam) перекрывает
 * статус облака.
 */
export function tileValue(
  game: {
    readonly appId?: number;
    readonly cloud: CloudStatus;
    readonly playtimeMinutes?: number;
  },
  dimmed: boolean,
): TileValue {
  if (game.appId !== undefined && isOwnAppId(game.appId))
    return { text: "бесплатно", tone: "ok", percent: null };
  if (dimmed) return muted("нужен вход в Steam");
  switch (game.cloud._tag) {
    case "Ready": {
      const hours = formatHoursShort(game.playtimeMinutes ?? 0);
      return hours === ""
        ? { text: "готова", tone: "ok", percent: null }
        : muted(hours);
    }
    case "Installing":
      return game.cloud.percent === null
        ? { text: "качается", tone: "warn", percent: null }
        : {
            text: `${game.cloud.percent} %`,
            tone: "warn",
            percent: game.cloud.percent,
          };
    // Секция «Нужна установка» и кнопка «Установить» уже говорят это — на плитке пусто,
    // иначе на телефоне слово съедает название.
    case "Missing":
      return muted("");
  }
}

/** Подпись плитки в «Запускал недавно»: «вчера · 1 ч 20 м» — дата и длительность последней сессии. */
export function recentCaption(entry: RecentEntry, now: Date): string {
  return `${formatRelativeDate(entry.lastPlayedAt, now)} · ${formatMinutes(entry.lastDurationMinutes)}`;
}
