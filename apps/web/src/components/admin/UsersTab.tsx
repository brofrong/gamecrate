// Вкладка «Пользователи» (`/admin?tab=users`, Task 4): список пользователей со способами
// входа, Steam, наигранным временем и профилем; поиск по имени/почте на клиенте; действия —
// сменить роль, заблокировать/разблокировать, сбросить вход Steam (подтверждение для блокировки
// и сброса, как «Удалить»/«Отменить» на других вкладках). Своя строка — действия неактивны
// («Это вы»): себя нельзя ни разжаловать, ни заблокировать (сервер и так ответит «self»).
// Столбец «Тариф» (Task 9, спека §8) — имя действующего тарифа и кнопка «Тариф», открывающая
// `UserPlanDialog` (выдача/снятие тарифа, начисление часов, история) — своей строки эта кнопка
// не касается, тариф себе менять можно (это не роль/блокировка).
import type { AdminUser, LoginProviderId, Role } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import * as React from "react";
import { toast } from "sonner";
import { Polled } from "@/components/admin/Polled";
import { UserPlanDialog } from "@/components/admin/UserPlanDialog";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes, formatShortDate } from "@/lib/adminFormat";
import { formatMinutes } from "@/lib/formatTime";
import { pluralize } from "@/lib/plural";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";
import {
  adminResetSteamLoginArgs,
  adminResetSteamLoginAtom,
  adminSetBlockedArgs,
  adminSetBlockedAtom,
  adminSetRoleArgs,
  adminSetRoleAtom,
  adminUsersAtom,
  meAtom,
} from "@/rpc";

// Дублирует `METHOD_LABELS` из `components/profile/LoginMethods.tsx` — тот тянет
// `SteamQrLogin` (вход Steam по QR) со своими RPC-атомами, которые тут ни при чём, а
// список способов входа стабилен (новые добавляет Task 1 в `LoginProviderId`).
const PROVIDER_LABELS: Record<LoginProviderId, string> = {
  yandex: "Яндекс",
  google: "Google",
  telegram: "Telegram",
  "pocket-id": "Pocket ID",
  steam: "Steam",
};

/** «Google, Яндекс», «Pocket ID» — способы входа; нет ни одного — «Почта». */
function loginLabel(providers: ReadonlyArray<string>): string {
  if (providers.length === 0) return "Почта";
  return providers
    .map((id) => PROVIDER_LABELS[id as LoginProviderId] ?? id)
    .join(", ");
}

/**
 * «76561190000000001 · вход сброшен», «не привязан». Пометка сброса
 * (`steamLoginResetPending`) показывается независимо от привязки Steam: вход
 * в контейнере мог быть не из `steamId` (сид до отвязки), и админу нужно
 * видеть, что сброс ещё ждёт исполнения (M4).
 */
function steamLabel(u: AdminUser): string {
  if (u.steamId === null)
    return u.steamLoginResetPending ? "не привязан · вход сброшен" : "не привязан";
  return u.steamLoginResetPending ? `${u.steamId} · вход сброшен` : u.steamId;
}

/** «1,2 МБ · v3», нет снимка облачного профиля — «—». */
function profileLabel(u: AdminUser): string {
  if (u.profileSizeBytes === null || u.profileVersion === null) return "—";
  return `${formatBytes(u.profileSizeBytes)} · v${u.profileVersion}`;
}

/** Поиск на клиенте по имени и почте (регистронезависимый, по подстроке). */
function filterUsers(
  users: ReadonlyArray<AdminUser>,
  query: string,
): ReadonlyArray<AdminUser> {
  const q = query.trim().toLowerCase();
  if (q === "") return users;
  return users.filter(
    (u) =>
      u.name.toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q),
  );
}

function UserCell({ u }: { u: AdminUser }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{u.name}</span>
        {u.role === "admin" && <Badge variant="secondary">Админ</Badge>}
        {u.blockedAt !== null && (
          <Badge variant="destructive">
            {`Заблокирован ${formatShortDate(u.blockedAt)}`}
          </Badge>
        )}
        {u.activeSession && <Badge variant="outline">в игре</Badge>}
      </div>
      <span className="text-xs text-muted-foreground">{u.email ?? "—"}</span>
    </div>
  );
}

