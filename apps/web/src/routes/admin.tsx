// `/admin`: админка — вкладки «Воркеры» (карточки воркеров и «Последние сбои»), «Сессии»,
// «Игры» (общая библиотека хранилища), «Установки» (активные и недавние задачи установки),
// «Пользователи» (роль, блокировка, сброс входа Steam) и «Настройки» («Настройки сессий»).
// Без сессии — вход через Pocket ID, игрок — «Нет доступа».
import type { AdminRegion, AdminWorker, SessionSettings } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  createRoute,
  Link,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import * as React from "react";
import { toast } from "sonner";
import { signInWithProvider } from "@/auth";
import {
  AddWorkerDialog,
  IssueCodeDialog,
} from "@/components/admin/AddWorkerDialog";
import { ClassesCard } from "@/components/admin/ClassesCard";
import { FailuresCard } from "@/components/admin/FailuresCard";
import { GamesTab } from "@/components/admin/GamesTab";
import { InstallsTab } from "@/components/admin/InstallsTab";
import { Polled } from "@/components/admin/Polled";
import { RegionsCard } from "@/components/admin/RegionsCard";
import { SessionSettingsForm } from "@/components/admin/SessionSettingsForm";
import { SessionsTab } from "@/components/admin/SessionsTab";
import { UsersTab } from "@/components/admin/UsersTab";
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
  adminClassesAtom,
  adminIssueWorkerCodeArgs,
  adminIssueWorkerCodeAtom,
  adminPingAtom,
  adminRegionsAtom,
  adminRevokeWorkerArgs,
  adminRevokeWorkerAtom,
  adminSessionsAtom,
  adminSetDrainingArgs,
  adminSetDrainingAtom,
  adminSetWorkerClassArgs,
  adminSetWorkerClassAtom,
  adminSetWorkerRegionArgs,
  adminSetWorkerRegionAtom,
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

