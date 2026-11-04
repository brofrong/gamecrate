// Каталог своих игр (фанатских ПК-портов вне Steam, «Свои игры», спека
// 2026-11-03): синхронизация описаний из манифестов репозитория и чтение
// строки каталога.
import type { OwnGameManifest } from "@cg/rpc";
import { and, eq, notInArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "./Db";
import { gameRequirements, games, ownGames } from "./schema";

/** Строка каталога своей игры: что сайт показывает и допускает прямо сейчас. */
export type OwnGameRow = {
  readonly appId: number;
  readonly slug: string;
  readonly version: string;
  readonly published: boolean;
};

/**
 * Синхронизирует каталог своих игр с манифестами репозитория (запускается
 * при старте api — `OwnGameCatalog.layer` — по всем `game.json`): `games` —
 * имя, `own_games` — `slug`/`version` без изменения `published` (админ
 * включает игру игрокам отдельно, «Открыта игрокам»), `game_requirements` —
 * только если строки ещё нет (`onConflictDoNothing`): правки админа в
 * допуске по железу не затираются повторной синхронизацией. Свои игры, чьих
 * манифестов в списке больше нет (каталог `games/<slug>/` удалили из
 * репозитория), скрываются (`published = false`): строка остаётся для
 * истории сессий, но игроки её больше не видят и не запускают; пустой
 * список скрывает все. Всё — в одной транзакции.
 */
export const syncOwnGames = (
  manifests: ReadonlyArray<OwnGameManifest>,
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        for (const manifest of manifests) {
          yield* tx
            .insert(games)
            .values({ appId: manifest.appId, name: manifest.name })
            .onConflictDoUpdate({
              target: games.appId,
              set: { name: manifest.name },
            });
          yield* tx
            .insert(ownGames)
            .values({
              appId: manifest.appId,
              slug: manifest.slug,
              version: manifest.version,
            })
            .onConflictDoUpdate({
              target: ownGames.appId,
              set: { slug: manifest.slug, version: manifest.version },
            });
          yield* tx
            .insert(gameRequirements)
            .values({
              appId: manifest.appId,
              minVramBytes: manifest.requirements.minVramBytes,
              minRamBytes: manifest.requirements.minRamBytes,
              minCpuThreads: manifest.requirements.minCpuThreads,
            })
            .onConflictDoNothing();
        }
        const appIds = manifests.map((manifest) => manifest.appId);
        yield* tx
          .update(ownGames)
          .set({ published: false })
          .where(
            appIds.length === 0
              ? eq(ownGames.published, true)
              : and(
                  eq(ownGames.published, true),
                  notInArray(ownGames.appId, appIds),
                ),
          );
      }),
    );
  }).pipe(Effect.orDie);

/** Строка каталога своей игры по `appId`; нет строки — `undefined`. */
export const ownGameOf = (
  appId: number,
): Effect.Effect<OwnGameRow | undefined, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({
        appId: ownGames.appId,
        slug: ownGames.slug,
        version: ownGames.version,
        published: ownGames.published,
      })
      .from(ownGames)
      .where(eq(ownGames.appId, appId));
    return row;
  }).pipe(Effect.orDie);
