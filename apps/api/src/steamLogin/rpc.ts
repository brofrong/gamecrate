// Хендлеры группы `steamLogin.*`: заводят попытку входа в Steam (строку в
// таблице `steam_logins`) и отдают её текущее состояние на поллинг экрана
// «Вход в Steam по QR» (`/library`, профиль, экран сессии). QR-код и исход
// сюда не приходят напрямую — оркестратор сам проводит Steam QR-логин и
// обновляет эту строку; сайт только опрашивает `steamLogin.status`.
import {
  CurrentUser,
  SteamLoginNotFound,
  SteamLoginRpcs,
  steamLoginReasons,
} from "@cg/rpc";
import type { SteamLoginView } from "@cg/rpc";
import { Clock, Duration, Effect } from "effect";
import * as SteamLoginRepo from "./SteamLoginRepo";

/**
 * Попытка `pending` дольше этого — оркестратор (или API до вставки `qrUrl`)
 * её ещё не подхватил; скорее всего он был не в сети. `waiting`/`scanned`
 * дольше этого без обновления — оркестратор перестал её вести (упал,
 * перезапустился без `failStale`, потерял сетевой доступ): таймаут его
 * собственной попытки — `QR_LOGIN_TIMEOUT = 5 min`
 * (`apps/orchestrator/src/SteamLoginRunner.ts`), здесь — тот же срок с
 * запасом. В обоих случаях строку в БД не трогаем (её доведёт оркестратор
 * при следующем старте через `failStale`) — только перестаём показывать
 * вечное ожидание на сайте.
 */
const PENDING_LIMIT = Duration.seconds(60);
const STALE_LIMIT = Duration.minutes(6);

/**
 * Строка → представление для клиента: внутренний `pending` (строка только
 * заведена, оркестратор ещё не прислал QR) выглядит как обычное ожидание
 * кода, а `cancelled` (попытка вытеснена более новой с того же аккаунта) —
 * как истёкшая без причины: старая вкладка должна показать «Время вышло» и
 * «Показать новый код», а не сообщение о сбое (спека §4). Заброшенная
 * попытка (оркестратор её не ведёт) показывается как `failed` — иначе сайт
 * ждал бы её вечно.
 */
const toView = (
  row: SteamLoginRepo.SteamLoginRow,
): Effect.Effect<SteamLoginView> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    switch (row.state) {
      case "pending":
        if (now - row.createdAt.getTime() > Duration.toMillis(PENDING_LIMIT)) {
          return {
            attemptId: row.id,
            status: "failed",
            qrUrl: null,
            reason: steamLoginReasons.steamError,
          };
        }
        return {
          attemptId: row.id,
          status: "waiting",
          qrUrl: null,
          reason: null,
        };
      case "cancelled":
        return {
          attemptId: row.id,
          status: "expired",
          qrUrl: null,
          reason: null,
        };
      case "waiting":
      case "scanned":
        if (now - row.updatedAt.getTime() > Duration.toMillis(STALE_LIMIT)) {
          return {
            attemptId: row.id,
            status: "failed",
            qrUrl: null,
            reason: steamLoginReasons.steamError,
          };
        }
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
  });

export const SteamLoginRpcHandlers = SteamLoginRpcs.toLayer(
  Effect.succeed(
    SteamLoginRpcs.of({
      "steamLogin.start": () =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          const attemptId = yield* SteamLoginRepo.start(current.id);
          return { attemptId };
        }),
      "steamLogin.status": ({ attemptId }) =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          const row = yield* SteamLoginRepo.ownRow(current.id, attemptId);
          if (row === undefined) return yield* new SteamLoginNotFound();
          return yield* toView(row);
        }),
    }),
  ),
);
