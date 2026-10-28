// Таблица сессий админки: слоты в карточке воркера и вкладка «Сессии» (с `showWorker`).
// «Идёт» — от создания до конца (или до `now`), «Ввод» — сколько назад был последний ввод.
import type { AdminSession } from "@cg/rpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatAgo,
  formatDuration,
  sessionStageLabel,
} from "@/lib/adminFormat";
import { cn } from "@/lib/utils";

/** Бейдж этапа: играет — зелёный, сбой — красный, остальное — нейтральный. */
function StageBadge({ session }: { session: AdminSession }) {
  const label = sessionStageLabel(session.state, session.stage);
  if (session.state === "failed") {
    return <Badge variant="destructive">{label}</Badge>;
  }
  return (
    <Badge
      variant="outline"
      className={cn(
        label === "играет" &&
          "border-emerald-400/30 bg-emerald-400/10 text-emerald-400",
      )}
    >
      {label}
    </Badge>
  );
}

const sinceMs = (session: AdminSession, now: number) =>
  (session.endedAt === null ? now : Date.parse(session.endedAt)) -
  Date.parse(session.createdAt);

export function AdminSessionsTable({
  sessions,
  now,
  showWorker,
  onStop,
}: {
  sessions: ReadonlyArray<AdminSession>;
  /** Текущее время, мс — от него считаются «Идёт» и «Ввод». */
  now: number;
  /** Столбец «Воркер» — на вкладке «Сессии»; в карточке воркера он лишний. */
  showWorker: boolean;
  /** Нет — столбца с кнопкой «Остановить» нет (история). */
  onStop?: (sessionId: string) => void;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Игрок</th>
            <th className={th}>Игра</th>
            {showWorker && <th className={th}>Воркер</th>}
            <th className={th}>Этап</th>
            <th className={th}>Идёт</th>
            <th className={th}>Ввод</th>
            {onStop && <th className={th} aria-label="Действия" />}
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className="border-t">
              <td className={td}>{session.userName}</td>
              <td className={td}>{session.gameName}</td>
              {showWorker && (
                <td className={cn(td, "text-muted-foreground")}>
                  {session.workerId ?? "—"}
                </td>
              )}
              <td className={td}>
                <StageBadge session={session} />
              </td>
              <td className={cn(td, "whitespace-nowrap")}>
                {formatDuration(sinceMs(session, now))}
              </td>
              <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>
                {session.lastInputAt === null
                  ? "—"
                  : formatAgo(now - Date.parse(session.lastInputAt))}
              </td>
              {onStop && (
                <td className={cn(td, "text-right")}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
                    onClick={() => onStop(session.id)}
                  >
                    Остановить
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
