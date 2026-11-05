// Нормы этапов запуска и установки (`StageNorms.normsFor`) на временной БД:
// медиана последних замеров, своя норма игры от 5 замеров, иначе общая.
import { beforeEach, describe, expect, it } from "bun:test";
import {
  Db,
  games,
  type InstallStage,
  installJobs,
  installStageMarks,
  type SessionStage,
  sessionStageMarks,
  sessions,
  user,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { Effect, Logger, References } from "effect";
import * as StageNorms from "../src/session/StageNorms";

const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(effect.pipe(Effect.provide(DbTest)));

beforeEach(() => StageNorms.clearCache());

// От «сейчас», а не фиксированная дата: нормы считают только метки за 30 дней, и фиксированная
// дата через месяц выпадала из окна (тесты упали 2026-11-05). Запуски идут по часу вперёд —
// десяти дней хватает на сотни запусков, и все они в прошлом.
const base = Date.now() - 10 * 24 * 3_600_000;
/** Счётчик запусков: у каждого свой момент начала (порядок «последних»). */
let launches = 0;

const seed = Effect.gen(function* () {
  const db = yield* Db;
  yield* db
    .insert(user)
    .values({ id: "u-1", name: "u-1", email: "u-1@example.test" });
  yield* db.insert(games).values([
    { appId: 10, name: "Hades" },
    { appId: 20, name: "Celeste" },
  ]);
});

/**
 * Завершённый запуск игры `appId`: отметки этапов `marks` со сдвигами в
 * секундах от начала запуска. `startAt` — момент начала (по умолчанию —
 * следующий по счётчику, каждый позже предыдущего).
 */
const launch = (
  appId: number,
  marks: ReadonlyArray<readonly [SessionStage, number]>,
  startAt?: number,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const id = crypto.randomUUID();
    const start = startAt ?? base + ++launches * 3_600_000;
    yield* db
      .insert(sessions)
      .values({ id, userId: "u-1", appId, state: "ended" });
    yield* db.insert(sessionStageMarks).values(
      marks.map(([stage, seconds]) => ({
        sessionId: id,
        stage,
        at: new Date(start + seconds * 1000),
      })),
    );
  });

const times = (n: number, effect: Effect.Effect<void, unknown, Db>) =>
  Effect.forEach(Array.from({ length: n }), () => effect, { discard: true });

/** Запуск: `computer` 5 с, `steam` — `steamSeconds`, дальше `login` (он не закончен). */
const steamLaunch = (appId: number, steamSeconds: number) =>
  launch(appId, [
    ["computer", 0],
    ["steam", 5],
    ["login", 5 + steamSeconds],
  ]);

const install = (marks: ReadonlyArray<readonly [InstallStage, number]>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const jobId = crypto.randomUUID();
    const start = base + ++launches * 3_600_000;
    yield* db
      .insert(installJobs)
      .values({ id: jobId, appId: 10, userId: "u-1", state: "done" });
    yield* db.insert(installStageMarks).values(
      marks.map(([stage, seconds]) => ({
        jobId,
        stage,
        at: new Date(start + seconds * 1000),
      })),
    );
  });