/** Меню действий строки: смена роли, блокировка, сброс входа Steam; своя строка — всё неактивно. */
function ActionsCell({
  u,
  isSelf,
  onToggleRole,
  onUnblock,
  onBlock,
  onReset,
}: {
  u: AdminUser;
  isSelf: boolean;
  onToggleRole: (u: AdminUser) => void;
  onUnblock: (u: AdminUser) => void;
  onBlock: (u: AdminUser) => void;
  onReset: (u: AdminUser) => void;
}) {
  const roleLabel = u.role === "admin" ? "Сделать игроком" : "Сделать админом";
  const hasPocketId = u.providers.includes("pocket-id");

  const roleButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={isSelf}
      onClick={() => onToggleRole(u)}
    >
      {roleLabel}
    </Button>
  );

  const blockButton =
    u.blockedAt !== null ? (
      <Button
        variant="outline"
        size="sm"
        disabled={isSelf}
        onClick={() => onUnblock(u)}
      >
        Разблокировать
      </Button>
    ) : (
      <Button
        variant="outline"
        size="sm"
        disabled={isSelf}
        className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
        onClick={() => onBlock(u)}
      >
        Заблокировать
      </Button>
    );

  const resetButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={isSelf}
      onClick={() => onReset(u)}
    >
      Сбросить вход Steam
    </Button>
  );

  const group = (
    <div className="flex flex-wrap justify-end gap-1.5">
      {hasPocketId && !isSelf ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-block">
              {roleButton}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Роль задаёт группа в Pocket ID при входе
          </TooltipContent>
        </Tooltip>
      ) : (
        roleButton
      )}
      {blockButton}
      {resetButton}
    </div>
  );

  if (!isSelf) return group;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-block">
          {group}
        </span>
      </TooltipTrigger>
      <TooltipContent>Это вы</TooltipContent>
    </Tooltip>
  );
}

