// Админка: форма «Настройки сессий». Диапазоны берутся из схемы `SessionSettings` (@cg/rpc):
// проверка — `Schema.is` поля, границы для подсказки — из её JSON Schema.
import { SessionSettings } from "@cg/rpc";
import { Schema } from "effect";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Key = keyof SessionSettings;

const fields: ReadonlyArray<{ key: Key; label: string }> = [
  { key: "idleWarningMinutes", label: "Простой до предупреждения, мин" },
  { key: "idleGraceMinutes", label: "Время на ответ, мин" },
  { key: "disconnectGraceMinutes", label: "Ожидание после отключения, мин" },
  { key: "startTimeoutMinutes", label: "Таймаут запуска, мин" },
  { key: "installTimeoutMinutes", label: "Таймаут установки, мин" },
  {
    key: "steamLoginTimeoutSeconds",
    label: "Ожидание входа в Steam установщиком, с",
  },
];

type Bounds = { readonly minimum?: number; readonly maximum?: number };

const bounds = (() => {
  const doc = Schema.toJsonSchemaDocument(SessionSettings);
  const properties = (doc.schema as { properties?: Record<string, Bounds> })
    .properties;
  return (key: Key): Bounds => properties?.[key] ?? {};
})();

const rangeMessage = (key: Key) => {
  const { minimum, maximum } = bounds(key);
  return minimum !== undefined && maximum !== undefined
    ? `Целое число от ${minimum} до ${maximum}`
    : "Недопустимое значение";
};

const isValid = (key: Key, value: number) =>
  Schema.is(SessionSettings.fields[key])(value);

type Values = Record<Key, string>;
type Errors = Partial<Record<Key, string>>;

const toValues = (settings: SessionSettings): Values => ({
  idleWarningMinutes: String(settings.idleWarningMinutes),
  idleGraceMinutes: String(settings.idleGraceMinutes),
  disconnectGraceMinutes: String(settings.disconnectGraceMinutes),
  startTimeoutMinutes: String(settings.startTimeoutMinutes),
  installTimeoutMinutes: String(settings.installTimeoutMinutes),
  steamLoginTimeoutSeconds: String(settings.steamLoginTimeoutSeconds),
});

/**
 * Проверить все поля: настройки или ошибки по полям. Начинает с `initial`
 * (загруженные настройки), поэтому поля, которых нет в `fields`, доезжают до
 * сервера неизменными, а не пропадают из сохраняемого значения.
 */
const validate = (
  initial: SessionSettings,
  values: Values,
): { settings: SessionSettings } | { errors: Errors } => {
  const errors: Errors = {};
  const parsed: Record<Key, number> = { ...initial };
  for (const { key } of fields) {
    const raw = values[key].trim();
    const value = raw === "" ? Number.NaN : Number(raw);
    if (isValid(key, value)) parsed[key] = value;
    else errors[key] = rangeMessage(key);
  }
  return Object.keys(errors).length > 0 ? { errors } : { settings: parsed };
};

export function SessionSettingsForm({
  initial,
  onSubmit,
}: {
  initial: SessionSettings;
  /** Сохранить; вернуть текст ошибки сервера или null при успехе. */
  onSubmit: (settings: SessionSettings) => Promise<string | null>;
}) {
  const [values, setValues] = useState<Values>(() => toValues(initial));
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setServerError(null);
    const result = validate(initial, values);
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    const error = await onSubmit(result.settings);
    setSaving(false);
    setServerError(error);
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {fields.map(({ key, label }) => {
        const id = `session-settings-${key}`;
        const error = errors[key];
        const { minimum, maximum } = bounds(key);
        return (
          <div key={key} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">
              {label}
            </label>
            <input
              id={id}
              type="number"
              inputMode="numeric"
              step={1}
              min={minimum}
              max={maximum}
              value={values[key]}
              aria-invalid={error !== undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setValues((prev) => ({ ...prev, [key]: value }));
              }}
              className={cn(
                "h-9 w-40 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30",
                error && "border-destructive ring-destructive/20",
              )}
            />
            {error && (
              <p id={`${id}-error`} className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        );
      })}
      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}
      <div>
        <Button type="submit" disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" />}
          Сохранить
        </Button>
      </div>
    </form>
  );
}
