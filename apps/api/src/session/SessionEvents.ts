// Уведомления `session_changed` (триггер на `sessions`, payload — id сессии).
// Один LISTEN на весь процесс api: каждый LISTEN держит своё соединение из
// пула, поэтому `session.watch` подписывается на общий PubSub, а не слушает БД сам.
import { Db } from "@cg/db";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  PubSub,
  Queue,
  Schedule,
  type Scope,
} from "effect";

export const sessionChangedChannel = "session_changed";

export class SessionEvents extends Context.Service<
  SessionEvents,
  {
    /**
     * Подписка на id изменившихся сессий. Уведомления, пришедшие после
     * подписки, не теряются; пока LISTEN переподключается к БД, уведомления
     * могут пропасть — потребители дополнительно перечитывают состояние по таймеру.
     */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<string>,
      never,
      Scope.Scope
    >;
  }
>()("@cg/api/SessionEvents") {
  /**
   * Слушает `session_changed` в фоне (в scope слоя), при обрыве соединения
   * переподключается раз в секунду. Слой готов, когда LISTEN подтверждён
   * (или через 5 с, если БД недоступна — тогда слушатель продолжает попытки).
   */
  static readonly layer: Layer.Layer<SessionEvents, never, Db> = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      const db = yield* Db;
      const pubsub = yield* Effect.acquireRelease(
        PubSub.unbounded<string>(),
        PubSub.shutdown,
      );
      const listening = yield* Deferred.make<void>();

      const listen = Effect.gen(function* () {
        const notifications = yield* db.$client.listen(sessionChangedChannel);
        yield* Deferred.succeed(listening, undefined);
        while (true) {
          const { payload } = yield* Queue.take(notifications);
          yield* PubSub.publish(pubsub, payload);
        }
      }).pipe(
        // Свой scope: соединение LISTEN освобождается до следующей попытки.
        Effect.scoped,
        Effect.tapError((error) =>
          Effect.logWarning("LISTEN session_changed failed, retrying", error),
        ),
        Effect.retry(Schedule.spaced("1 second")),
      );
      yield* Effect.forkScoped(listen);
      yield* Deferred.await(listening).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.logWarning("LISTEN session_changed is not ready yet"),
        }),
      );

      return SessionEvents.of({ subscribe: PubSub.subscribe(pubsub) });
    }),
  );
}
