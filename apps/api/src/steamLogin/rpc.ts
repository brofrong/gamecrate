// Хендлеры группы `steamLogin.*`: заводят попытку входа в Steam (строку в
// таблице `steam_logins`) и отдают её текущее состояние на поллинг экрана
// «Вход в Steam по QR» (`/library`, профиль, экран сессии). QR-код и исход
// сюда не приходят напрямую — оркестратор сам проводит Steam QR-логин и
// обновляет эту строку; сайт только опрашивает `steamLogin.status`.
import { CurrentUser, SteamLoginNotFound, SteamLoginRpcs } from "@cg/rpc";
import type { SteamLoginView } from "@cg/rpc";
import { Effect } from "effect";
import * as SteamLoginRepo from "./SteamLoginRepo";

/**
 * Строка → представление для клиента: внутренний `pending` (строка только
 * заведена, оркестратор ещё не прислал QR) выглядит как обычное ожидание
 * кода, а `cancelled` (попытка вытеснена более новой с того же аккаунта) —
 * как истёкшая без причины: старая вкладка должна показать «Время вышло» и
 * «Показать новый код», а не сообщение о сбое (спека §4).
 */
const toView = (row: SteamLoginRepo.SteamLoginRow): SteamLoginView => {
  switch (row.state) {
    case "pending":
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
          return toView(row);
        }),
    }),
  ),
);