function UsersTable({
  users,
  myId,
  onToggleRole,
  onUnblock,
  onBlock,
  onReset,
  onOpenPlan,
}: {
  users: ReadonlyArray<AdminUser>;
  myId: string | undefined;
  onToggleRole: (u: AdminUser) => void;
  onUnblock: (u: AdminUser) => void;
  onBlock: (u: AdminUser) => void;
  onReset: (u: AdminUser) => void;
  onOpenPlan: (u: AdminUser) => void;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2 align-top";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Пользователь</th>
            <th className={th}>Вход</th>
            <th className={th}>Steam</th>
            <th className={th}>Регистрация</th>
            <th className={th}>Последняя сессия</th>
            <th className={th}>Наиграно</th>
            <th className={th}>Профиль</th>
            <th className={th}>Тариф</th>
            <th className={th} aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t">
              <td className={td}>
                <UserCell u={u} />
              </td>
              <td className={td}>{loginLabel(u.providers)}</td>
              <td className={cn(td, "whitespace-nowrap")}>
                {steamLabel(u)}
              </td>
              <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>
                {formatShortDate(u.createdAt)}
              </td>
              <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>
                {u.lastSessionAt === null
                  ? "—"
                  : formatShortDate(u.lastSessionAt)}
              </td>
              <td className={cn(td, "whitespace-nowrap")}>
                {formatMinutes(Math.floor(u.playedSeconds / 60))}
              </td>
              <td className={cn(td, "whitespace-nowrap")}>
                {profileLabel(u)}
              </td>
              <td className={cn(td, "whitespace-nowrap")}>
                <div className="flex items-center gap-1.5">
                  <span>{u.tariffName}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenPlan(u)}
                  >
                    Тариф
                  </Button>
                </div>
              </td>
              <td className={cn(td, "text-right")}>
                <ActionsCell
                  u={u}
                  isSelf={u.id === myId}
                  onToggleRole={onToggleRole}
                  onUnblock={onUnblock}
                  onBlock={onBlock}
                  onReset={onReset}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Текст тоста по ответу `"ok" | "self" | "notFound"` (смена роли, блокировка). */
function mutationToast(
  result: "ok" | "self" | "notFound",
  okMessage: string,
) {
  if (result === "self") toast.error("Нельзя изменить себя");
  else if (result === "notFound") toast.error("Пользователь не найден");
  else toast.success(okMessage);
}

export function UsersTab() {
  const me = useAtomValue(meAtom);
  const myId = AsyncResult.isSuccess(me) ? me.value.id : undefined;

  const users = useAtomValue(adminUsersAtom);
  usePolling(adminUsersAtom);

  const [query, setQuery] = React.useState("");
  const [toBlock, setToBlock] = React.useState<AdminUser | null>(null);
  const [toReset, setToReset] = React.useState<AdminUser | null>(null);
  const [planUser, setPlanUser] = React.useState<AdminUser | null>(null);

  const setRole = useAtomSet(adminSetRoleAtom, { mode: "promiseExit" });
  const setBlocked = useAtomSet(adminSetBlockedAtom, { mode: "promiseExit" });
  const resetSteamLogin = useAtomSet(adminResetSteamLoginAtom, {
    mode: "promiseExit",
  });

  const onToggleRole = async (u: AdminUser) => {
    const role: Role = u.role === "admin" ? "player" : "admin";
    const exit = await setRole(adminSetRoleArgs(u.id, role));
    if (Exit.isFailure(exit)) toast.error("Не удалось сменить роль");
    else mutationToast(exit.value, "Роль обновлена");
  };

  const onUnblock = async (u: AdminUser) => {
    const exit = await setBlocked(adminSetBlockedArgs(u.id, false));
    if (Exit.isFailure(exit)) toast.error("Не удалось разблокировать");
    else mutationToast(exit.value, "Пользователь разблокирован");
  };

  const onConfirmBlock = async () => {
    if (toBlock === null) return;
    const exit = await setBlocked(adminSetBlockedArgs(toBlock.id, true));
    if (Exit.isFailure(exit)) toast.error("Не удалось заблокировать");
    else mutationToast(exit.value, "Пользователь заблокирован");
  };

  const onConfirmReset = async () => {
    if (toReset === null) return;
    const exit = await resetSteamLogin(adminResetSteamLoginArgs(toReset.id));
    if (Exit.isFailure(exit)) toast.error("Не удалось сбросить вход Steam");
    else if (!exit.value) toast.error("Пользователь не найден");
    else toast.success("Вход Steam сбросится при следующем запуске");
  };

  const loaded = Option.getOrUndefined(AsyncResult.value(users));
  const filtered = loaded !== undefined ? filterUsers(loaded, query) : undefined;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Пользователи</CardTitle>
          <div className="flex items-center gap-3">
            <input
              aria-label="Поиск по имени или почте"
              placeholder="Поиск по имени или почте"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="h-9 w-56 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            />
            {filtered !== undefined && (
              <span className="shrink-0 text-sm text-muted-foreground">
                {`${filtered.length} ${pluralize(filtered.length, "пользователь", "пользователя", "пользователей")}`}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Polled
            result={users}
            error="Не удалось загрузить пользователей"
            skeleton={<Skeleton className="h-64 w-full" />}
          >
            {(value) =>
              value.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Пользователей нет
                </p>
              ) : (
                <>
                  <UsersTable
                    users={filterUsers(value, query)}
                    myId={myId}
                    onToggleRole={(u) => void onToggleRole(u)}
                    onUnblock={(u) => void onUnblock(u)}
                    onBlock={setToBlock}
                    onReset={setToReset}
                    onOpenPlan={setPlanUser}
                  />
                  {filterUsers(value, query).length === 0 && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Совпадений нет
                    </p>
                  )}
                </>
              )
            }
          </Polled>
        </CardContent>
      </Card>

      <AlertDialog
        open={toBlock !== null}
        onOpenChange={(open) => {
          if (!open) setToBlock(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Заблокировать ${toBlock?.name ?? ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Текущая игра остановится, профиль сохранится. Новые игры
              запустить не получится, пока вы не разблокируете.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onConfirmBlock()}>
              Заблокировать
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={toReset !== null}
        onOpenChange={(open) => {
          if (!open) setToReset(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Сбросить вход Steam у ${toReset?.name ?? ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              При следующем запуске Steam попросит войти заново. Сохранения
              останутся.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onConfirmReset()}>
              Сбросить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {planUser !== null && (
        <UserPlanDialog
          userId={planUser.id}
          userName={planUser.name}
          open
          onOpenChange={(open) => {
            if (!open) setPlanUser(null);
          }}
        />
      )}
    </>
  );
}
