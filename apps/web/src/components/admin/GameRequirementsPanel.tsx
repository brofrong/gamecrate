// Панель требований и замеров игры (строка вкладки «Игры» раскрывается в неё, спека
// §5.2): три поля требований (VRAM/RAM/CPU в GB) с «Сохранить», таблица замеров по
// моделям GPU, предложение требований («Принять») и подсказки о падениях.
import type {
  AdminGameMetricsRow,
  AdminGameRequirements,
  Requirements,
} from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import * as React from "react";
import { toast } from "sonner";
import { Polled } from "@/components/admin/Polled";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/adminFormat";
import { crashHints, suggestRequirements } from "@/lib/requirementsSuggest";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";
import {
  adminGameRequirementsAtom,
  adminSetGameRequirementsArgs,
  adminSetGameRequirementsAtom,
} from "@/rpc";

const GiB = 1024 ** 3;

/** Текст, когда у игры нет строки требований (спека §5.2, Global Constraints). */
const NO_DATA_TEXT = "нет данных, запускается только на самом сильном классе";

/** Байты → ГБ с одной цифрой после запятой, строкой для поля ввода. */
const toGbString = (bytes: number) => (bytes / GiB).toFixed(1);

/** ГБ (строка поля, допускает и «,», и «.») → байты; невалидная/отрицательная строка — `null`. */
const fromGbString = (text: string): number | null => {
  const value = Number(text.trim().replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * GiB) : null;
};

type Fields = {
  readonly vramGb: string;
  readonly ramGb: string;
  readonly cpuThreads: string;
};

const EMPTY_FIELDS: Fields = { vramGb: "", ramGb: "", cpuThreads: "" };

const fieldsFromRequirements = (requirements: Requirements | null): Fields =>
  requirements === null
    ? EMPTY_FIELDS
    : {
        vramGb: toGbString(requirements.minVramBytes),
        ramGb: toGbString(requirements.minRamBytes),
        cpuThreads: String(requirements.minCpuThreads),
      };

/**
 * Поля → `Requirements`: все три пустые — `null` («очистить требования»); хоть
 * одно заполнено, но не парсится (нечисло, отрицательное, нецелые потоки) —
 * `undefined` (ошибка, сохранять нечего).
 */
const fieldsToRequirements = (
  fields: Fields,
): Requirements | null | undefined => {
  const allEmpty =
    fields.vramGb.trim() === "" &&
    fields.ramGb.trim() === "" &&
    fields.cpuThreads.trim() === "";
  if (allEmpty) return null;

  const minVramBytes = fromGbString(fields.vramGb);
  const minRamBytes = fromGbString(fields.ramGb);
  const cpuThreads = Number(fields.cpuThreads.trim());
  if (
    minVramBytes === null ||
    minRamBytes === null ||
    !Number.isInteger(cpuThreads) ||
    cpuThreads < 0
  ) {
    return undefined;
  }
  return { minVramBytes, minRamBytes, minCpuThreads: cpuThreads };
};

const VRAM_SOURCE_LABEL: Readonly<Record<"process" | "gpu_total", string>> = {
  process: "по процессу",
  gpu_total: "по карте целиком",
};

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-9 w-28 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      />
    </div>
  );
}

