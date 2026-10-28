// Удаление игр из общей библиотеки в БД: api помечает строку `gamestore_apps`
// (`deleting_at`), оркестратор по итогу агента удаляет её или снимает пометку.
import { Db, gamestoreApps } from "@cg/db";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

/** Игры, помеченные к удалению (по возрастанию appid). */
export const deletingApps = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ appId: gamestoreApps.appId })
      .from(gamestoreApps)
      .where(isNotNull(gamestoreApps.deletingAt))
      .orderBy(asc(gamestoreApps.appId));
    return rows.map((r) => r.appId);
  });

/**
 * `GameDeleted`: игры в библиотеке больше нет — строка удаляется, но только
 * помеченная (повторный итог после переподключения не тронет установленную
 * заново игру). `true` — строку удалили.
 */
export const markDeleted = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const deleted = yield* db
      .delete(gamestoreApps)
      .where(
        and(
          eq(gamestoreApps.appId, appId),
          isNotNull(gamestoreApps.deletingAt),
        ),
      )
      .returning({ appId: gamestoreApps.appId });
    return deleted.length > 0;
  });

/** `GameDeleteFailed`: игра осталась и запускается — пометка снимается. */
export const clearDeleting = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(gamestoreApps)
      .set({ deletingAt: null })
      .where(eq(gamestoreApps.appId, appId));
  });
