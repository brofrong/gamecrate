// Вкладка «Тарифы» (`/admin?tab=tariffs`, Task 9, спека §1/§8): таблица тарифов —
// название, цена, приоритет очереди, часы в месяц, перенос, качество, длина сессии,
// «по умолчанию»/«скрыт» бейджами; «Изменить» открывает `TariffDialog`, «Сделать
// тарифом по умолчанию» и «Скрыть»/«Показать» — простые действия с тостом (как
// `ClassesCard`/`RegionsCard`): тариф по умолчанию нельзя скрыть, кнопка неактивна,
// не дожидаясь ответа сервера. Ниже — пакеты часов (докупка сверх тарифа, пока
// только показ на странице-заглушке): список с формой добавления того же вида, что у
// `RegionsCard`/`ClassesCard`, без отдельного диалога — полей всего три.
import type { HourPack, HourPackInput, Tariff } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import * as React from "react";
import { toast } from "sonner";
import { Polled } from "@/components/admin/Polled";
import { TariffDialog } from "@/components/admin/TariffDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinutes } from "@/lib/formatTime";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";
import {
  adminCreateHourPackArgs,
  adminCreateHourPackAtom,
  adminHourPacksAtom,
  adminSetHourPackArchivedArgs,
  adminSetHourPackArchivedAtom,
  adminSetTariffArchivedArgs,
  adminSetTariffArchivedAtom,
  adminSetTariffDefaultArgs,
  adminSetTariffDefaultAtom,
  adminTariffsAtom,
  adminUpdateHourPackArgs,
  adminUpdateHourPackAtom,
} from "@/rpc";

const inputClass =
  "h-8 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

/** «40 ч» / «безлимит» — часы в месяц (минуты всегда кратны 60 — вводятся часами). */
const hoursLabel = (monthlyMinutes: number | null) =>
  monthlyMinutes === null ? "безлимит" : formatMinutes(monthlyMinutes);

/** «без лимита» / длительность — максимальная длина сессии. */
const sessionLengthLabel = (maxSessionMinutes: number | null) =>
  maxSessionMinutes === null ? "без лимита" : formatMinutes(maxSessionMinutes);

const priceLabel = (priceRub: number | null) =>
  priceRub === null ? "—" : `${priceRub} ₽/мес`;

