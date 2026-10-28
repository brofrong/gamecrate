// Вкладка «Установки» (`/admin?tab=installs`, Task 5): «Сейчас» — активные задачи установки
// (этап, прогресс закачки, сколько сессий ждёт) и «Отменить» с подтверждением —
// `cancelRequested` вместо кнопки показывает бейдж «Отменяется…»; «За 7 дней» — итог
// («Готово» / причина красным бейджем, как у `HistoryStatus` в `SessionsTab`).
import type { AdminInstall } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import * as React from "react";
import { toast } from "sonner";
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
  formatShortDate,
  installProgressLabel,
  installStageLabel,
} from "@/lib/adminFormat";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";
import {
  adminCancelInstallArgs,
  adminCancelInstallAtom,
  adminInstallsAtom,
} from "@/rpc";

/** Действие активной строки: `cancelRequested` — бейдж «Отменяется…», иначе кнопка. */
function CancelCell({
  install,
  onCancel,
}: {
  install: AdminInstall;
  onCancel: (install: AdminInstall) => void;
}) {
  if (install.cancelRequested) {
    return <Badge variant="outline">Отменяется…</Badge>;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
      onClick={() => onCancel(install)}
    >
      Отменить
    </Button>
  );
}

function ActiveTable({
  installs,
  onCancel,
}: {
  installs: ReadonlyArray<AdminInstall>;
  onCancel: (install: AdminInstall) => void;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Игра</th>
            <th className={th}>Чей Steam</th>
            <th className={th}>Воркер</th>
            <th className={th}>Этап</th>
            <th className={th}>Прогресс</th>
            <th className={th}>Ждут</th>
            <th className={th} aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {installs.map((install) => (
            <tr key={install.id} className="border-t">
              <td className={td}>{install.gameName}</td>
              <td className={td}>{install.userName}</td>
              <td
                className={cn(td, "whitespace-nowrap text-muted-foreground")}
              >
                {install.workerId ?? "—"}
              </td>
              <td className={td}>
                {installStageLabel(install.state, install.stage)}
              </td>
              <td className={cn(td, "whitespace-nowrap")}>
                {installProgressLabel(
                  install.bytesDownloaded,
                  install.bytesTotal,
                )}
              </td>
              <td className={td}>{install.waitingSessions}</td>
              <td className={cn(td, "text-right")}>
                <CancelCell install={install} onCancel={onCancel} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Итог строки истории: `done` — «Готово», иначе причина красным бейджем. */
function Outcome({ install }: { install: AdminInstall }) {
  if (install.state === "done") {
    return <Badge variant="outline">Готово</Badge>;
  }
  return (
    <Badge variant="destructive" className="whitespace-normal">
      {install.error ?? "причина не записана"}
    </Badge>
  );
}

function RecentTable({
  installs,
}: {
  installs: ReadonlyArray<AdminInstall>;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Игра</th>
            <th className={th}>Чей Steam</th>
            <th className={th}>Итог</th>
            <th className={th}>Когда</th>
          </tr>
        </thead>
        <tbody>
          {installs.map((install) => (
            <tr key={install.id} className="border-t">
              <td className={td}>{install.gameName}</td>
              <td className={td}>{install.userName}</td>
              <td className={td}>
                <Outcome install={install} />
              </td>
              <td
                className={cn(td, "whitespace-nowrap text-muted-foreground")}
              >
                {formatShortDate(install.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InstallsTab() {
  const installs = useAtomValue(adminInstallsAtom);
  usePolling(adminInstallsAtom);
  const [toCancel, setToCancel] = React.useState<AdminInstall | null>(null);
  const cancelInstall = useAtomSet(adminCancelInstallAtom, {
    mode: "promiseExit",
  });

  const onConfirm = async () => {
    if (toCancel === null) return;
    const exit = await cancelInstall(adminCancelInstallArgs(toCancel.id));
    if (Exit.isFailure(exit)) toast.error("Не удалось отменить установку");
    else if (exit.value) toast.success("Установка отменяется");
    else toast.error("Установка уже не активна");
  };

  return (
    <>
      <Polled
        result={installs}
        error="Не удалось загрузить установки"
        skeleton={
          <div className="flex flex-col gap-6">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        }
      >
        {(value) => (
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Сейчас</CardTitle>
              </CardHeader>
              <CardContent>
                {value.active.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Сейчас ничего не ставится
                  </p>
                ) : (
                  <ActiveTable
                    installs={value.active}
                    onCancel={setToCancel}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>За 7 дней</CardTitle>
              </CardHeader>
              <CardContent>
                {value.recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    За 7 дней установок не было
                  </p>
                ) : (
                  <RecentTable installs={value.recent} />
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </Polled>

      <AlertDialog
        open={toCancel !== null}
        onOpenChange={(open) => {
          if (!open) setToCancel(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Отменить установку ${toCancel?.gameName ?? ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Игроки, которые её ждут, увидят «Установка отменена
              администратором».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onConfirm()}>
              Отменить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
