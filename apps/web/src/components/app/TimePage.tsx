// «Время» (`/app/time`, Task 12): месяц из адреса (стрелки ‹ ›), итог за месяц,
// «По играм» с полосками долей и «Сессии» — лента с датой/временем, первые 30 и
// «показать ещё N». Прототип: `docs/brand/prototypes/app-home-mobile.html` (третий
// телефон). `month` переживает перезагрузку страницы — живёт в адресе, не в стейте.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import {
  currentMonth,
  formatHM,
  formatMinutes,
  formatMonth,
  formatRelativeDate,
  monthShift,
} from "@/lib/formatTime";
import { timeSummaryAtom } from "@/rpc";
import { appTimeRoute } from "@/routes/app";

/** Сколько сессий видно до клика «показать ещё N». */
const VISIBLE_SESSIONS = 30;

/** «21:10» — местное время начала сессии, двузначные часы и минуты. */
function formatClock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

export function TimePage() {
  const search = appTimeRoute.useSearch();
  const navigate = appTimeRoute.useNavigate();
  const now = new Date();
  const month = search.month ?? currentMonth(now);

  const result = useAtomValue(timeSummaryAtom(month));
  const summary = AsyncResult.isSuccess(result) ? result.value : undefined;
  const [expanded, setExpanded] = useState(false);

  // Переключение месяца держит тот же смонтированный компонент (`month` —
  // часть адреса, не ключ страницы) — без этого «показать ещё» в новом месяце
  // осталось бы раскрытым от предыдущего.
  useEffect(() => {
    setExpanded(false);
  }, [month]);

  const goTo = (target: string) =>
    void navigate({ to: "/app/time", search: { month: target } });

  const empty = summary === undefined || summary.sessions.length === 0;
  const maxGameMinutes = summary
    ? Math.max(1, ...summary.byGame.map((game) => game.minutes))
    : 1;
  const sessions = summary?.sessions ?? [];
  const visibleSessions = expanded
    ? sessions
    : sessions.slice(0, VISIBLE_SESSIONS);
  const remaining = sessions.length - VISIBLE_SESSIONS;

  return (
    <>
      <h1 className="text-2xl font-bold text-[#eef1ff]">Время</h1>

      <div className="flex items-center gap-3 text-sm font-semibold text-[#eef1ff]">
        <button
          type="button"
          aria-label="Предыдущий месяц"
          onClick={() => goTo(monthShift(month, -1))}
          className="flex size-7 items-center justify-center rounded-lg bg-[#13161d] text-[#8a90a8] transition hover:text-[#eef1ff]"
        >
          ‹
        </button>
        {formatMonth(month)}
        <button
          type="button"
          aria-label="Следующий месяц"
          disabled={month === currentMonth(now)}
          onClick={() => goTo(monthShift(month, 1))}
          className="flex size-7 items-center justify-center rounded-lg bg-[#13161d] text-[#8a90a8] transition hover:text-[#eef1ff] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ›
        </button>
      </div>

      {empty ? (
        <p className="text-sm text-[#8a90a8]">В этом месяце ты ещё не играл</p>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <p className="text-[34px] font-extrabold tracking-tight text-[#eef1ff]">
              {formatMinutes(summary.totalMinutes)}
            </p>
            <p className="text-sm text-[#8a90a8]">
              сыграно за месяц · {summary.sessionCount} сессий
            </p>
          </div>

          <section className="flex flex-col gap-3">
            <h2 className="text-xl font-bold text-[#eef1ff]">По играм</h2>
            <div className="flex flex-col gap-3">
              {summary.byGame.map((game) => (
                <div
                  key={game.appId}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 text-sm"
                >
                  <span className="min-w-0 truncate text-[#cfd3e6]">
                    {game.name}
                  </span>
                  <span className="font-mono text-[#8a90a8]">
                    {formatHM(game.minutes)}
                  </span>
                  <div className="col-span-2 h-[5px] overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-brand-accent via-brand-accent-2 to-brand-accent-3"
                      style={{
                        width: `${(game.minutes / maxGameMinutes) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-xl font-bold text-[#eef1ff]">Сессии</h2>
            <div className="flex flex-col">
              {visibleSessions.map((session) => (
                <div
                  key={session.sessionId}
                  data-testid="time-session-row"
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 border-b border-white/10 py-2.5 text-sm"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[#eef1ff]">
                      {session.name}
                    </span>
                    <span className="text-xs text-[#8a90a8]">
                      {formatRelativeDate(session.startedAt, now)},{" "}
                      {formatClock(session.startedAt)}
                    </span>
                  </div>
                  <span className="font-mono text-[#8a90a8]">
                    {formatHM(session.minutes)}
                  </span>
                </div>
              ))}
            </div>
            {!expanded && remaining > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="py-3 text-center text-sm font-semibold text-brand-accent hover:text-[#eef1ff]"
              >
                показать ещё {remaining}
              </button>
            )}
          </section>
        </>
      )}
    </>
  );
}
