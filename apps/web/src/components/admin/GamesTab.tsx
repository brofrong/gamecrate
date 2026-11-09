// Вкладка «Игры» (`/admin?tab=games`, Task 4, макет `mockup-games.html`): игры
// библиотек серверов — строка на пару (сервер, игра), библиотека своя у каждого
// сервера (спека 2026-11-09 §5): размер/даты/запуски по серверу и «Удалить» с
// этого сервера с подтверждением; служебные
// пакеты (Proton, Steam Linux Runtime…) показаны отдельной строкой без кнопки — их не
// удаляют никогда (это не `gamestore_apps`, см. глобальные ограничения спеки). Плюс
// раздел «Свои сборки» (спека 2026-11-03 «Свои игры», Task 10) над играми библиотеки:
// где раскатан пакет и переключатель «Открыта игрокам» — у своих сборок нет ни
// удаления, ни установки через эту вкладку.
import type { AdminGame, AdminGames, AdminOwnGame } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import * as React from "react";
import { toast } from "sonner";
import { GameRequirementsPanel } from "@/components/admin/GameRequirementsPanel";
import { Polled } from "@/components/admin/Polled";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes, formatShortDate } from "@/lib/adminFormat";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";
import {
  adminDeleteGameArgs,
  adminDeleteGameAtom,
  adminGamesAtom,
  adminSetOwnGamePublishedArgs,
  adminSetOwnGamePublishedAtom,
} from "@/rpc";

/** «5,5 ГБ · 12 шт.» — игры и служебные пакеты вместе, как в заголовке блока. */
function headerSummary(value: AdminGames): string {
  const sizeBytes =
    value.games.reduce((sum, g) => sum + g.sizeBytes, 0) +
    (value.service?.sizeBytes ?? 0);
  const count = value.games.length + (value.service?.count ?? 0);
  return `${formatBytes(sizeBytes)} · ${count} шт.`;
}

/**
 * Кнопка «Удалить»: `deleting` — вместо кнопки текст «Удаляется…»; активная сессия
 * или установка — кнопка неактивна с подсказкой (обёртка с `tabIndex` — у disabled
 * кнопки свои события наведения/фокуса не работают, подсказка их не поймает).
 */
