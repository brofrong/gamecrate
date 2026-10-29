// Блок «Классы» на вкладке «Воркеры» (спека §5.1): список по силе (сильнейший
// сверху), добавить, переименовать, поднять/опустить, удалить (сервер отказывает,
// если у класса есть воркеры — `"inUse"`).
import type { AdminWorkerClass } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import * as React from "react";
import { toast } from "sonner";
import { Polled } from "@/components/admin/Polled";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePolling } from "@/lib/usePolling";
import { pluralize } from "@/lib/plural";
import {
  adminClassesAtom,
  adminCreateClassArgs,
  adminCreateClassAtom,
  adminDeleteClassArgs,
  adminDeleteClassAtom,
  adminMoveClassArgs,
  adminMoveClassAtom,
  adminRenameClassArgs,
  adminRenameClassAtom,
} from "@/rpc";

const inputClass =
  "h-8 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

/** Текст тоста по ответу `create`/`rename`. */
function createRenameToast(
  result: "ok" | "duplicate" | "notFound",
  okMessage: string,
) {
  if (result === "duplicate") toast.error("Такое имя класса уже занято");
  else if (result === "notFound") toast.error("Класс не найден");
  else toast.success(okMessage);
}

/** Строка редактирования имени (новый класс или переименование существующего). */
function NameForm({
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onCancel?: () => void;
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
        aria-label={placeholder}
        placeholder={placeholder}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        className={inputClass}
      />
      <Button type="submit" variant="outline" size="sm">
        {submitLabel}
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Отмена
        </Button>
      )}
    </form>
  );
}

function ClassRow({
  workerClass,
  isTop,
  isBottom,
  editing,
  onStartRename,
  onCancelRename,
  onRename,
  onMove,
  onDelete,
}: {
  workerClass: AdminWorkerClass;
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
        <NameForm
          initial={workerClass.name}
          placeholder="Имя класса"
          submitLabel="Сохранить"
          onSubmit={onRename}
          onCancel={onCancelRename}
        />
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-medium">{workerClass.name}</span>
          <span className="text-sm text-muted-foreground">
            {`${workerClass.workers} ${pluralize(workerClass.workers, "воркер", "воркера", "воркеров")}`}
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

export function ClassesCard() {
  const classes = useAtomValue(adminClassesAtom);
  usePolling(adminClassesAtom);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  // Меняет key формы добавления после успеха — ремоунт очищает поле ввода
  // (NameForm держит значение в несвязанном состоянии, initial — только при монтировании).
  const [addKey, setAddKey] = React.useState(0);

  const create = useAtomSet(adminCreateClassAtom, { mode: "promiseExit" });
  const rename = useAtomSet(adminRenameClassAtom, { mode: "promiseExit" });
  const move = useAtomSet(adminMoveClassAtom, { mode: "promiseExit" });
  const deleteClass = useAtomSet(adminDeleteClassAtom, {
    mode: "promiseExit",
  });

  const onCreate = async (name: string) => {
    const exit = await create(adminCreateClassArgs(name));
    if (Exit.isFailure(exit)) toast.error("Не удалось добавить класс");
    else {
      createRenameToast(exit.value, "Класс добавлен");
      if (exit.value === "ok") setAddKey((key) => key + 1);
    }
  };

  const onRename = async (id: string, name: string) => {
    const exit = await rename(adminRenameClassArgs(id, name));
    if (Exit.isFailure(exit)) toast.error("Не удалось переименовать класс");
    else {
      createRenameToast(exit.value, "Класс переименован");
      if (exit.value === "ok") setEditingId(null);
    }
  };

  const onMove = async (id: string, direction: "up" | "down") => {
    const exit = await move(adminMoveClassArgs(id, direction));
    if (Exit.isFailure(exit)) toast.error("Не удалось изменить порядок");
    else if (exit.value === "notFound") toast.error("Класс не найден");
    // "edge" — кнопка уже неактивна, но на гонку сервер просто не меняет порядок.
  };

  const onDelete = async (workerClass: AdminWorkerClass) => {
    const exit = await deleteClass(adminDeleteClassArgs(workerClass.id));
    if (Exit.isFailure(exit)) toast.error("Не удалось удалить класс");
    else if (exit.value === "inUse")
      toast.error("У класса есть воркеры — сначала смените им класс");
    else if (exit.value === "notFound") toast.error("Класс не найден");
    else toast.success(`Класс «${workerClass.name}» удалён`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Классы</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Polled
          result={classes}
          error="Не удалось загрузить классы"
          skeleton={<Skeleton className="h-24 w-full" />}
        >
          {(value) =>
            value.length === 0 ? (
              <p className="text-sm text-muted-foreground">Классов нет</p>
            ) : (
              <div className="flex flex-col">
                {value.map((workerClass, index) => (
                  <ClassRow
                    key={workerClass.id}
                    workerClass={workerClass}
                    isTop={index === 0}
                    isBottom={index === value.length - 1}
                    editing={editingId === workerClass.id}
                    onStartRename={() => setEditingId(workerClass.id)}
                    onCancelRename={() => setEditingId(null)}
                    onRename={(name) => void onRename(workerClass.id, name)}
                    onMove={(direction) =>
                      void onMove(workerClass.id, direction)
                    }
                    onDelete={() => void onDelete(workerClass)}
                  />
                ))}
              </div>
            )
          }
        </Polled>
        <NameForm
          key={addKey}
          initial=""
          placeholder="Новый класс"
          submitLabel="Добавить"
          onSubmit={(name) => void onCreate(name)}
        />
      </CardContent>
    </Card>
  );
}
