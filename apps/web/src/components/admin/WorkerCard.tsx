// Карточка воркера на вкладке «Воркеры» (макет `mockup-workers.html`): шапка со статусом
// и кнопкой обслуживания, слева «Железо» и «Версии», справа «Загрузка сейчас» полосами,
// снизу слоты с сессиями. Нет снимка или воркер офлайн — вместо полос «нет данных»:
// старый снимок за текущую загрузку не выдаём.
import type { AdminWorker, WorkerStats } from "@cg/rpc";
import type * as React from "react";
import { AdminSessionsTable } from "@/components/admin/AdminSessionsTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  diskLabel,
  formatAgo,
  formatAmountLike,
  formatBytes,
  formatDuration,
  formatShortDate,
  formatUsage,
  purposeLabel,
  rolesLabel,
  topLevelDisks,
} from "@/lib/adminFormat";
import { pluralize } from "@/lib/plural";
import { cn } from "@/lib/utils";

const NO_DATA = "нет данных";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

function NoData() {
  return <p className="text-sm text-muted-foreground">{NO_DATA}</p>;
}

/** Строка «Железа»: подпись жирным, значение рядом. */
function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-12 shrink-0 font-medium">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Hardware({ hardware }: { hardware: AdminWorker["hardware"] }) {
  if (hardware === null) return <NoData />;
  const cores = `${hardware.cpuCores} ${pluralize(hardware.cpuCores, "ядро", "ядра", "ядер")}`;
  const threads = `${hardware.cpuThreads} ${pluralize(hardware.cpuThreads, "поток", "потока", "потоков")}`;
  const disks = topLevelDisks(hardware.disks);
  return (
    <dl className="flex flex-col gap-1">
      <Spec
        label="CPU"
        value={`${hardware.cpuModel} · ${cores} / ${threads}`}
      />
      <Spec label="RAM" value={formatBytes(hardware.memoryBytes)} />
      <Spec
        label="GPU"
        value={
          hardware.gpus.length === 0
            ? NO_DATA
            : hardware.gpus
                .map((gpu) => `${gpu.name} · ${formatBytes(gpu.memoryBytes)}`)
                .join(", ")
        }
      />
      <Spec
        label="Диски"
        value={disks.length === 0 ? NO_DATA : disks.map(diskLabel).join(" · ")}
      />
    </dl>
  );
}

function Versions({
  versions,
  uptimeSeconds,
}: {
  versions: AdminWorker["versions"];
  /** Аптайм из снимка загрузки; нет снимка — строки нет. */
  uptimeSeconds: number | null;
}) {
  const line = "text-sm text-muted-foreground";
  return (
    <>
      {versions === null ? (
        <NoData />
      ) : (
        <>
          <p className={line}>
            {`агент ${versions.agentCommit} · образ ${versions.sessionImage}`}
          </p>
          <p className={line}>
            {`драйвер ${versions.driver ?? NO_DATA} · шаблон Steam ${
              versions.steamClientBuiltAt === null
                ? NO_DATA
                : `от ${formatShortDate(versions.steamClientBuiltAt)}`
            }`}
          </p>
        </>
      )}
      {uptimeSeconds !== null && (
        <p className={line}>
          {`сервер работает ${formatDuration(uptimeSeconds * 1000)}`}
        </p>
      )}
    </>
  );
}

/**
 * Полоса загрузки: подпись слева, значение справа мелким серым, под ними полоса 6px.
 * `extra` — вторая часть полосы тем же цветом с прозрачностью (кэш RAM).
 */
function Bar({
  label,
  value,
  share,
  extra = 0,
}: {
  label: string;
  value: string;
  /** Доля 0…1; `null` — значения нет, полоса пустая. */
  share: number | null;
  extra?: number;
}) {
  const pct = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{value}</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-primary" style={{ width: pct(share ?? 0) }} />
        {extra > 0 && (
          <div className="bg-primary/30" style={{ width: pct(extra) }} />
        )}
      </div>
    </div>
  );
}

const ratio = (part: number, total: number) => (total > 0 ? part / total : 0);

/** Проценты/градусы GPU, пропуская то, что не удалось измерить. */
const gpuValue = (gpu: WorkerStats["gpus"][number]) =>
  [
    gpu.utilPercent === null ? null : `${Math.round(gpu.utilPercent)} %`,
    gpu.temperatureC === null ? null : `${Math.round(gpu.temperatureC)} °C`,
    gpu.encoderPercent === null
      ? null
      : `видеокодер ${Math.round(gpu.encoderPercent)} %`,
  ]
    .filter((part) => part !== null)
    .join(" · ") || NO_DATA;

