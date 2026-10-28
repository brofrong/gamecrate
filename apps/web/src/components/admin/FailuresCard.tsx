// «Последние сбои» под карточками воркеров: `failed`-сессии за 7 дней (`admin.sessions.list`
// с `failedOnly`, новые сверху) — дата, игрок, игра и причина красным бейджем.
import type { AdminSession } from "@cg/rpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatShortDate } from "@/lib/adminFormat";

export function FailuresCard({
  sessions,
}: {
  sessions: ReadonlyArray<AdminSession>;
}) {
  return (
    <Card className="gap-4">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Последние сбои</CardTitle>
        <span className="text-sm text-muted-foreground">
          {`за 7 дней · ${sessions.length}`}
        </span>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Сбоев не было</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-t first:border-t-0">
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                    {formatShortDate(session.endedAt ?? session.createdAt)}
                  </td>
                  <td className="py-2 pr-3">{session.userName}</td>
                  <td className="py-2 pr-3">{session.gameName}</td>
                  <td className="py-2">
                    <Badge variant="destructive" className="whitespace-normal">
                      {session.failReason ?? "причина не записана"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
