import { describe, expect, it } from "bun:test";
import type { OwnGameManifest } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import {
  Db,
  gameRequirements,
  games,
  ownGameOf,
  ownGames,
  syncOwnGames,
} from "../src/index";
import { DbTest } from "./testDb";

const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTest))));

const APP_ID = 1900000001;

/** Манифест своей игры с заглушками текстовых полей, не важных для sync. */
const manifest = (opts: {
  readonly appId?: number;
  readonly slug?: string;
  readonly version: string;
  readonly minVramBytes?: number;
  readonly minRamBytes?: number;
  readonly minCpuThreads?: number;
}): OwnGameManifest => ({
  appId: opts.appId ?? APP_ID,
  slug: opts.slug ?? "soh",
  name: "Test Game",
  version: opts.version,
  binary: "game.elf",
  upstream: { repo: "https://example.invalid/repo", ref: "v1" },
  inputs: [],
  site: {
    description: "d",
    controls: [],
    source: { label: "s", url: "https://example.invalid" },
    screenshots: [],
  },
  requirements: {
    minVramBytes: opts.minVramBytes ?? 0,
    minRamBytes: opts.minRamBytes ?? 0,
    minCpuThreads: opts.minCpuThreads ?? 0,
  },
});

describe("syncOwnGames", () => {
  it("sync inserts own game hidden and keeps published on resync", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* syncOwnGames([manifest({ version: "9.3.1-0" })]);

        const first = yield* ownGameOf(APP_ID);
        expect(first).toEqual({
          appId: APP_ID,
          slug: "soh",
          version: "9.3.1-0",
          published: false,
        });

        yield* db
          .update(ownGames)
          .set({ published: true })
          .where(eq(ownGames.appId, APP_ID));

        yield* syncOwnGames([manifest({ version: "9.3.1-1" })]);

        const second = yield* ownGameOf(APP_ID);
        expect(second).toEqual({
          appId: APP_ID,
          slug: "soh",
          version: "9.3.1-1",
          published: true,
        });
      }),
    ));

  it("sync does not overwrite admin requirements", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* syncOwnGames([
          manifest({
            version: "9.3.1-0",
            minVramBytes: 1024,
            minRamBytes: 2048,
            minCpuThreads: 2,
          }),
        ]);

        yield* db
          .update(gameRequirements)
          .set({ minVramBytes: 999, minRamBytes: 888, minCpuThreads: 7 })
          .where(eq(gameRequirements.appId, APP_ID));

        yield* syncOwnGames([
          manifest({
            version: "9.3.1-1",
            minVramBytes: 4096,
            minRamBytes: 8192,
            minCpuThreads: 4,
          }),
        ]);

        const [req] = yield* db
          .select()
          .from(gameRequirements)
          .where(eq(gameRequirements.appId, APP_ID));
        expect(req).toMatchObject({
          minVramBytes: 999,
          minRamBytes: 888,
          minCpuThreads: 7,
        });
      }),
    ));

  it("sync hides own games whose manifest is gone", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const kept = manifest({ version: "1" });
        const gone = manifest({
          appId: APP_ID + 1,
          slug: "gone",
          version: "1",
        });
        yield* syncOwnGames([kept, gone]);
        yield* db.update(ownGames).set({ published: true });

        // Каталог `games/gone/` удалили: при следующем старте его нет в списке.
        yield* syncOwnGames([kept]);
        expect((yield* ownGameOf(APP_ID))?.published).toBe(true);
        expect((yield* ownGameOf(APP_ID + 1))?.published).toBe(false);

        // Пустой каталог — скрыты все.
        yield* syncOwnGames([]);
        expect((yield* ownGameOf(APP_ID))?.published).toBe(false);
      }),
    ));

  it("own_games rejects appId below the range", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(games).values({ appId: 570, name: "Dota 2" });

        const result = yield* db
          .insert(ownGames)
          .values({ appId: 570, slug: "dota", version: "1" })
          .pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
      }),
    ));
});
