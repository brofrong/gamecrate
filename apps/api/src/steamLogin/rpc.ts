// Хендлеры группы `steamLogin.*`: жизненный цикл строки попытки входа в Steam
// (таблица `steam_logins`). QR и посев профиля приходят от установщика через
// оркестратор и агента (Task 2/5) — здесь только заводим попытку и отдаём её
// текущее состояние экрану `/login-steam`.
import { Db, type SteamLoginState, steamLogins } from "@cg/db";
import {
  CurrentUser,
  SteamLoginNotFound,
  SteamLoginRpcs,
  type SteamLoginView,
  steamLoginReasons,
} from "@cg/rpc";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

/** Активные (незавершённые) состояния — те же, что в частичном индексе БД. */
const activeStates: ReadonlyArray<SteamLoginState> = [
  "pending",
  "waiting",
  "scanned",
];

/**
 * Строка → представление для клиента: внутренние `pending` (код ещё не
 * пришёл от установщика) и `cancelled` (вытеснена более новой попыткой) не
 * публикуются как есть — первое выглядит как обычное ожидание QR, второе —
 * как прерванный вход (спека §4, `steamLoginReasons.interrupted`).
 */
const toView = (row: {
  readonly id: string;
  readonly state: SteamLoginState;
  readonly qrUrl: string | null;
  readonly error: string | null;
}): SteamLoginView => {
  switch (row.state) {
    case "pending":
      return { attemptId: row.id, status: "waiting", qrUrl: null, reason: null };
    case "cancelled":
      return {
        attemptId: row.id,
        status: "failed",
        qrUrl: null,
        reason: steamLoginReasons.interrupted,
      };
    case "waiting":
    case "scanned":
      return {
        attemptId: row.id,
        status: row.state,
        qrUrl: row.qrUrl,
        reason: null,
      };
    default:
      return {
        attemptId: row.id,
        status: row.state,
        qrUrl: null,
        reason: row.error,
      };
  }
};

export const SteamLoginRpcHandlers = SteamLoginRpcs.toLayer(
  Effect.gen(function* () {
    const db = yield* Db;

    return SteamLoginRpcs.of({
      "steamLogin.start": () =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          // Активная попытка того же пользователя отменяется — новая её
          // вытесняет (иначе вставка нарушила бы steam_logins_active_user_idx).
          yield* db
            .update(steamLogins)
            .set({ state: "cancelled" })
            .where(
              and(
                eq(steamLogins.userId, current.id),
                inArray(steamLogins.state, activeStates),
              ),
            )
            .pipe(Effect.orDie);
          const inserted = yield* db
            .insert(steamLogins)
            .values({ id: crypto.randomUUID(), userId: current.id })
            .returning({ id: steamLogins.id })
            .pipe(Effect.orDie);
          const attemptId = inserted[0]?.id;
          if (attemptId === undefined)
            return yield* Effect.die("steamLogin.start: insert returned no row");
          return { attemptId };
        }),
      "steamLogin.status": ({ attemptId }) =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          const [row] = yield* db
            .select({
              id: steamLogins.id,
              state: steamLogins.state,
              qrUrl: steamLogins.qrUrl,
              error: steamLogins.error,
            })
            .from(steamLogins)
            .where(
              and(
                eq(steamLogins.id, attemptId),
                eq(steamLogins.userId, current.id),
              ),
            )
            .pipe(Effect.orDie);
          if (row === undefined) return yield* new SteamLoginNotFound();
          return toView(row);
        }),
    });
  }),
);
