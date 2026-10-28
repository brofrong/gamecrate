// `/admin`: админка — вкладки «Воркеры» (карточки воркеров и «Последние сбои»), «Сессии»
// и «Настройки» («Настройки сессий»). Без сессии — вход через Pocket ID, игрок — «Нет доступа».
import type { AdminWorker, SessionSettings } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  createRoute,
  Link,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import * as React from "react";
import { toast } from "sonner";
import { signInWithProvider } from "@/auth";
import { AdminSessionsTable } from "@/components/admin/AdminSessionsTable";
import { FailuresCard } from "@/components/admin/FailuresCard";
import { SessionSettingsForm } from "@/components/admin/SessionSettingsForm";
import { WorkerCard } from "@/components/admin/WorkerCard";
import { AppHeader } from "@/components/AppHeader";
import { FullscreenLoader } from "@/components/FullscreenLoader";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";
import {
  adminPingAtom,
  adminSessionsAtom,
  adminSetDrainingArgs,
  adminSetDrainingAtom,
  adminStopSessionArgs,
  adminStopSessionAtom,
  adminWorkersAtom,
  errorTag,
  meAtom,
  resultErrorTag,
  sessionSettingsAtom,
  updateSessionSettingsArgs,
  updateSessionSettingsAtom,
} from "@/rpc";
import { rootRoute } from "./__root";

function PocketIdButton({ variant }: { variant?: "default" | "outline" }) {
  return (
    <Button
      variant={variant}
      onClick={() => void signInWithProvider("pocket-id", "/admin")}
    >
      Войти через Pocket ID
    </Button>
  );
}

function CenteredCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children && (
          <CardContent className="flex justify-center">{children}</CardContent>
        )}
      </Card>
    </main>
  );
}

function NoAccess() {
  return (
    <CenteredCard
      title="Нет доступа"
      description="Админка доступна только администраторам."
    >
      <PocketIdButton variant="outline" />
    </CenteredCard>
  );
}

/** Текст ошибки сохранения настроек по `_tag` ошибки RPC. */
const saveError = (tag: string | undefined) =>
  tag === "Forbidden" || tag === "Unauthorized"
    ? "Нет прав на изменение настроек — войдите как администратор"
    : "Не удалось сохранить настройки. Сервер отклонил значения или недоступен.";

function SessionSettingsCard() {
  const settings = useAtomValue(sessionSettingsAtom);
  const update = useAtomSet(updateSessionSettingsAtom, {
    mode: "promiseExit",
  });

  const onSubmit = async (value: SessionSettings) => {
    const exit = await update(updateSessionSettingsArgs(value));
    if (Exit.isSuccess(exit)) {
      toast.success("Настройки сохранены");
      return null;
    }
    return saveError(errorTag(exit.cause));
  };

  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Настройки сессий</CardTitle>
        <CardDescription>
          Применяются сразу, в том числе к идущим сессиям.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {AsyncResult.match(settings, {
          onInitial: () => (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={`settings-${i}`} className="h-14 w-full" />
              ))}
            </div>
          ),
          onFailure: () => (
            <p className="text-sm text-destructive">
              Не удалось загрузить настройки
            </p>
          ),
          onSuccess: ({ value }) => (
            <SessionSettingsForm initial={value} onSubmit={onSubmit} />
          ),
        })}
      </CardContent>
    </Card>
  );
}

/** Вкладки админки (часть 1): «Игры», «Установки», «Пользователи» — во второй части. */
const ADMIN_TABS = [
  ["workers", "Воркеры"],
  ["sessions", "Сессии"],
  ["settings", "Настройки"],
] as const;
type AdminTab = (typeof ADMIN_TABS)[number][0];

const isAdminTab = (value: unknown): value is AdminTab =>
  ADMIN_TABS.some(([tab]) => tab === value);

