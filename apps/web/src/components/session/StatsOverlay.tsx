// Отладочная плашка поверх стрима (спека §3): справа сверху, слева от кнопок, полупрозрачная
// тёмная, моноширинная; клики сквозь неё уходят в игру, кроме графиков в «Подробно» (наведение).
// «Коротко» — две строки; «Подробно» — шапка, три графика за минуту и таблица перцентилей.
import { useState } from "react";
import {
  BAD_DECODE_MS,
  BAD_FRAME_MS,
  BAD_PING_MS,
  type Percentiles,
  type StatsSnapshot,
} from "@/lib/streamStats";
import { formatStat, Sparkline } from "./Sparkline";

/** `1920x1080` → `1920×1080`; нет значения — «—». */
const formatResolution = (resolution: string | null | undefined): string =>
  resolution ? resolution.replace("x", "×") : "—";

const columns = [
  ["p50", "p50"],
  ["p90", "p90"],
  ["p95", "p95"],
  ["p99", "p99"],
  ["max", "макс"],
] as const satisfies ReadonlyArray<readonly [keyof Percentiles, string]>;

function PercentileRow({
  label,
  values,
  threshold,
}: {
  label: string;
  values: Percentiles | null;
  /** Значения строго выше — «хуже порога», жёлтым. */
  threshold: number;
}) {
  return (
    <tr>
      <th scope="row" className="pr-2 text-left font-normal text-brand-muted">
        {label}
      </th>
      {columns.map(([key]) => {
        const value = values?.[key] ?? null;
        const bad = value !== null && value > threshold;
        return (
          <td
            key={key}
            data-bad={bad || undefined}
            className={bad ? "text-brand-warn" : undefined}
          >
            {formatStat(value)}
          </td>
        );
      })}
    </tr>
  );
}

function Detailed({ snapshot }: { snapshot: StatsSnapshot | null }) {
  const latest = snapshot?.latest ?? null;
  // Правый край графиков — момент получения снимка (он приходит тем же тиком, что берётся):
  // время фиксируется на снимок, а не на каждую перерисовку от наведения.
  const [stamp, setStamp] = useState(() => ({
    snapshot,
    now: performance.now(),
  }));
  if (stamp.snapshot !== snapshot)
    setStamp({ snapshot, now: performance.now() });
  const { now } = stamp;

  return (
    <div className="grid w-[328px] gap-2">
      <div>
        <p>
          {formatStat(snapshot?.fps)} FPS · 1% low {formatStat(snapshot?.low1)}
        </p>
        <p>
          {latest?.codec ?? "—"} {formatResolution(latest?.resolution)}
        </p>
        <p className="text-brand-muted">
          потери {formatStat(latest?.lossPercent)} % · джиттер{" "}
          {formatStat(latest?.jitterMs)} мс · выпавших кадров{" "}
          {formatStat(latest?.framesDropped)}
        </p>
      </div>
      <Sparkline
        label="Время кадра"
        unit="мс"
        points={snapshot?.frameTimes ?? []}
        now={now}
        threshold={BAD_FRAME_MS}
      />
      <Sparkline
        label="Пинг"
        unit="мс"
        points={snapshot?.ping ?? []}
        now={now}
      />
      <Sparkline
        label="Битрейт"
        unit="Мбит/с"
        points={snapshot?.bitrate ?? []}
        now={now}
      />
      <table className="w-full border-collapse text-right">
        <thead>
          <tr className="text-brand-muted">
            <th />
            {columns.map(([key, title]) => (
              <th key={key} scope="col" className="font-normal">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <PercentileRow
            label="Кадр, мс"
            values={snapshot?.table.frame ?? null}
            threshold={BAD_FRAME_MS}
          />
          <PercentileRow
            label="Пинг, мс"
            values={snapshot?.table.ping ?? null}
            threshold={BAD_PING_MS}
          />
          <PercentileRow
            label="Декодер, мс"
            values={snapshot?.table.decode ?? null}
            threshold={BAD_DECODE_MS}
          />
        </tbody>
      </table>
    </div>
  );
}

export function StatsOverlay({
  mode,
  snapshot,
}: {
  mode: "short" | "detailed";
  snapshot: StatsSnapshot | null;
}) {
  const latest = snapshot?.latest ?? null;
  return (
    <div className="pointer-events-none absolute top-3 right-24 z-20 rounded-md bg-black/65 px-2.5 py-1.5 font-mono text-[11px] leading-4 text-brand-text tabular-nums">
      {mode === "short" ? (
        <div className="whitespace-nowrap">
          <p>
            {formatStat(snapshot?.fps)} FPS · {formatStat(latest?.rttMs)} мс ·{" "}
            {formatStat(latest?.mbps)} Мбит/с
          </p>
          <p className="text-brand-muted">
            {formatResolution(latest?.resolution)} · потери{" "}
            {formatStat(latest?.lossPercent)} %
          </p>
        </div>
      ) : (
        <Detailed snapshot={snapshot} />
      )}
    </div>
  );
}
