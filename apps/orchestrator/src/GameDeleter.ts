// Удаление игр из библиотеки сервера: раз в 2 с отправляет DeleteGame агенту
// того сервера, на котором api пометил игру к удалению (`deleting_at` строки
// (сервер, игра), спека 2026-11-09 §5), и применяет его итоги к этой же строке
// (`GameDeleted` — строки нет, `GameDeleteFailed` — пометки нет).
import { Db } from "@cg/db";
import { Context, Effect, Layer, PubSub, Schedule } from "effect";
import { AgentHub, type AgentHubEvent } from "./AgentHub";
import * as GameRepo from "./GameRepo";
import { DISPATCH_INTERVAL } from "./InstallDispatcher";
import { logFailure } from "./SessionRunner";

export interface GameDeleterShape {
  /** Обработать событие хаба. Сбои логируются. */
  readonly handle: (event: AgentHubEvent) => Effect.Effect<void>;
  /** Проход: DeleteGame по каждой удаляемой паре (сервер, игра), ещё не доставленной. */
  readonly tick: Effect.Effect<void>;
}

/** Ключ пары (сервер, игра) для `delivered`. */
const keyOf = ({ workerId, appId }: GameRepo.LibraryEntry) =>
  `${workerId}:${appId}`;

const make = Effect.gen(function* () {
  const db = yield* Db;
  const hub = yield* AgentHub;

  /**
   * Пары (сервер, игра), чей DeleteGame ушёл в текущее соединение агента
   * этого сервера. Его (пере)подключение или отключение забывает их: команда
   * могла потеряться, проход отправит её снова. Итог агент и сам пришлёт
   * повторно после переподключения, а повторный DeleteGame безвреден.
   */
  const delivered = new Map<string, GameRepo.LibraryEntry>();

  const withDb = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.provideService(effect, Db, db);

  const forget = (workerId: string) =>
    Effect.sync(() => {
      for (const [key, entry] of delivered)
        if (entry.workerId === workerId) delivered.delete(key);
    });

  const handle: GameDeleterShape["handle"] = (event) => {
    if (event._tag !== "Report") return forget(event.workerId);
    const { workerId, report } = event;
    switch (report._tag) {
      case "GameDeleted": {
        const entry = { workerId, appId: report.appId };
        delivered.delete(keyOf(entry));
        return withDb(GameRepo.markDeleted(entry)).pipe(
          Effect.flatMap((removed) =>
            removed
              ? Effect.logInfo("Game deleted from the server library", entry)
              : // Строка не помечена к удалению — БД считает игру
                // установленной на этом сервере, а Steam её уже не видит;
                // требует внимания.
                Effect.logWarning(
                  "Ignored GameDeleted for a game not being deleted",
                  entry,
                ),
          ),
          logFailure("Game delete result handling failed", entry),
        );
      }
      case "GameDeleteFailed": {
        const entry = { workerId, appId: report.appId };
        delivered.delete(keyOf(entry));
        return withDb(GameRepo.clearDeleting(entry, report.reason)).pipe(
          Effect.andThen(
            Effect.logError("Game delete failed, the game stays installed", {
              ...entry,
              reason: report.reason,
            }),
          ),
          logFailure("Game delete result handling failed", entry),
        );
      }
      default:
        return Effect.void;
    }
  };

  /**
   * DeleteGame уходит агенту сервера строки, если он подключён и у него роль
   * `gamestore`; иначе пара ждёт его подключения. Не доставлено — остальные
   * пары этого сервера в этом проходе не пробуем.
   */
  const tick: GameDeleterShape["tick"] = Effect.gen(function* () {
    const entries = yield* withDb(GameRepo.deletingApps());
    // Пометку сняли или строку удалили иначе — забываем.
    const pending = new Set(entries.map(keyOf));
    for (const key of delivered.keys())
      if (!pending.has(key)) delivered.delete(key);
    const connected = hub.connected();
    const failed = new Set<string>();
    for (const entry of entries) {
      const { workerId, appId } = entry;
      if (delivered.has(keyOf(entry)) || failed.has(workerId)) continue;
      if (
        !connected.has(workerId) ||
        !(hub.info(workerId)?.roles.includes("gamestore") ?? false)
      )
        continue;
      const sent = yield* hub.send(workerId, { _tag: "DeleteGame", appId });
      if (!sent) {
        failed.add(workerId);
        yield* Effect.logWarning("DeleteGame not delivered, will retry", entry);
        continue;
      }
      delivered.set(keyOf(entry), entry);
      yield* Effect.logInfo("DeleteGame sent", entry);
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