function Tabs({ tab }: { tab: AdminTab }) {
  return (
    <nav aria-label="Разделы админки" className="mb-6 flex flex-wrap gap-2">
      {ADMIN_TABS.map(([value, label]) => (
        <Link
          key={value}
          to="/admin"
          search={{ tab: value }}
          aria-current={tab === value ? "page" : undefined}
          className={cn(
            "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
            tab === value
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** «Остановить» с подтверждением: `sessionId` — какую сессию спрашиваем, `null` — диалог закрыт. */
function StopSessionDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const stop = useAtomSet(adminStopSessionAtom, { mode: "promiseExit" });

  const onConfirm = async () => {
    if (sessionId === null) return;
    const exit = await stop(adminStopSessionArgs(sessionId));
    if (Exit.isFailure(exit)) toast.error("Не удалось остановить сессию");
    else if (exit.value) toast.success("Сессия останавливается");
    else toast.error("Сессия не найдена");
  };

  return (
    <AlertDialog
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Остановить сессию?</AlertDialogTitle>
          <AlertDialogDescription>
            Игра у игрока закроется, профиль сохранится.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>
            Остановить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function LoadError({ text }: { text: string }) {
  return <p className="text-sm text-destructive">{text}</p>;
}

/**
 * Результат опрашиваемого запроса: первый ответ ещё не пришёл — `skeleton`; очередной
 * запрос упал — ошибка над прошлыми данными (если они были), а не вместо них.
 */
function Polled<A, E>({
  result,
  error,
  skeleton,
  children,
}: {
  result: AsyncResult.AsyncResult<A, E>;
  error: string;
  skeleton: React.ReactNode;
  children: (value: A) => React.ReactNode;
}) {
  const value = AsyncResult.value(result);
  return (
    <>
      {AsyncResult.isFailure(result) && <LoadError text={error} />}
      {Option.isSome(value)
        ? children(value.value)
        : AsyncResult.isInitial(result) && skeleton}
    </>
  );
}

function WorkersTab({ onStop }: { onStop: (sessionId: string) => void }) {
  const workers = useAtomValue(adminWorkersAtom);
  usePolling(adminWorkersAtom);
  const failuresAtom = adminSessionsAtom(true);
  const failures = useAtomValue(failuresAtom);
  usePolling(failuresAtom);
  const setDraining = useAtomSet(adminSetDrainingAtom, {
    mode: "promiseExit",
  });
  // Опрос перерисовывает вкладку раз в 5 с — «сигнал … назад» и «Идёт» считаются от этого.
  const now = Date.now();

  const onDraining = async (worker: AdminWorker, draining: boolean) => {
    const exit = await setDraining(adminSetDrainingArgs(worker.id, draining));
    if (Exit.isFailure(exit))
      toast.error("Не удалось переключить обслуживание");
    else if (!exit.value) toast.error("Воркер не найден");
    else
      toast.success(
        draining
          ? `${worker.id} на обслуживании: новые сессии и установки туда не пойдут`
          : `${worker.id} снова в работе`,
      );
  };

  return (
    <div className="flex flex-col gap-6">
      <Polled
        result={workers}
        error="Не удалось загрузить воркеры"
        skeleton={<ListSkeleton />}
      >
        {(value) =>
          value.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Воркеров нет: ни один агент ещё не подключался.
            </p>
          ) : (
            value.map((worker) => (
              <WorkerCard
                key={worker.id}
                worker={worker}
                now={now}
                onStop={onStop}
                onDraining={(draining) => void onDraining(worker, draining)}
              />
            ))
          )
        }
      </Polled>
      <Polled
        result={failures}
        error="Не удалось загрузить сбои"
        skeleton={<Skeleton className="h-24 w-full" />}
      >
        {(value) => <FailuresCard sessions={value.recent} />}
      </Polled>
    </div>
  );
}

/** Вкладка «Сессии», пока только активные сессии (история и сбои — следующим шагом). */
function SessionsTab({ onStop }: { onStop: (sessionId: string) => void }) {
  const sessionsAtom = adminSessionsAtom(false);
  const sessions = useAtomValue(sessionsAtom);
  usePolling(sessionsAtom);
  const now = Date.now();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Сейчас идут</CardTitle>
      </CardHeader>
      <CardContent>
        <Polled
          result={sessions}
          error="Не удалось загрузить сессии"
          skeleton={<Skeleton className="h-24 w-full" />}
        >
          {(value) =>
            value.active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Сейчас никто не играет
              </p>
            ) : (
              <AdminSessionsTable
                sessions={value.active}
                now={now}
                showWorker
                onStop={onStop}
              />
            )
          }
        </Polled>
      </CardContent>
    </Card>
  );
}

function AdminHome() {
  const me = useAtomValue(meAtom);
  const ping = useAtomValue(adminPingAtom);
  const { tab } = adminRoute.useSearch();
  const [stopId, setStopId] = React.useState<string | null>(null);

  if (resultErrorTag(ping) === "Forbidden") return <NoAccess />;

  return (
    <div className="min-h-dvh">
      <AppHeader user={AsyncResult.isSuccess(me) ? me.value : undefined} />
      <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-2xl font-semibold">Админка</h1>
        <Tabs tab={tab} />
        {tab === "workers" && <WorkersTab onStop={setStopId} />}
        {tab === "sessions" && <SessionsTab onStop={setStopId} />}
        {tab === "settings" && <SessionSettingsCard />}
        <StopSessionDialog sessionId={stopId} onClose={() => setStopId(null)} />
      </main>
    </div>
  );
}

function AdminPage() {
  const me = useAtomValue(meAtom);

  if (AsyncResult.isInitial(me)) return <FullscreenLoader />;
  if (AsyncResult.isFailure(me)) {
    return resultErrorTag(me) === "Unauthorized" ? (
      <CenteredCard
        title="Админка"
        description="Войдите учётной записью администратора."
      >
        <PocketIdButton />
      </CenteredCard>
    ) : (
      <CenteredCard
        title="Админка"
        description="Не удалось связаться с сервером. Обновите страницу."
      />
    );
  }
  if (me.value.role !== "admin") return <NoAccess />;
  return <AdminHome />;
}

export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  // Вкладка в адресе (`?tab=sessions`), чтобы обновление страницы и ссылка вели туда же;
  // нет или неизвестная — «Воркеры».
  validateSearch: (
    search: { tab?: unknown } & SearchSchemaInput,
  ): { tab: AdminTab } => ({
    tab: isAdminTab(search.tab) ? search.tab : "workers",
  }),
  component: AdminPage,
});