function Load({ stats }: { stats: WorkerStats }) {
  const { memory } = stats;
  return (
    <div className="flex flex-col gap-3">
      <Bar
        label="CPU"
        value={`${Math.round(stats.cpuPercent)} %`}
        share={stats.cpuPercent / 100}
      />
      <Bar
        label="RAM"
        value={`${formatBytes(memory.usedBytes)} занято + ${formatBytes(memory.cacheBytes)} кэш из ${formatBytes(memory.totalBytes)}`}
        share={ratio(memory.usedBytes, memory.totalBytes)}
        extra={ratio(memory.cacheBytes, memory.totalBytes)}
      />
      {stats.gpus.length === 0 ? (
        <Bar label="GPU" value={NO_DATA} share={null} />
      ) : (
        stats.gpus.map((gpu, i) => (
          // Порядок GPU в снимке стабилен (как отдал `nvidia-smi`), id у них нет — ключ по индексу.
          <div key={i} className="flex flex-col gap-3">
            <Bar
              label="GPU"
              value={gpuValue(gpu)}
              share={gpu.utilPercent === null ? null : gpu.utilPercent / 100}
            />
            {gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes !== null && (
              <Bar
                label="Видеопамять"
                value={formatUsage(gpu.memoryUsedBytes, gpu.memoryTotalBytes)}
                share={ratio(gpu.memoryUsedBytes, gpu.memoryTotalBytes)}
              />
            )}
          </div>
        ))
      )}
      {stats.filesystems.map((fs) => (
        <Bar
          key={fs.purposes.join("+")}
          label={purposeLabel(fs.purposes)}
          value={`${formatUsage(fs.usedBytes, fs.totalBytes)} · свободно ${formatAmountLike(fs.freeBytes, fs.totalBytes)}`}
          share={ratio(fs.usedBytes, fs.totalBytes)}
        />
      ))}
    </div>
  );
}

export function WorkerCard({
  worker,
  now,
  onStop,
  onDraining,
}: {
  worker: AdminWorker;
  /** Текущее время, мс — для «сигнал … назад» и столбцов таблицы сессий. */
  now: number;
  onStop: (sessionId: string) => void;
  onDraining: (draining: boolean) => void;
}) {
  const signal =
    worker.lastSeenAt === null
      ? "сигнала не было"
      : `сигнал ${formatAgo(now - Date.parse(worker.lastSeenAt))}`;
  const status = [
    worker.online ? "онлайн" : "офлайн",
    signal,
    worker.publicIp,
    rolesLabel(worker.roles),
  ].join(" · ");
  // Офлайн — снимок мог остаться от прошлого подключения: за «сейчас» его не выдаём.
  const stats = worker.online ? worker.stats : null;
  const busy = worker.sessions.length;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b py-4">
        <span
          aria-hidden
          className={cn(
            "size-2.5 shrink-0 rounded-full",
            worker.online ? "bg-emerald-400" : "bg-muted-foreground/50",
          )}
        />
        <h3 className="text-lg font-semibold">{worker.id}</h3>
        <span className="text-sm text-muted-foreground">{status}</span>
        <span className="flex-1" />
        {worker.draining && <Badge variant="secondary">на обслуживании</Badge>}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onDraining(!worker.draining)}
        >
          {worker.draining ? "Вернуть в работу" : "На обслуживание"}
        </Button>
      </CardContent>

      <CardContent className="grid gap-6 py-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Section title="Железо">
            <Hardware hardware={worker.hardware} />
          </Section>
          <Section title="Версии">
            <Versions
              versions={worker.versions}
              uptimeSeconds={stats?.uptimeSeconds ?? null}
            />
          </Section>
        </div>
        <Section title="Загрузка сейчас">
          {stats === null ? <NoData /> : <Load stats={stats} />}
        </Section>
      </CardContent>

      <CardContent className="border-t py-4">
        <Section
          title={`Слоты · ${pluralize(busy, "занят", "занято", "занято")} ${busy} из ${worker.slots}`}
        >
          {busy === 0 ? (
            <p className="text-sm text-muted-foreground">Сессий нет</p>
          ) : (
            <AdminSessionsTable
              sessions={worker.sessions}
              now={now}
              showWorker={false}
              onStop={onStop}
            />
          )}
        </Section>
      </CardContent>
    </Card>
  );
}