describe("stage norms", () => {
  it("per-game norm needs 5 samples", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        // Другая игра: 5 замеров `steam` по 40 с.
        yield* times(5, steamLaunch(20, 40));
        // У Hades 4 замера по 10 с — мало для своей нормы: общая по 9 замерам.
        yield* times(4, steamLaunch(10, 10));
        const four = yield* StageNorms.normsFor(10);
        StageNorms.clearCache();
        yield* steamLaunch(10, 10);
        const five = yield* StageNorms.normsFor(10);
        const other = yield* StageNorms.normsFor(20);
        return { four, five, other };
      }),
    );
    expect(result.four.launch.steam).toBe(40_000);
    expect(result.five.launch.steam).toBe(10_000);
    expect(result.other.launch.steam).toBe(40_000);
  });

  it("median ignores one stuck launch", async () => {
    const norms = await run(
      Effect.gen(function* () {
        yield* seed;
        for (const seconds of [28, 29, 30, 31, 32]) {
          yield* steamLaunch(10, seconds);
        }
        // Один запуск завис на `steam` на 20 минут, но всё же дошёл дальше.
        yield* steamLaunch(10, 20 * 60);
        return yield* StageNorms.normsFor(10);
      }),
    );
    expect(norms.launch.steam).toBe(30_500);
  });

  it("unfinished stage is not a sample", async () => {
    const norms = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* times(4, steamLaunch(10, 30));
        // Упал посреди `steam`: следующей отметки нет — не замер `steam`
        // (а `computer` до него — замер).
        yield* launch(10, [
          ["computer", 0],
          ["steam", 5],
        ]);
        return yield* StageNorms.normsFor(10);
      }),
    );
    expect(norms.launch.steam).toBeUndefined();
    expect(norms.launch.computer).toBe(5_000);
  });

  it("skipped stage: previous lasts until the next mark", async () => {
    const norms = await run(
      Effect.gen(function* () {
        yield* seed;
        // Steam уже вошёл: агент пропустил `login`, после `steam` сразу `prepare`.
        yield* times(
          5,
          launch(10, [
            ["computer", 0],
            ["steam", 10],
            ["prepare", 50],
            ["loading", 70],
            ["visible", 85],
          ]),
        );
        return yield* StageNorms.normsFor(10);
      }),
    );
    expect(norms.launch).toEqual({
      computer: 10_000,
      steam: 40_000,
      prepare: 20_000,
      loading: 15_000,
    });
    expect(norms.launch.login).toBeUndefined();
  });

  it("global norm needs 5 samples else null", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        // 4 запуска (по 2 у двух игр) и 4 установки — норм нет нигде.
        yield* times(2, steamLaunch(10, 30));
        yield* times(2, steamLaunch(20, 30));
        const installMarks: ReadonlyArray<readonly [InstallStage, number]> = [
          ["preparing", 0],
          ["login", 5],
          ["library", 50],
          ["downloading", 95],
          ["moving", 300],
        ];
        yield* times(4, install(installMarks));
        const few = yield* StageNorms.normsFor(10);
        StageNorms.clearCache();
        yield* steamLaunch(20, 30);
        yield* install(installMarks);
        const enough = yield* StageNorms.normsFor(10);
        return { few, enough };
      }),
    );
    expect(result.few).toEqual({ launch: {}, launchTotal: null, install: {} });
    // У Hades своих 2 — общая норма по 5 замерам всех игр.
    expect(result.enough.launch).toEqual({ computer: 5_000, steam: 30_000 });
    // Установка — только общая; у `downloading` нормы нет; `moving` не
    // закончился (следующей отметки нет) — тоже без нормы.
    expect(result.enough.install).toEqual({
      preparing: 5_000,
      login: 45_000,
      library: 45_000,
    });
  });

  it("launchTotal is visible − computer", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const full = (total: number) =>
          launch(20, [
            ["computer", 0],
            ["steam", 10],
            ["login", 20],
            ["prepare", 30],
            ["loading", 40],
            ["visible", total],
          ]);
        // Celeste: 5 запусков по 100 с; Hades: 4 по 60 с и один без `visible`.
        yield* times(5, full(100));
        yield* times(
          4,
          launch(10, [
            ["computer", 0],
            ["steam", 30],
            ["visible", 60],
          ]),
        );
        yield* launch(10, [
          ["computer", 0],
          ["steam", 30],
        ]);
        const hadesFew = yield* StageNorms.normsFor(10);
        const celeste = yield* StageNorms.normsFor(20);
        StageNorms.clearCache();
        yield* launch(10, [
          ["computer", 0],
          ["visible", 60],
        ]);
        const hades = yield* StageNorms.normsFor(10);
        return { hadesFew, celeste, hades };
      }),
    );
    // Своих замеров у Hades 4 — общая медиана 9 замеров (5 × 100 и 4 × 60).
    expect(result.hadesFew.launchTotal).toBe(100_000);
    expect(result.celeste.launchTotal).toBe(100_000);
    expect(result.hades.launchTotal).toBe(60_000);
  });

  it("only the last 50 samples count", async () => {
    const norms = await run(
      Effect.gen(function* () {
        yield* seed;
        // 60 старых медленных запусков, затем 50 свежих быстрых.
        yield* times(60, steamLaunch(10, 100));
        yield* times(50, steamLaunch(10, 10));
        return yield* StageNorms.normsFor(10);
      }),
    );
    expect(norms.launch.steam).toBe(10_000);
  });

  it("global norm takes only the last 50 samples of all games", async () => {
    const norms = await run(
      Effect.gen(function* () {
        yield* seed;
        // У Hades 4 старых медленных замера — своей нормы нет, и в общие
        // 50 последних они не входят.
        yield* times(4, steamLaunch(10, 100));
        yield* times(25, steamLaunch(20, 10));
        yield* times(25, steamLaunch(20, 100));
        return yield* StageNorms.normsFor(10);
      }),
    );
    expect(norms.launch.steam).toBe(55_000);
  });

  it("norms are cached per appId", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* times(5, steamLaunch(10, 30));
        const first = yield* StageNorms.normsFor(10);
        yield* times(10, steamLaunch(10, 60));
        const cached = yield* StageNorms.normsFor(10);
        StageNorms.clearCache();
        const fresh = yield* StageNorms.normsFor(10);
        return { first, cached, fresh };
      }),
    );
    expect(result.first.launch.steam).toBe(30_000);
    expect(result.cached.launch.steam).toBe(30_000);
    expect(result.fresh.launch.steam).toBe(60_000);
  });

  it("a failing query returns empty norms instead of dying, logs once, cached briefly (I1)", async () => {
    const lines: Array<string> = [];
    const capture = Logger.make((options) => {
      lines.push(Logger.formatJson.log(options));
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        // Симулируем сбой обоих запросов норм (напр. упавшая таблица под
        // нагрузкой, статемент-таймаут — спека I1).
        yield* db.$client.unsafe("drop table session_stage_marks");
        yield* db.$client.unsafe("drop table install_stage_marks");
        const first = yield* StageNorms.normsFor(10);
        // В пределах короткого кэша сбоя — не повторный запрос к той же
        // упавшей БД (иначе второй вызов снова бы залогировал предупреждение).
        const second = yield* StageNorms.normsFor(10);
        return { first, second };
      }).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Warn"),
        Effect.provide(DbTest),
      ),
    );
    const empty = { launch: {}, launchTotal: null, install: {} };
    expect(result.first).toEqual(empty);
    expect(result.second).toEqual(empty);
    const warnings = lines.filter((line) =>
      line.includes("stage norms query failed"),
    );
    expect(warnings).toHaveLength(2);
  });

  it("marks older than 30 days do not count toward the norm (M1)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
        // 5 старых запусков по 100 с — вне 30-дневного окна.
        yield* times(
          5,
          launch(
            10,
            [
              ["computer", 0],
              ["steam", 100],
            ],
            old,
          ),
        );
        // 5 свежих по 10 с — без старых они и дают норму.
        yield* times(5, steamLaunch(10, 10));
        return yield* StageNorms.normsFor(10);
      }),
    );
    // Без 30-дневной границы медиана 10 замеров (5×100 с и 5×10 с) была бы
    // 55 с — середина между 10 и 100.
    expect(result.launch.steam).toBe(10_000);
  });

  it("own games are not in the all-games pool, keep their own norm", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        const own = 1900000001;
        yield* db.insert(games).values({ appId: own, name: "SoH" });
        // Свежие отметки (в 30-дневном окне): 5 запусков своей игры по 60 с
        // на `computer` и 5 запусков Celeste по 10 с; у Hades своих нет.
        const recent = Date.now() - 24 * 60 * 60 * 1000;
        for (let i = 0; i < 5; i++) {
          yield* launch(
            own,
            [
              ["computer", 0],
              ["loading", 60],
            ],
            recent + i * 3_600_000,
          );
          yield* launch(
            20,
            [
              ["computer", 0],
              ["steam", 10],
            ],
            recent + i * 3_600_000 + 60_000,
          );
        }
        const hades = yield* StageNorms.normsFor(10);
        const soh = yield* StageNorms.normsFor(own);
        return { hades, soh };
      }),
    );
    // Общий пул — только Celeste (10 с); со своей игрой медиана 10 замеров
    // была бы 35 с.
    expect(result.hades.launch.computer).toBe(10_000);
    expect(result.soh.launch.computer).toBe(60_000);
  });

  it("launchTotal clamps a negative duration (backward clock step) to 0", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        // «visible» раньше «computer» — сбой или шаг часов назад между
        // отметками; без ограничения снизу медиана была бы отрицательной и
        // не прошла бы кодирование `NonNegativeInt`.
        yield* times(
          5,
          launch(20, [
            ["computer", 0],
            ["steam", 10],
            ["login", 20],
            ["prepare", 30],
            ["loading", 40],
            ["visible", -5],
          ]),
        );
        return yield* StageNorms.normsFor(20);
      }),
    );
    expect(result.launchTotal).toBe(0);
  });
});
