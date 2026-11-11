// Диалог создания/редактирования тарифа (вкладка «Тарифы», спека §1/§8). Админ вводит
// часы в месяц и минуты длины сессии, пустое поле значит безлимит; в базе остаются
// минуты (`monthlyMinutes = часы × 60`, `maxSessionMinutes` — уже в минутах, не
// пересчитывается). Дубликат имени — текст под формой («Сохранить» не закрывает
// диалог), как ошибка сохранения в `SessionSettingsForm`/`SessionSettingsCard`, а не
// тост: это ошибка поля «Название», а не разового действия списка.
import {
  maxBitrateMbps,
  minBitrateMbps,
  type StreamResolution,
  type Tariff,
  type TariffInput,
} from "@cg/rpc";
import { useAtomSet } from "@effect/atom-react";
import { Exit } from "effect";
import { LoaderCircle } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { adminCreateTariffArgs, adminCreateTariffAtom, adminUpdateTariffArgs, adminUpdateTariffAtom } from "@/rpc";

const inputClass =
  "h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

const RESOLUTIONS: ReadonlyArray<StreamResolution> = ["720p", "1080p", "1440p"];

type Values = {
  name: string;
  priceRub: string;
  queuePriority: string;
  hours: string;
  rollover: boolean;
  maxResolution: StreamResolution;
  maxBitrateMbps: string;
  sessionMinutes: string;
};

/** Новый тариф — умолчания; существующий — поля из него, `monthlyMinutes` → целые часы. */
const toValues = (tariff: Tariff | null): Values =>
  tariff === null
    ? {
        name: "",
        priceRub: "",
        queuePriority: "0",
        hours: "",
        rollover: false,
        maxResolution: "1440p",
        maxBitrateMbps: String(maxBitrateMbps),
        sessionMinutes: "",
      }
    : {
        name: tariff.name,
        priceRub: tariff.priceRub === null ? "" : String(tariff.priceRub),
        queuePriority: String(tariff.queuePriority),
        hours:
          tariff.monthlyMinutes === null
            ? ""
            : String(Math.round(tariff.monthlyMinutes / 60)),
        rollover: tariff.rollover,
        maxResolution: tariff.maxResolution,
        maxBitrateMbps: String(tariff.maxBitrateMbps),
        sessionMinutes:
          tariff.maxSessionMinutes === null
            ? ""
            : String(tariff.maxSessionMinutes),
      };

const toInput = (values: Values): TariffInput => ({
  name: values.name.trim(),
  priceRub: values.priceRub.trim() === "" ? null : Number(values.priceRub),
  queuePriority: Number(values.queuePriority),
  monthlyMinutes: values.hours.trim() === "" ? null : Number(values.hours) * 60,
  rollover: values.rollover,
  maxResolution: values.maxResolution,
  maxBitrateMbps: Number(values.maxBitrateMbps),
  maxSessionMinutes:
    values.sessionMinutes.trim() === "" ? null : Number(values.sessionMinutes),
});

/** Текст ошибки по литералу результата `create`/`update`; `"ok"` сюда не доходит. */
const errorText = (result: "duplicate" | "notFound") =>
  result === "duplicate"
    ? "Тариф с таким названием уже есть"
    : "Тариф не найден — возможно, его уже удалили в другой вкладке";

/**
 * Поле формы по ключу: `event.currentTarget` читается синхронно, в самом обработчике —
 * React 19 вызывает функцию-обновитель `setState` позже, на фазе рендера, когда
 * `currentTarget` уже обнулён (DOM-событие больше не в процессе обработки), так что
 * читать его внутри `prev => ({...})` — гонка (как было до правки, падало в тестах).
 */
type StringField =
  | "name"
  | "priceRub"
  | "queuePriority"
  | "hours"
  | "sessionMinutes"
  | "maxBitrateMbps";

