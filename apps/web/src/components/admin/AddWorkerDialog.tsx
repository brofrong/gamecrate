// Диалог «Добавить сервер» (вкладка «Серверы», спека §3/§6/§7): имя сервера и регион,
// кнопка «Получить команду» заводит сервер (`admin.workers.create`) и одноразовый код
// подключения на 24 часа — дальше диалог показывает команду установки вместо формы.
// `IssueCodeDialog` — то же показ команды, но для «Новый код подключения» в карточке
// уже существующего сервера: код там уже выпущен (`admin.workers.issueCode`) до
// открытия диалога, самого диалога формы нет.
import type { AdminRegion } from "@cg/rpc";
import { useAtomSet } from "@effect/atom-react";
import { Exit } from "effect";
import { Copy } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatShortDate } from "@/lib/adminFormat";
import { adminCreateWorkerArgs, adminCreateWorkerAtom } from "@/rpc";

const inputClass =
  "h-8 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

/** Результат `admin.workers.create`/`admin.workers.issueCode` — код виден только сейчас. */
type EnrollCode = { readonly code: string; readonly expiresAt: string };

/** Текст ошибки `invalid` у `id`/кода (одинаковый шаблон `WORKER_ID_PATTERN`). */
const INVALID_NAME =
  "Только латиница в нижнем регистре, цифры и дефис, от 2 до 32 символов";

/**
 * Команда установки с кодом, кнопка «Скопировать» и срок действия — общий вид для
 * свежесозданного сервера и для перевыпущенного кода.
 */
function InstallCommand({ code, expiresAt }: EnrollCode) {
  const command = `curl -fsSL ${window.location.origin}/agent/install.sh | sudo bash -s -- ${code}`;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Выполните на сервере от имени root:
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
          {command}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onCopy()}
        >
          <Copy />
          Скопировать
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {`Код действует до ${formatShortDate(expiresAt)}`}
      </p>
    </div>
  );
}

export function AddWorkerDialog({
  regions,
}: {
  regions: ReadonlyArray<AdminRegion>;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [regionId, setRegionId] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<EnrollCode | null>(null);
  const create = useAtomSet(adminCreateWorkerAtom, { mode: "promiseExit" });

  // Регионы приходят отдельным запросом — могли ещё не загрузиться, когда диалог
  // открыли впервые; появились — выбираем первый сам, раз пользователь ничего не выбрал.
  React.useEffect(() => {
    if (regionId === null && regions.length > 0) setRegionId(regions[0]!.id);
  }, [regions, regionId]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName("");
      setRegionId(regions[0]?.id ?? null);
      setResult(null);
    }
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (regionId === null) return;
    const exit = await create(adminCreateWorkerArgs(name.trim(), regionId));
    if (Exit.isFailure(exit)) {
      toast.error("Не удалось добавить сервер");
    } else if (exit.value === "idTaken") {
      toast.error("Сервер с таким именем уже есть");
    } else if (exit.value === "invalid") {
      toast.error(INVALID_NAME);
    } else if (exit.value === "regionNotFound") {
      // Регион удалили, пока диалог был открыт.
      toast.error("Регион не найден");
    } else {
      setResult(exit.value);
    }
  };

  const canSubmit = regionId !== null && name.trim() !== "";

  return (
    <>
      <Button onClick={() => setOpen(true)}>Добавить сервер</Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Добавить сервер</DialogTitle>
          </DialogHeader>
          {result === null ? (
            <form onSubmit={(event) => void onSubmit(event)}>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="add-worker-name"
                    className="text-sm font-medium"
                  >
                    Имя сервера
                  </label>
                  <input
                    id="add-worker-name"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="латиница, цифры и дефис, напр. spb-1"
                    className={inputClass}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="add-worker-region"
                    className="text-sm font-medium"
                  >
                    Регион
                  </label>
                  {regions.length === 0 ? (
                    <p className="text-sm text-destructive">
                      Сначала добавьте регион
                    </p>
                  ) : (
                    <select
                      id="add-worker-region"
                      value={regionId ?? ""}
                      onChange={(event) =>
                        setRegionId(event.currentTarget.value)
                      }
                      className={inputClass}
                    >
                      {regions.map((region) => (
                        <option key={region.id} value={region.id}>
                          {region.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              <DialogFooter className="mt-4">
                <Button type="submit" disabled={!canSubmit}>
                  Получить команду
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <>
              <InstallCommand code={result.code} expiresAt={result.expiresAt} />
              <DialogFooter>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  Готово
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * То же показ команды для уже существующего сервера («Новый код подключения» в
 * карточке): `worker` — `null`, пока код не выпущен (диалог закрыт).
 */
export function IssueCodeDialog({
  worker,
  onClose,
}: {
  worker: ({ readonly workerId: string } & EnrollCode) | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={worker !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Код подключения для ${worker?.workerId ?? ""}`}</DialogTitle>
        </DialogHeader>
        {worker !== null && (
          <InstallCommand code={worker.code} expiresAt={worker.expiresAt} />
        )}
      </DialogContent>
    </Dialog>
  );
}
