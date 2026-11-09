// Блок «Регионы» на вкладке «Серверы» (спека §6/§7): список по порядку (`position`),
// добавить (имя и код), переименовать, поднять/опустить, удалить (сервер отказывает,
// если у региона есть серверы — `"notEmpty"`; кнопка и сама неактивна в этом случае,
// чтобы не ждать круглого рейса ради заведомо проигранного запроса). По образцу
// `ClassesCard.tsx`.
import type { AdminRegion } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import * as React from "react";
import { toast } from "sonner";
import { Polled } from "@/components/admin/Polled";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { pluralize } from "@/lib/plural";
import { usePolling } from "@/lib/usePolling";
import {
  adminCreateRegionArgs,
  adminCreateRegionAtom,
  adminDeleteRegionArgs,
  adminDeleteRegionAtom,
  adminRegionsAtom,
  adminUpdateRegionArgs,
  adminUpdateRegionAtom,
} from "@/rpc";

const inputClass =
  "h-8 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

/** Код региона не по `REGION_CODE_PATTERN` (латиница в нижнем регистре, цифры, дефис, 2…16 символов, с буквы). */
const INVALID_CODE =
  "Код региона: латиница в нижнем регистре, цифры и дефис, от 2 до 16 символов, начинается с буквы";

/** Строка переименования (новый регион или правка существующего): имя + код вместе, код неизменен после создания. */
function RenameForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = React.useState(initial);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed === "") return;
        onSubmit(trimmed);
      }}
    >
      <input
        aria-label="Имя региона"
        placeholder="Имя региона"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        className={inputClass}
      />
      <Button type="submit" variant="outline" size="sm">
        Сохранить
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Отмена
      </Button>
    </form>
  );
}

/**
 * Форма добавления: имя и код вместе — код задаётся только при создании. Метки
 * отличаются от `RenameForm` («Имя нового региона», не «Имя региона») — иначе на
 * странице одновременно два поля с одинаковым `aria-label` (строка в режиме правки
 * и эта форма внизу).
 */
function AddRegionForm({ onSubmit }: { onSubmit: (code: string, name: string) => void }) {
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmedCode = code.trim();
        const trimmedName = name.trim();
        if (trimmedCode === "" || trimmedName === "") return;
        onSubmit(trimmedCode, trimmedName);
      }}
    >
      <input
        aria-label="Имя нового региона"
        placeholder="Питер"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        className={inputClass}
      />
      <input
        aria-label="Код нового региона"
        placeholder="spb"
        value={code}
        onChange={(event) => setCode(event.currentTarget.value)}
        className={inputClass}
      />
      <Button type="submit" variant="outline" size="sm">
        Добавить регион
      </Button>
    </form>
  );
}

function RegionRow({
  region,
  isTop,
  isBottom,
  editing,
  onStartRename,
  onCancelRename,
  onRename,
  onMove,
  onDelete,
}: {
  region: AdminRegion;
  isTop: boolean;
  isBottom: boolean;
  editing: boolean;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (name: string) => void;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t py-2 first:border-t-0">
      {editing ? (
        <RenameForm initial={region.name} onSubmit={onRename} onCancel={onCancelRename} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-medium">{region.name}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {region.code}
          </span>
          <span className="text-sm text-muted-foreground">
            {`${region.workers} ${pluralize(region.workers, "сервер", "сервера", "серверов")}`}
          </span>
        </div>
      )}
      {!editing && (
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            aria-label="Поднять"
            disabled={isTop}
            onClick={() => onMove("up")}
          >
            ↑
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Опустить"
            disabled={isBottom}
            onClick={() => onMove("down")}
          >
            ↓
          </Button>
          <Button variant="outline" size="sm" onClick={onStartRename}>
            Переименовать
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={region.workers > 0}
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
            onClick={onDelete}
          >
            Удалить
          </Button>
        </div>
      )}
    </div>
  );
}

export function RegionsCard() {
  const regions = useAtomValue(adminRegionsAtom);
  usePolling(adminRegionsAtom);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  // Как в `ClassesCard`: смена key после успеха ремоунтит форму добавления, чтобы
  // очистить несвязанные поля имени/кода.
  const [addKey, setAddKey] = React.useState(0);

  const create = useAtomSet(adminCreateRegionAtom, { mode: "promiseExit" });
  const update = useAtomSet(adminUpdateRegionAtom, { mode: "promiseExit" });
  const deleteRegion = useAtomSet(adminDeleteRegionAtom, {
    mode: "promiseExit",
  });

  const onCreate = async (code: string, name: string) => {
    const exit = await create(adminCreateRegionArgs(code, name));
    if (Exit.isFailure(exit)) {
      toast.error("Не удалось добавить регион");
    } else if (exit.value === "codeTaken") {
      toast.error("Такой код региона уже занят");
    } else if (exit.value === "invalid") {
      toast.error(INVALID_CODE);
    } else {
      toast.success("Регион добавлен");
      setAddKey((key) => key + 1);
    }
  };

  const onRename = async (region: AdminRegion, name: string) => {
    const exit = await update(adminUpdateRegionArgs(region.id, name, region.position));
    if (Exit.isFailure(exit)) toast.error("Не удалось переименовать регион");
    else if (exit.value === "notFound") toast.error("Регион не найден");
    else {
      toast.success("Регион переименован");
      setEditingId(null);
    }
  };

  /** Поднять/опустить: меняем `position` местами с соседом в эту сторону (нет отдельного `admin.regions.move`). */
  const onMove = async (
    ordered: ReadonlyArray<AdminRegion>,
    region: AdminRegion,
    direction: "up" | "down",
  ) => {
    const index = ordered.findIndex((r) => r.id === region.id);
    const neighbor = ordered[direction === "up" ? index - 1 : index + 1];
    if (neighbor === undefined) return;
    const [exitRegion, exitNeighbor] = await Promise.all([
      update(adminUpdateRegionArgs(region.id, region.name, neighbor.position)),
      update(adminUpdateRegionArgs(neighbor.id, neighbor.name, region.position)),
    ]);
    if (Exit.isFailure(exitRegion) || Exit.isFailure(exitNeighbor)) {
      toast.error("Не удалось изменить порядок");
    }
  };

  const onDelete = async (region: AdminRegion) => {
    const exit = await deleteRegion(adminDeleteRegionArgs(region.id));
    if (Exit.isFailure(exit)) toast.error("Не удалось удалить регион");
    else if (exit.value === "notEmpty") toast.error("В регионе есть серверы");
    else if (exit.value === "notFound") toast.error("Регион не найден");
    else toast.success(`Регион «${region.name}» удалён`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Регионы</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Polled
          result={regions}
          error="Не удалось загрузить регионы"
          skeleton={<Skeleton className="h-24 w-full" />}
        >
          {(value) =>
            value.length === 0 ? (
              <p className="text-sm text-muted-foreground">Регионов нет</p>
            ) : (
              <div className="flex flex-col">
                {value.map((region, index) => (
                  <RegionRow
                    key={region.id}
                    region={region}
                    isTop={index === 0}
                    isBottom={index === value.length - 1}
                    editing={editingId === region.id}
                    onStartRename={() => setEditingId(region.id)}
                    onCancelRename={() => setEditingId(null)}
                    onRename={(name) => void onRename(region, name)}
                    onMove={(direction) => void onMove(value, region, direction)}
                    onDelete={() => void onDelete(region)}
                  />
                ))}
              </div>
            )
          }
        </Polled>
        <AddRegionForm key={addKey} onSubmit={(code, name) => void onCreate(code, name)} />
      </CardContent>
    </Card>
  );
}
