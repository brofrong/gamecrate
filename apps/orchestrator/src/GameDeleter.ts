// Удаление игр из общей библиотеки: раз в 2 с отправляет DeleteGame агенту с
// ролью gamestore для игр, которые api пометил к удалению (`deleting_at`), и
// применяет его итоги (`GameDeleted` — строки нет, `GameDeleteFailed` — пометки нет).
import { Db } from "@cg/db";
import { Context, Effect, Layer, PubSub, Schedule } from "effect";
import { AgentHub, type AgentHubEvent } from "./AgentHub";
import * as GameRepo from "./GameRepo";
import { DISPATCH_INTERVAL } from "./InstallDispatcher";
import { logFailure } from "./SessionRunner";

export interface GameDeleterShape {
  /** Обработать событие хаба. Сбои логируются. */
  readonly handle: (event: AgentHubEvent) => Effect.Effect<void>;
  /** Проход: DeleteGame по каждой удаляемой игре, ещё не доставленной агенту. */
  readonly tick: Effect.Effect<void>;
}

const make = Effect.gen(function* () {
  const db = yield* Db;
  const hub = yield* AgentHub;

  /**
   * Игра → агент, в текущее соединение которого ушёл DeleteGame. Его
   * (пере)подключение или отключение забывает запись: команда могла
   * потеряться, проход отправит её снова. Итог агент и сам пришлёт повторно
   * после переподключения, а повторный DeleteGame безвреден.
   */
  const delivered = new Map<number, string>();

  const withDb = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.provideService(effect, Db, db);

  const forget = (workerId: string) =>
    Effect.sync(() => {
      for (const [appId, to] of delivered)
        if (to === workerId) delivered.delete(appId);
    });

  const handle: GameDeleterShape["handle"] = (event) => {
    if (event._tag !== "Report") return forget(event.workerId);
    const { workerId, report } = event;
    switch (report._tag) {
      case "GameDeleted":
        delivered.delete(report.appId);
        return withDb(GameRepo.markDeleted(report.appId)).pipe(
          Effect.flatMap((removed) =>
            removed
              ? Effect.logInfo("Game deleted from the library", {
                  appId: report.appId,
                  workerId,
                })
              : // Строка не помечена к удалению — БД считает игру
                // установленной, а Steam её уже не видит; требует внимания.
                Effect.logWarning(
                  "Ignored GameDeleted for a game not being deleted",
                  { appId: report.appId, workerId },
                ),
          ),
          logFailure("Game delete result handling failed", {
            appId: report.appId,
            workerId,
          }),
        );
      case "GameDeleteFailed":
        delivered.delete(report.appId);
        return withDb(GameRepo.clearDeleting(report.appId)).pipe(
          Effect.andThen(
            Effect.logError("Game delete failed, the game stays installed", {
              appId: report.appId,
              workerId,
              reason: report.reason,
            }),
          ),
          logFailure("Game delete result handling failed", {
            appId: report.appId,
            workerId,
          }),
        );
      default:
        return Effect.void;
    }
  };

  const tick: GameDeleterShape["tick"] = Effect.gen(function* () {
    const appIds = yield* withDb(GameRepo.deletingApps());
    // Пометку сняли или строку удалили иначе — забываем.
    const pending = new Set(appIds);
    for (const appId of delivered.keys())
      if (!pending.has(appId)) delivered.delete(appId);
    const [workerId] = [...hub.connected()]
      .filter((id) => hub.info(id)?.roles.includes("gamestore") ?? false)
      .sort();
    if (workerId === undefined) return;
    for (const appId of appIds) {
      if (delivered.has(appId)) continue;
      const sent = yield* hub.send(workerId, { _tag: "DeleteGame", appId });
      if (!sent) {
        yield* Effect.logWarning("DeleteGame not delivered, will retry", {
          appId,
          workerId,
        });
        return;
      }
      delivered.set(appId, workerId);
      yield* Effect.logInfo("DeleteGame sent", { appId, workerId });
    }
  }).pipe(logFailure("Game deleter tick failed"));

  return { handle, tick } satisfies GameDeleterShape;
});

/** Подписка на хаб и проход раз в `DISPATCH_INTERVAL` (как у InstallDispatcher). */
const startLoops = (deleter: GameDeleterShape) =>
  Effect.gen(function* () {
    const hub = yield* AgentHub;
    const events = yield* hub.subscribe;
    yield* PubSub.take(events).pipe(
      Effect.flatMap(deleter.handle),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* deleter.tick.pipe(
      Effect.repeat(Schedule.spaced(DISPATCH_INTERVAL)),
      Effect.forkScoped,
    );
  });

export class GameDeleter extends Context.Service<
  GameDeleter,
  GameDeleterShape
>()("@cg/orchestrator/GameDeleter") {
  /** Сервис без фоновых циклов (тесты вызывают `handle`/`tick` сами). */
  static readonly layerWithoutLoops: Layer.Layer<
    GameDeleter,
    never,
    Db | AgentHub
  > = Layer.effect(GameDeleter, make);

  /** Сервис + подписка на события хаба + проход раз в 2 с. */
  static readonly layer: Layer.Layer<GameDeleter, never, Db | AgentHub> =
    Layer.effect(GameDeleter, make.pipe(Effect.tap(startLoops)));
}
