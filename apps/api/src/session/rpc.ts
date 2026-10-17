// Хендлеры группы `session.*`: сессии текущего пользователя.
import type { Db } from "@cg/db";
import {
  CurrentUser,
  GameNotOwned,
  isTerminalSessionState,
  maxInputAgeMs,
  SessionNotFound,
  SessionRpcs,
  type SessionView,
} from "@cg/rpc";
import { Effect, Stream } from "effect";
import { SessionEvents } from "./SessionEvents";
import * as SessionRepo from "./SessionRepo";

/** Как часто `session.watch` перечитывает сессию без уведомлений (`playedSeconds`, `idleDeadline`). */
const watchRefresh = "5 seconds";

const sameView = (a: SessionView, b: SessionView) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Поток представлений сессии: подписка на `session_changed` оформляется до
 * чтения текущего состояния (изменение между ними не теряется), дальше —
 * перечитывание по уведомлению с этим id и по таймеру; одинаковые подряд
 * не повторяются; после `ended`/`failed` поток завершается.
 */
const watch = (
  userId: string,
  sessionId: string,
): Stream.Stream<SessionView, SessionNotFound, Db | SessionEvents> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      const subscription = yield* events.subscribe;
      const read = SessionRepo.ownView(userId, sessionId).pipe(
        Effect.flatMap((view) =>
          view === undefined
            ? Effect.fail(new SessionNotFound({ sessionId }))
            : Effect.succeed(view),
        ),
      );
      const initial = yield* read;
      const triggers = Stream.merge(
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((id) => id === sessionId),
        ),
        Stream.tick(watchRefresh).pipe(Stream.drop(1)),
      );
      return Stream.concat(
        Stream.succeed(initial),
        Stream.mapEffect(triggers, () => read),
      ).pipe(
        Stream.changesWith(sameView),
        Stream.takeUntil((view) => isTerminalSessionState(view.state)),
      );
    }),
  );

export const SessionRpcHandlers = SessionRpcs.toLayer(
  Effect.gen(function* () {
    const events = yield* SessionEvents;
    return SessionRpcs.of({
      "session.start": ({ appId }) =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          const result = yield* SessionRepo.startSession(current.id, appId);
          if (result === "NotOwned") return yield* new GameNotOwned({ appId });
          return result;
        }),
      "session.active": () =>
        CurrentUser.use((current) => SessionRepo.activeView(current.id)),
      "session.watch": ({ sessionId }) =>
        Stream.unwrap(
          CurrentUser.use((current) =>
            Effect.succeed(watch(current.id, sessionId)),
          ),
        ).pipe(Stream.provideService(SessionEvents, events)),
      "session.heartbeat": ({ sessionId, inputAgeMs }) =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          const accepted = yield* SessionRepo.heartbeat(
            current.id,
            sessionId,
            SessionRepo.clampInputAge(inputAgeMs, maxInputAgeMs),
          );
          if (!accepted) return yield* new SessionNotFound({ sessionId });
        }),
      "session.stop": ({ sessionId }) =>
        Effect.gen(function* () {
          const current = yield* CurrentUser;
          const found = yield* SessionRepo.requestStop(current.id, sessionId);
          if (!found) return yield* new SessionNotFound({ sessionId });
        }),
    });
  }),
);
