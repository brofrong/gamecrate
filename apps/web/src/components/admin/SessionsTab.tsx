// Вкладка «Сессии»: «Сейчас идут» — все живые сессии со всех воркеров (колонки как у
// карточки воркера плюс «Воркер» и «Остановить»); «История за 7 дней» — завершённые и
// упавшие сессии с переключателем «Только сбои»; у `failed` — причина красным бейджем.
import type { AdminSession } from "@cg/rpc";
import { useAtomValue } from "@effect/atom-react";
import * as React from "react";
import { AdminSessionsTable } from "@/components/admin/AdminSessionsTable";
import { Polled } from "@/components/admin/Polled";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatShortDate, sessionStageLabel } from "@/lib/adminFormat";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";
import { adminSessionsAtom } from "@/rpc";

/** Статус строки истории: `failed` — причина красным бейджем, иначе — этап нейтральным. */
function HistoryStatus({ session }: { session: AdminSession }) {
  if (session.state === "failed") {
    return (
      <Badge variant="destructive" className="whitespace-normal">
        {session.failReason ?? "причина не записана"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      {sessionStageLabel(session.state, session.stage)}
    </Badge>
  );
}

function HistoryTable({
  sessions,
}: {
  sessions: ReadonlyArray<AdminSession>;
}) {
  const th = "px-2 py-1.5 text-left font-medium";
  const td = "px-2 py-2";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className={th}>Когда</th>
            <th className={th}>Игрок</th>
            <th className={th}>Игра</th>
            <th className={th}>Статус</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className="border-t">
              <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>
                {formatShortDate(session.endedAt ?? session.createdAt)}
              </td>
              <td className={td}>{session.userName}</td>
              <td className={td}>{session.gameName}</td>
              <td className={td}>
                <HistoryStatus session={session} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SessionsTab({
  onStop,
}: {
  onStop: (sessionId: string) => void;
}) {
  // «Сейчас идут» всегда без фильтра; «История» — с тем, что выбрал тумблер (при
  // `false` это тот же запрос/атом, что у «Сейчас идут» — `Atom.family` отдаёт один и
  // тот же объект на одинаковый аргумент). Опрашиваем его только одним интервалом —
  // второй `usePolling` ниже на этот же атом выключен, иначе опрос шёл бы вдвое чаще.
  const [failedOnly, setFailedOnly] = React.useState(false);

  const activeAtom = adminSessionsAtom(false);
  const active = useAtomValue(activeAtom);
  usePolling(activeAtom);

  const historyAtom = adminSessionsAtom(failedOnly);
  const history = useAtomValue(historyAtom);
  usePolling(historyAtom, 5000, historyAtom !== activeAtom);

  // Опрос перерисовывает вкладку раз в 5 с — «Идёт» и «Ввод» в таблице считаются от этого.
  const now = Date.now();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Сейчас идут</CardTitle>
        </CardHeader>
        <CardContent>
          <Polled
            result={active}
            error="Не удалось загрузить сессии"
            skeleton={<Skeleton className="h-24 w-full" />}
          >
            {(value) =>
              value.active.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Сейчас никто не играет
                </p>
              ) : (
                <AdminSessionsTable
                  sessions={value.active}
                  now={now}
                  showWorker
                  onStop={onStop}
                />
              )
            }
          </Polled>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>История за 7 дней</CardTitle>
          <Button
            type="button"
            variant={failedOnly ? "default" : "outline"}
            size="sm"
            aria-pressed={failedOnly}
            onClick={() => setFailedOnly((value) => !value)}
          >
            Только сбои
          </Button>
        </CardHeader>
        <CardContent>
          <Polled
            result={history}
            error="Не удалось загрузить историю"
            skeleton={<Skeleton className="h-24 w-full" />}
          >
            {(value) =>
              value.recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {failedOnly ? "Сбоев не было" : "За 7 дней сессий не было"}
                </p>
              ) : (
                <HistoryTable sessions={value.recent} />
              )
            }
          </Polled>
        </CardContent>
      </Card>
    </div>
  );
}