/** Вкладки админки, в порядке вывода. */
const ADMIN_TABS = [
  ["workers", "Серверы"],
  ["sessions", "Сессии"],
  ["games", "Игры"],
  ["installs", "Установки"],
  ["users", "Пользователи"],
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

/**
 * Серверы по регионам (спека §7): группы в порядке `position`, «Без региона» —
 * последняя (в т. ч. если `regionId` указывает на уже удалённый регион — по id
 * которого региона уже нет в списке, сервер всё равно должен быть виден).
 * Регион без серверов — в список групп не попадает (ему всё равно нечего показать).
 */
function groupWorkersByRegion(
  workers: ReadonlyArray<AdminWorker>,
  regions: ReadonlyArray<AdminRegion>,
): ReadonlyArray<{ label: string; workers: ReadonlyArray<AdminWorker> }> {
  const sorted = [...regions].sort((a, b) => a.position - b.position);
  const regionIds = new Set(regions.map((region) => region.id));
  const groups = sorted
    .map((region) => ({
      label: region.name,
      workers: workers.filter((worker) => worker.regionId === region.id),
    }))
    .filter((group) => group.workers.length > 0);
  const noRegion = workers.filter(
    (worker) => worker.regionId === null || !regionIds.has(worker.regionId),
  );
  if (noRegion.length > 0) groups.push({ label: "Без региона", workers: noRegion });
  return groups;
}

/** «Отозвать доступ» с подтверждением: `worker` — какой сервер спрашиваем, `null` — диалог закрыт. */
function RevokeWorkerDialog({
  worker,
  onClose,
}: {
  worker: AdminWorker | null;
  onClose: () => void;
}) {
  const revoke = useAtomSet(adminRevokeWorkerAtom, { mode: "promiseExit" });

  const onConfirm = async () => {
    if (worker === null) return;
    const exit = await revoke(adminRevokeWorkerArgs(worker.id));
    if (Exit.isFailure(exit)) toast.error("Не удалось отозвать доступ");
    else if (!exit.value) toast.error("У сервера нет кода или токена");
    else toast.success(`${worker.id}: доступ отозван`);
  };

  return (
    <AlertDialog
      open={worker !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Отозвать доступ сервера ${worker?.id ?? ""}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            Сервер отключится и не сможет подключиться, пока не получит новый
            код.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>
            Отозвать доступ
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function WorkersTab({ onStop }: { onStop: (sessionId: string) => void }) {
  const workers = useAtomValue(adminWorkersAtom);
  usePolling(adminWorkersAtom);
  const failuresAtom = adminSessionsAtom(true);
  const failures = useAtomValue(failuresAtom);
  usePolling(failuresAtom);
  const classesResult = useAtomValue(adminClassesAtom);
  usePolling(adminClassesAtom);
  const regionsResult = useAtomValue(adminRegionsAtom);
  usePolling(adminRegionsAtom);
  // Выбор класса/региона в карточке воркера нужен сразу — пока список не
  // пришёл (или упал), показываем пустой (карточка покажет текущее значение всё равно).
  const classes = AsyncResult.isSuccess(classesResult)
    ? classesResult.value
    : [];
  const regions = AsyncResult.isSuccess(regionsResult)
    ? regionsResult.value
    : [];
  const setDraining = useAtomSet(adminSetDrainingAtom, {
    mode: "promiseExit",
  });
  const setWorkerClass = useAtomSet(adminSetWorkerClassAtom, {
    mode: "promiseExit",
  });
  const setWorkerRegion = useAtomSet(adminSetWorkerRegionAtom, {
    mode: "promiseExit",
  });
  const issueCode = useAtomSet(adminIssueWorkerCodeAtom, {
    mode: "promiseExit",
  });
  // Опрос перерисовывает вкладку раз в 5 с — «сигнал … назад» и «Идёт» считаются от этого.
  const now = Date.now();
  const [issuedCode, setIssuedCode] = React.useState<
    { readonly workerId: string; readonly code: string; readonly expiresAt: string } | null
  >(null);
  const [revokeTarget, setRevokeTarget] = React.useState<AdminWorker | null>(
    null,
  );

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

  const onSetClass = async (worker: AdminWorker, classId: string | null) => {
    const exit = await setWorkerClass(
      adminSetWorkerClassArgs(worker.id, classId),
    );
    if (Exit.isFailure(exit)) toast.error("Не удалось назначить класс");
    else if (!exit.value) toast.error("Воркер не найден");
    else toast.success(`${worker.id}: класс обновлён`);
  };

  const onSetRegion = async (worker: AdminWorker, regionId: string | null) => {
    const exit = await setWorkerRegion(
      adminSetWorkerRegionArgs(worker.id, regionId),
    );
    if (Exit.isFailure(exit)) toast.error("Не удалось назначить регион");
    else if (!exit.value) toast.error("Воркер не найден");
    else toast.success(`${worker.id}: регион обновлён`);
  };

  const onIssueCode = async (worker: AdminWorker) => {
    const exit = await issueCode(adminIssueWorkerCodeArgs(worker.id));
    if (Exit.isFailure(exit)) toast.error("Не удалось выпустить код");
    else if (exit.value === "notFound") toast.error("Сервер не найден");
    else setIssuedCode({ workerId: worker.id, ...exit.value });
  };

  return (
    <div className="flex flex-col gap-6">
      <ClassesCard />
      <RegionsCard />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Серверы</h2>
        <AddWorkerDialog regions={regions} />
      </div>
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
            groupWorkersByRegion(value, regions).map((group) => (
              <div key={group.label} className="flex flex-col gap-4">
                <h3 className="text-base font-semibold text-muted-foreground">
                  {group.label}
                </h3>
                {group.workers.map((worker) => (
                  <WorkerCard
                    key={worker.id}
                    worker={worker}
                    now={now}
                    classes={classes}
                    regions={regions}
                    onStop={onStop}
                    onDraining={(draining) => void onDraining(worker, draining)}
                    onSetClass={(classId) => void onSetClass(worker, classId)}
                    onSetRegion={(regionId) =>
                      void onSetRegion(worker, regionId)
                    }
                    onIssueCode={() => void onIssueCode(worker)}
                    onRevoke={() => setRevokeTarget(worker)}
                  />
                ))}
              </div>
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
      <IssueCodeDialog worker={issuedCode} onClose={() => setIssuedCode(null)} />
      <RevokeWorkerDialog
        worker={revokeTarget}
        onClose={() => setRevokeTarget(null)}
      />
    </div>
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
        {tab === "games" && <GamesTab />}
        {tab === "installs" && <InstallsTab />}
        {tab === "users" && <UsersTab />}
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
