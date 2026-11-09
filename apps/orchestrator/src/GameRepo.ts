// Удаление игр из библиотеки сервера в БД: api помечает строку `gamestore_apps`
// пары (сервер, игра) (`deleting_at`), оркестратор по итогу агента этого
// сервера удаляет её или снимает пометку (спека 2026-11-09 §5).
import { Db, gamestoreApps } from "@cg/db";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

/** Строка библиотеки сервера: игра `appId` на сервере `workerId`. */
export interface LibraryEntry {
  readonly workerId: string;
  readonly appId: number;
}

/** Пары (сервер, игра), помеченные к удалению (по серверу, затем по appid). */
export const deletingApps = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({ workerId: gamestoreApps.workerId, appId: gamestoreApps.appId })
      .from(gamestoreApps)
      .where(isNotNull(gamestoreApps.deletingAt))
      .orderBy(asc(gamestoreApps.workerId), asc(gamestoreApps.appId));
  });

/** Условие «строка этой пары (сервер, игра)». */
const entryIs = ({ workerId, appId }: LibraryEntry) =>
  and(eq(gamestoreApps.workerId, workerId), eq(gamestoreApps.appId, appId));

/**
 * `GameDeleted` агента `workerId`: игры в библиотеке этого сервера больше нет —
 * строка удаляется, но только помеченная (повторный итог после
 * переподключения не тронет установленную заново игру); строки той же игры
 * на других серверах не трогаются. `true` — строку удалили.
 */
export const markDeleted = (entry: LibraryEntry) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const deleted = yield* db
      .delete(gamestoreApps)
      .where(and(entryIs(entry), isNotNull(gamestoreApps.deletingAt)))
      .returning({ appId: gamestoreApps.appId });
    return deleted.length > 0;
  });

/**
 * `GameDeleteFailed` агента `workerId`: игра на этом сервере осталась и
 * запускается — пометка снимается, `reason` (текст агента, см.
 * `deleteReasons`) сохраняется — её увидит админ на вкладке «Игры», пока
 * новый запрос удаления не очистит её снова.
 */
export const clearDeleting = (entry: LibraryEntry, reason: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(gamestoreApps)
      .set({ deletingAt: null, deleteError: reason })
      .where(entryIs(entry));
  });