function MetricsTable({ rows }: { rows: ReadonlyArray<AdminGameMetricsRow> }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Замеров пока нет</p>;
  }
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>GPU</th>
            <th className={th}>Класс</th>
            <th className={th}>Сессий</th>
            <th className={th}>p95 VRAM</th>
            <th className={th}>p95 RAM</th>
            <th className={th}>p95 CPU</th>
            <th className={th}>p95 GPU</th>
            <th className={th}>Падения</th>
            <th className={th}>Другое</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.gpuName} className="border-t">
              <td className={td}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="underline decoration-dotted">
                      {row.gpuName}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {`Источник VRAM: ${row.vramSources
                      .map((source) => VRAM_SOURCE_LABEL[source])
                      .join(", ")}`}
                  </TooltipContent>
                </Tooltip>
              </td>
              <td
                className={cn(
                  td,
                  row.className === null && "text-muted-foreground",
                )}
              >
                {row.className ?? "без класса"}
              </td>
              <td className={td}>{row.sessions}</td>
              <td className={td}>
                {row.vramP95 === null ? "—" : formatBytes(row.vramP95)}
              </td>
              <td className={td}>
                {row.ramP95 === null ? "—" : formatBytes(row.ramP95)}
              </td>
              <td className={td}>
                {row.cpuP95 === null ? "—" : row.cpuP95.toFixed(1)}
              </td>
              <td className={td}>
                {row.gpuUtilP95 === null
                  ? "—"
                  : `${Math.round(row.gpuUtilP95)} %`}
              </td>
              <td className={td}>{`${Math.round(row.crashShare * 100)} %`}</td>
              <td className={td}>{`${Math.round(row.otherShare * 100)} %`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Собственно форма и предложения — не перемонтируется при каждом опросе (как `SessionSettingsForm`). */
function RequirementsContent({
  appId,
  data,
}: {
  appId: number;
  data: AdminGameRequirements;
}) {
  const [fields, setFields] = React.useState<Fields>(() =>
    fieldsFromRequirements(data.requirements),
  );
  const [saving, setSaving] = React.useState(false);
  const setRequirements = useAtomSet(adminSetGameRequirementsAtom, {
    mode: "promiseExit",
  });

  const suggestion = suggestRequirements(data.overall);
  const hints = crashHints(data.rows);

  const onSave = async () => {
    const requirements = fieldsToRequirements(fields);
    if (requirements === undefined) {
      toast.error("Проверьте поля требований");
      return;
    }
    setSaving(true);
    const exit = await setRequirements(
      adminSetGameRequirementsArgs(appId, requirements),
    );
    setSaving(false);
    if (Exit.isFailure(exit)) toast.error("Не удалось сохранить требования");
    else
      toast.success(
        requirements === null ? "Требования очищены" : "Требования сохранены",
      );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="VRAM, GB"
          value={fields.vramGb}
          onChange={(value) =>
            setFields((prev) => ({ ...prev, vramGb: value }))
          }
        />
        <Field
          label="RAM, GB"
          value={fields.ramGb}
          onChange={(value) => setFields((prev) => ({ ...prev, ramGb: value }))}
        />
        <Field
          label="Потоки CPU"
          value={fields.cpuThreads}
          onChange={(value) =>
            setFields((prev) => ({ ...prev, cpuThreads: value }))
          }
        />
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => void onSave()}
        >
          Сохранить
        </Button>
        {suggestion !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setFields(fieldsFromRequirements(suggestion))}
          >
            Принять
          </Button>
        )}
      </div>

      {data.requirements === null && (
        <p className="text-sm text-muted-foreground">{NO_DATA_TEXT}</p>
      )}

      {hints.map((hint) => (
        <div
          key={hint.gpuName}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span>
            {`На ${hint.gpuName} игра падает в ${Math.round(hint.share * 100)}% сессий — поднять минимум VRAM выше ${(
              (hint.suggestVramBytes - GiB * 0.5) /
              GiB
            ).toFixed(1)} GB?`}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setFields((prev) => ({
                ...prev,
                vramGb: toGbString(hint.suggestVramBytes),
              }))
            }
          >
            Поднять минимум
          </Button>
        </div>
      ))}

      <MetricsTable rows={data.rows} />
    </div>
  );
}

export function GameRequirementsPanel({ appId }: { appId: number }) {
  const result = useAtomValue(adminGameRequirementsAtom(appId));
  usePolling(adminGameRequirementsAtom(appId));

  return (
    <Polled
      result={result}
      error="Не удалось загрузить требования"
      skeleton={<Skeleton className="h-32 w-full" />}
    >
      {(value) => <RequirementsContent appId={appId} data={value} />}
    </Polled>
  );
}