const setField =
  (setValues: React.Dispatch<React.SetStateAction<Values>>, key: StringField) =>
  (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setValues((prev) => ({ ...prev, [key]: value }));
  };

export function TariffDialog({
  tariff,
  open,
  onOpenChange,
}: {
  /** `null` — создание нового тарифа, иначе редактирование этого тарифа. */
  tariff: Tariff | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [values, setValues] = React.useState<Values>(() => toValues(tariff));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Открыли диалог (в т. ч. для другого тарифа) — поля и ошибка сбрасываются.
  React.useEffect(() => {
    if (open) {
      setValues(toValues(tariff));
      setError(null);
    }
  }, [open, tariff]);

  const create = useAtomSet(adminCreateTariffAtom, { mode: "promiseExit" });
  const update = useAtomSet(adminUpdateTariffAtom, { mode: "promiseExit" });

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const input = toInput(values);
    setSaving(true);
    const exit =
      tariff === null
        ? await create(adminCreateTariffArgs(input))
        : await update(adminUpdateTariffArgs(tariff.id, input));
    setSaving(false);
    if (Exit.isFailure(exit)) {
      setError("Не удалось сохранить тариф. Сервер отклонил значения или недоступен.");
    } else if (exit.value !== "ok") {
      setError(errorText(exit.value));
    } else {
      onOpenChange(false);
    }
  };

  const canSubmit = values.name.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {tariff === null ? "Новый тариф" : `Тариф «${tariff.name}»`}
          </DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => void onSubmit(event)}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="tariff-name" className="text-sm font-medium">
              Название тарифа
            </label>
            <input
              id="tariff-name"
              value={values.name}
              onChange={setField(setValues, "name")}
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tariff-price" className="text-sm font-medium">
                Цена, ₽/мес
              </label>
              <input
                id="tariff-price"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="пусто — не продаётся"
                value={values.priceRub}
                onChange={setField(setValues, "priceRub")}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tariff-priority" className="text-sm font-medium">
                Приоритет очереди
              </label>
              <input
                id="tariff-priority"
                type="number"
                inputMode="numeric"
                min={0}
                value={values.queuePriority}
                onChange={setField(setValues, "queuePriority")}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tariff-hours" className="text-sm font-medium">
                Часы в месяц
              </label>
              <input
                id="tariff-hours"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="пусто — безлимит"
                value={values.hours}
                onChange={setField(setValues, "hours")}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tariff-session-minutes" className="text-sm font-medium">
                Максимальная длина сессии, мин
              </label>
              <input
                id="tariff-session-minutes"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="пусто — без лимита"
                value={values.sessionMinutes}
                onChange={setField(setValues, "sessionMinutes")}
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tariff-resolution" className="text-sm font-medium">
                Максимальное разрешение
              </label>
              <select
                id="tariff-resolution"
                value={values.maxResolution}
                onChange={(event) => {
                  const value = event.currentTarget.value as StreamResolution;
                  setValues((prev) => ({ ...prev, maxResolution: value }));
                }}
                className={inputClass}
              >
                {RESOLUTIONS.map((resolution) => (
                  <option key={resolution} value={resolution}>
                    {resolution}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tariff-bitrate" className="text-sm font-medium">
                Потолок битрейта, Мбит/с
              </label>
              <input
                id="tariff-bitrate"
                type="number"
                inputMode="numeric"
                min={minBitrateMbps}
                max={maxBitrateMbps}
                value={values.maxBitrateMbps}
                onChange={setField(setValues, "maxBitrateMbps")}
                className={inputClass}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="tariff-rollover"
              checked={values.rollover}
              onCheckedChange={(checked) =>
                setValues((prev) => ({ ...prev, rollover: checked }))
              }
            />
            <label htmlFor="tariff-rollover" className="text-sm font-medium">
              Перенос неиспользованных часов
            </label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!canSubmit || saving}>
              {saving && <LoaderCircle className="animate-spin" />}
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