function DeleteCell({
  game,
  onDelete,
}: {
  game: AdminGame;
  onDelete: (game: AdminGame) => void;
}) {
  if (game.deleting) {
    return <span className="text-sm text-muted-foreground">Удаляется…</span>;
  }

  const reason =
    game.activeSessions > 0
      ? "Сейчас играют"
      : game.installing
        ? "Ставится"
        : null;

  const button = (
    <Button
      variant="outline"
      size="sm"
      disabled={reason !== null}
      className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
      onClick={() => onDelete(game)}
    >
      Удалить
    </Button>
  );

  if (reason === null) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-block">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Строки раздела «Свои сборки»: воркеры через запятую или «Нет ни на одном
 * воркере»; переключатель «Открыта игрокам»; кнопка «Требования» раскрывает
 * существующую `GameRequirementsPanel` под строкой, как у игр библиотеки.
 * Удаления и установки здесь нет.
 */
function OwnGamesTable({
  games,
  expandedAppId,
  onToggle,
  onSetPublished,
}: {
  games: ReadonlyArray<AdminOwnGame>;
  expandedAppId: number | null;
  onToggle: (appId: number) => void;
  onSetPublished: (game: AdminOwnGame, published: boolean) => void;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2";
  const columns = 5;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Игра</th>
            <th className={th}>Версия</th>
            <th className={th}>Воркеры</th>
            <th className={th}>Открыта игрокам</th>
            <th className={th} aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {games.map((game) => {
            const switchId = `own-game-published-${game.appId}`;
            return (
              <React.Fragment key={game.appId}>
                <tr className="border-t">
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <span>{game.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        своя сборка
                      </span>
                    </div>
                  </td>
                  <td className={cn(td, "whitespace-nowrap")}>
                    {game.version}
                  </td>
                  <td
                    className={cn(
                      td,
                      game.workers.length === 0 && "text-muted-foreground",
                    )}
                  >
                    {game.workers.length === 0
                      ? "Нет ни на одном воркере"
                      : game.workers.join(", ")}
                  </td>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <Switch
                        id={switchId}
                        checked={game.published}
                        onCheckedChange={(checked) =>
                          onSetPublished(game, checked)
                        }
                      />
                      <label htmlFor={switchId}>Открыта игрокам</label>
                    </div>
                  </td>
                  <td className={cn(td, "text-right")}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onToggle(game.appId)}
                    >
                      Требования
                    </Button>
                  </td>
                </tr>
                {expandedAppId === game.appId && (
                  <tr className="border-t bg-muted/30">
                    <td className={td} colSpan={columns}>
                      <GameRequirementsPanel appId={game.appId} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GamesTable({
  games,
  service,
  onDelete,
  expandedAppId,
  onToggle,
}: {
  games: ReadonlyArray<AdminGame>;
  service: AdminGames["service"];
  onDelete: (game: AdminGame) => void;
  expandedAppId: number | null;
  onToggle: (appId: number) => void;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2";
  const columns = 7;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Игра</th>
            <th className={th}>Сервер</th>
            <th className={th}>Размер</th>
            <th className={th}>Поставлена</th>
            <th className={th}>Последний запуск</th>
            <th className={th}>Запусков</th>
            <th className={th} aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <React.Fragment key={`${game.workerId}:${game.appId}`}>
              <tr
                className="cursor-pointer border-t hover:bg-muted/40"
                aria-expanded={expandedAppId === game.appId}
                onClick={() => onToggle(game.appId)}
              >
                <td className={td}>
                  <div className="flex flex-col gap-0.5">
                    <span>{game.name}</span>
                    {!game.deleting && game.deleteError !== null && (
                      <span className="text-xs text-destructive">
                        {`Не удалось удалить: ${game.deleteError}`}
                      </span>
                    )}
                  </div>
                </td>
                <td className={cn(td, "whitespace-nowrap")}>{game.workerId}</td>
                <td className={cn(td, "whitespace-nowrap")}>
                  {formatBytes(game.sizeBytes)}
                </td>
                <td className={cn(td, "whitespace-nowrap")}>
                  {formatShortDate(game.installedAt)}
                </td>
                <td
                  className={cn(
                    td,
                    "whitespace-nowrap",
                    (game.activeSessions > 0 || game.lastLaunchAt === null) &&
                      "text-muted-foreground",
                  )}
                >
                  {game.activeSessions > 0
                    ? "играют сейчас"
                    : game.lastLaunchAt === null
                      ? "—"
                      : formatShortDate(game.lastLaunchAt)}
                </td>
                <td className={td}>{game.launches}</td>
                <td
                  className={cn(td, "text-right")}
                  onClick={(event) => event.stopPropagation()}
                >
                  <DeleteCell game={game} onDelete={onDelete} />
                </td>
              </tr>
              {expandedAppId === game.appId && (
                <tr className="border-t bg-muted/30">
                  <td className={td} colSpan={columns}>
                    <GameRequirementsPanel appId={game.appId} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
          {service !== null && (
            <tr className="border-t">
              <td className={cn(td, "whitespace-normal text-muted-foreground")}>
                {`Служебные: ${service.names.join(", ")}`}
              </td>
              <td className={td} />
              <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>
                {formatBytes(service.sizeBytes)}
              </td>
              <td className={cn(td, "text-muted-foreground")} colSpan={4}>
                нужны играм, удалить нельзя
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Текст тоста по ответу `admin.games.delete`; `started` отдельного не требует (строка
 * игры сама покажет «Удаляется…» на следующем опросе). */
function deleteToast(result: "started" | "inUse" | "notFound") {
  if (result === "inUse") toast.error("Игру сейчас используют");
  else if (result === "notFound") toast.error("Игры уже нет");
  else toast.success("Игра удаляется");
}

export function GamesTab() {
  const games = useAtomValue(adminGamesAtom);
  usePolling(adminGamesAtom);
  const [toDelete, setToDelete] = React.useState<AdminGame | null>(null);
  // Общий на оба раздела: диапазоны appId своих сборок и игр библиотеки не
  // пересекаются, раскрытая строка в одном разделе не мешает другому.
  const [expandedAppId, setExpandedAppId] = React.useState<number | null>(null);
  const deleteGame = useAtomSet(adminDeleteGameAtom, { mode: "promiseExit" });
  const setOwnGamePublished = useAtomSet(adminSetOwnGamePublishedAtom, {
    mode: "promiseExit",
  });

  const onConfirm = async () => {
    if (toDelete === null) return;
    const exit = await deleteGame(
      adminDeleteGameArgs(toDelete.workerId, toDelete.appId),
    );
    if (Exit.isFailure(exit)) toast.error("Не удалось удалить игру");
    else deleteToast(exit.value);
  };

  const onToggle = (appId: number) =>
    setExpandedAppId((current) => (current === appId ? null : appId));

  const onSetPublished = async (game: AdminOwnGame, published: boolean) => {
    const exit = await setOwnGamePublished(
      adminSetOwnGamePublishedArgs(game.appId, published),
    );
    if (Exit.isFailure(exit)) toast.error("Не удалось переключить игру");
    else if (exit.value === "notFound") toast.error("Игры уже нет");
    else
      toast.success(
        published ? `${game.name}: открыта игрокам` : `${game.name}: скрыта`,
      );
  };

  const summary = Option.getOrUndefined(AsyncResult.value(games));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Свои сборки</CardTitle>
        </CardHeader>
        <CardContent>
          <Polled
            result={games}
            error="Не удалось загрузить свои сборки"
            skeleton={<Skeleton className="h-32 w-full" />}
          >
            {(value) =>
              value.own.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Своих сборок нет
                </p>
              ) : (
                <OwnGamesTable
                  games={value.own}
                  expandedAppId={expandedAppId}
                  onToggle={onToggle}
                  onSetPublished={(game, published) =>
                    void onSetPublished(game, published)
                  }
                />
              )
            }
          </Polled>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Игры на хранилище</CardTitle>
          {summary !== undefined && (
            <span className="text-sm text-muted-foreground">
              {headerSummary(summary)}
            </span>
          )}
        </CardHeader>
        <CardContent>
          <Polled
            result={games}
            error="Не удалось загрузить игры"
            skeleton={<Skeleton className="h-48 w-full" />}
          >
            {(value) =>
              value.games.length === 0 && value.service === null ? (
                <p className="text-sm text-muted-foreground">
                  Игр на хранилище нет
                </p>
              ) : (
                <GamesTable
                  games={value.games}
                  service={value.service}
                  onDelete={setToDelete}
                  expandedAppId={expandedAppId}
                  onToggle={onToggle}
                />
              )
            }
          </Polled>
        </CardContent>
      </Card>

      <AlertDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Удалить ${toDelete?.name ?? ""} с сервера ${toDelete?.workerId ?? ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete !== null &&
                `${formatBytes(toDelete.sizeBytes)} освободится на сервере. Запуск игры потом поставит её заново.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onConfirm()}>
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