function TariffRow({
  tariff,
  onEdit,
  onSetDefault,
  onSetArchived,
}: {
  tariff: Tariff;
  onEdit: () => void;
  onSetDefault: () => void;
  onSetArchived: () => void;
}) {
  return (
    <tr className="border-t">
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{tariff.name}</span>
          {tariff.isDefault && <Badge variant="secondary">По умолчанию</Badge>}
          {tariff.archived && <Badge variant="outline">Скрыт</Badge>}
        </div>
      </td>
      <td className="px-2 py-2 whitespace-nowrap">{priceLabel(tariff.priceRub)}</td>
      <td className="px-2 py-2">{tariff.queuePriority}</td>
      <td className="px-2 py-2 whitespace-nowrap">{hoursLabel(tariff.monthlyMinutes)}</td>
      <td className="px-2 py-2">{tariff.rollover ? "Да" : "Нет"}</td>
      <td className="px-2 py-2 whitespace-nowrap">
        {`${tariff.maxResolution} · ${tariff.maxBitrateMbps} Мбит/с`}
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        {sessionLengthLabel(tariff.maxSessionMinutes)}
      </td>
      <td className="px-2 py-2 text-right">
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Изменить
          </Button>
          {!tariff.isDefault && (
            <Button variant="outline" size="sm" onClick={onSetDefault}>
              Сделать тарифом по умолчанию
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={tariff.isDefault}
            onClick={onSetArchived}
          >
            {tariff.archived ? "Показать" : "Скрыть"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

function TariffsTable({
  tariffs,
  onEdit,
  onSetDefault,
  onSetArchived,
}: {
  tariffs: ReadonlyArray<Tariff>;
  onEdit: (tariff: Tariff) => void;
  onSetDefault: (tariff: Tariff) => void;
  onSetArchived: (tariff: Tariff) => void;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Название</th>
            <th className={th}>Цена</th>
            <th className={th}>Приоритет</th>
            <th className={th}>Часы</th>
            <th className={th}>Перенос</th>
            <th className={th}>Качество</th>
            <th className={th}>Длина сессии</th>
            <th className={th} aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {tariffs.map((tariff) => (
            <TariffRow
              key={tariff.id}
              tariff={tariff}
              onEdit={() => onEdit(tariff)}
              onSetDefault={() => onSetDefault(tariff)}
              onSetArchived={() => onSetArchived(tariff)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Форма пакета часов (добавление и редактирование — одна и та же форма с разным `initial`). */
function HourPackForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; hours: string; priceRub: string };
  submitLabel: string;
  onSubmit: (input: HourPackInput) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = React.useState(initial.name);
  const [hours, setHours] = React.useState(initial.hours);
  const [priceRub, setPriceRub] = React.useState(initial.priceRub);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmedName = name.trim();
        const hoursValue = Number(hours);
        if (trimmedName === "" || !Number.isInteger(hoursValue) || hoursValue <= 0) {
          return;
        }
        onSubmit({
          name: trimmedName,
          minutes: hoursValue * 60,
          priceRub: priceRub.trim() === "" ? null : Number(priceRub),
        });
      }}
    >
      <input
        aria-label="Название пакета"
        placeholder="Название пакета"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        className={inputClass}
      />
      <input
        aria-label="Часов в пакете"
        placeholder="Часов"
        type="number"
        inputMode="numeric"
        min={1}
        value={hours}
        onChange={(event) => setHours(event.currentTarget.value)}
        className={cn(inputClass, "w-20")}
      />
      <input
        aria-label="Цена пакета, ₽"
        placeholder="Цена, ₽"
        type="number"
        inputMode="numeric"
        min={0}
        value={priceRub}
        onChange={(event) => setPriceRub(event.currentTarget.value)}
        className={cn(inputClass, "w-24")}
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

function HourPackRow({
  hourPack,
  editing,
  onStartEdit,
  onCancelEdit,
  onEdit,
  onSetArchived,
}: {
  hourPack: HourPack;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEdit: (input: HourPackInput) => void;
  onSetArchived: () => void;
}) {
  if (editing) {
    return (
      <div className="border-t py-2 first:border-t-0">
        <HourPackForm
          initial={{
            name: hourPack.name,
            hours: String(Math.round(hourPack.minutes / 60)),
            priceRub: hourPack.priceRub === null ? "" : String(hourPack.priceRub),
          }}
          submitLabel="Сохранить"
          onSubmit={onEdit}
          onCancel={onCancelEdit}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="font-medium">{hourPack.name}</span>
        <span className="text-sm text-muted-foreground">
          {formatMinutes(hourPack.minutes)}
        </span>
        <span className="text-sm text-muted-foreground">{priceLabel(hourPack.priceRub)}</span>
        {hourPack.archived && <Badge variant="outline">Скрыт</Badge>}
      </div>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" onClick={onStartEdit}>
          Изменить
        </Button>
        <Button variant="outline" size="sm" onClick={onSetArchived}>
          {hourPack.archived ? "Показать" : "Скрыть"}
        </Button>
      </div>
    </div>
  );
}

export function TariffsTab() {
  const tariffs = useAtomValue(adminTariffsAtom);
  usePolling(adminTariffsAtom);
  const hourPacks = useAtomValue(adminHourPacksAtom);
  usePolling(adminHourPacksAtom);

  // `null` — диалог закрыт, `"new"` — создание, иначе редактирование этого тарифа.
  const [editing, setEditing] = React.useState<Tariff | "new" | null>(null);
  const [editingPackId, setEditingPackId] = React.useState<string | null>(null);
  const [addPackKey, setAddPackKey] = React.useState(0);

  const setDefault = useAtomSet(adminSetTariffDefaultAtom, { mode: "promiseExit" });
  const setTariffArchived = useAtomSet(adminSetTariffArchivedAtom, {
    mode: "promiseExit",
  });
  const createPack = useAtomSet(adminCreateHourPackAtom, { mode: "promiseExit" });
  const updatePack = useAtomSet(adminUpdateHourPackAtom, { mode: "promiseExit" });
  const setPackArchived = useAtomSet(adminSetHourPackArchivedAtom, {
    mode: "promiseExit",
  });

  const onSetDefault = async (tariff: Tariff) => {
    const exit = await setDefault(adminSetTariffDefaultArgs(tariff.id));
    if (Exit.isFailure(exit)) toast.error("Не удалось сделать тариф тарифом по умолчанию");
    else if (exit.value === "archived") toast.error("Скрытый тариф нельзя сделать тарифом по умолчанию");
    else if (exit.value === "notFound") toast.error("Тариф не найден");
    else toast.success(`«${tariff.name}» — тариф по умолчанию`);
  };

  const onSetTariffArchived = async (tariff: Tariff) => {
    const archived = !tariff.archived;
    const exit = await setTariffArchived(adminSetTariffArchivedArgs(tariff.id, archived));
    if (Exit.isFailure(exit)) toast.error("Не удалось изменить тариф");
    else if (exit.value === "isDefault") toast.error("Тариф по умолчанию нельзя скрыть");
    else if (exit.value === "notFound") toast.error("Тариф не найден");
    else toast.success(archived ? `«${tariff.name}» скрыт` : `«${tariff.name}» снова виден`);
  };

  const onCreatePack = async (input: HourPackInput) => {
    const exit = await createPack(adminCreateHourPackArgs(input));
    if (Exit.isFailure(exit)) toast.error("Не удалось добавить пакет часов");
    else {
      toast.success("Пакет часов добавлен");
      setAddPackKey((key) => key + 1);
    }
  };

  const onEditPack = async (id: string, input: HourPackInput) => {
    const exit = await updatePack(adminUpdateHourPackArgs(id, input));
    if (Exit.isFailure(exit)) toast.error("Не удалось изменить пакет часов");
    else if (exit.value === "notFound") toast.error("Пакет часов не найден");
    else {
      toast.success("Пакет часов изменён");
      setEditingPackId(null);
    }
  };

  const onSetPackArchived = async (hourPack: HourPack) => {
    const archived = !hourPack.archived;
    const exit = await setPackArchived(adminSetHourPackArchivedArgs(hourPack.id, archived));
    if (Exit.isFailure(exit)) toast.error("Не удалось изменить пакет часов");
    else if (exit.value === "notFound") toast.error("Пакет часов не найден");
    else toast.success(archived ? `«${hourPack.name}» скрыт` : `«${hourPack.name}» снова виден`);
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Тарифы</CardTitle>
          <Button onClick={() => setEditing("new")}>Добавить тариф</Button>
        </CardHeader>
        <CardContent>
          <Polled
            result={tariffs}
            error="Не удалось загрузить тарифы"
            skeleton={<Skeleton className="h-48 w-full" />}
          >
            {(value) =>
              value.length === 0 ? (
                <p className="text-sm text-muted-foreground">Тарифов нет</p>
              ) : (
                <TariffsTable
                  tariffs={value}
                  onEdit={setEditing}
                  onSetDefault={(tariff) => void onSetDefault(tariff)}
                  onSetArchived={(tariff) => void onSetTariffArchived(tariff)}
                />
              )
            }
          </Polled>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Пакеты часов</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Polled
            result={hourPacks}
            error="Не удалось загрузить пакеты часов"
            skeleton={<Skeleton className="h-24 w-full" />}
          >
            {(value) =>
              value.length === 0 ? (
                <p className="text-sm text-muted-foreground">Пакетов часов нет</p>
              ) : (
                <div className="flex flex-col">
                  {value.map((hourPack) => (
                    <HourPackRow
                      key={hourPack.id}
                      hourPack={hourPack}
                      editing={editingPackId === hourPack.id}
                      onStartEdit={() => setEditingPackId(hourPack.id)}
                      onCancelEdit={() => setEditingPackId(null)}
                      onEdit={(input) => void onEditPack(hourPack.id, input)}
                      onSetArchived={() => void onSetPackArchived(hourPack)}
                    />
                  ))}
                </div>
              )
            }
          </Polled>
          <HourPackForm
            key={addPackKey}
            initial={{ name: "", hours: "", priceRub: "" }}
            submitLabel="Добавить пакет"
            onSubmit={(input) => void onCreatePack(input)}
          />
        </CardContent>
      </Card>

      <TariffDialog
        tariff={editing === "new" ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}
