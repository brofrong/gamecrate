// Фиксация новой версии профиля у оркестратора (`agent.profileCommit`). RPC идёт
// по текущему соединению OrchestratorLink: оно подключает себя (`attach`) на время
// своей жизни, а `commit` ждёт соединения до COMMIT_TIMEOUT. Соединение
// подключается раньше, чем оркестратор зарегистрирует агента (`agent.connect`),
// поэтому `AgentNotConnected` — «не обработан», коммит повторяется.
import type { ProfileCommit } from "@cg/rpc";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Schedule,
  Schema,
  type Scope,
} from "effect";

/** Сколько ждать соединения и ответа оркестратора. */
export const COMMIT_TIMEOUT = Duration.seconds(60);
/** Пауза перед повтором коммита, отклонённого с AgentNotConnected. */
export const COMMIT_RETRY = Duration.seconds(1);

/**
 * Оркестратор коммит не обрабатывал (агент ещё/уже не зарегистрирован) —
 * повтор безопасен. Прочие ошибки (обрыв посреди вызова) не повторяются: коммит
 * мог быть принят, и повтор с той же базой отклонили бы как устаревший.
 */
const notConnected = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "AgentNotConnected";

/** Оркестратор недоступен, отказал или не ответил вовремя. Принят ли коммит — неизвестно. */
export class ProfileCommitError extends Schema.TaggedError<ProfileCommitError>()(
  "ProfileCommitError",
  { message: Schema.String },
) {}

/** Вызов `agent.profileCommit` на конкретном соединении. */
export type CommitCall = (
  payload: ProfileCommit,
) => Effect.Effect<{ readonly accepted: boolean }, unknown>;

export interface ProfileCommitterShape {
  /** `accepted` оркестратора: `false` — базовая версия устарела. */
  readonly commit: (
    payload: ProfileCommit,
  ) => Effect.Effect<boolean, ProfileCommitError>;
  /** Соединение доступно для коммитов, пока открыт scope. */
  readonly attach: (
    call: CommitCall,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** Текст ошибки RPC для лога: тег (`AgentNotConnected`, `RpcClientError`) и сообщение. */
const describe = (cause: unknown) => {
  if (!(cause instanceof Error)) return String(cause);
  const tag = "_tag" in cause ? String(cause._tag) : cause.name;
  return cause.message === "" ? tag : `${tag}: ${cause.message}`;
};

const make = Effect.gen(function* () {
  /** Текущее соединение; не завершён — соединения нет, `commit` ждёт. */
  let current = yield* Deferred.make<CommitCall>();

  const attach: ProfileCommitterShape["attach"] = (call) =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(current))
        current = yield* Deferred.make<CommitCall>();
      const mine = current;
      yield* Deferred.succeed(mine, call);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (current === mine) current = yield* Deferred.make<CommitCall>();
        }),
      );
    });

  const commit: ProfileCommitterShape["commit"] = (payload) =>
    Effect.suspend(() => Deferred.await(current)).pipe(
      Effect.flatMap((call) =>
        call(payload).pipe(
          // Соединение закрылось посреди вызова: RPC-клиент завершает запрос
          // прерыванием. Это не прерывание вызывающего (сессия должна дойти до
          // `Stopped`), а сбой коммита с неизвестным исходом — без повтора.
          Effect.catchCause((cause) =>
            Effect.fail(
              Cause.hasInterruptsOnly(cause)
                ? new ProfileCommitError({ message: "connection closed" })
                : Cause.squash(cause),
            ),
          ),
        ),
      ),
      Effect.retry({
        while: notConnected,
        schedule: Schedule.spaced(COMMIT_RETRY),
      }),
      Effect.map(({ accepted }) => accepted),
      Effect.mapError(
        (cause) => new ProfileCommitError({ message: describe(cause) }),
      ),
      Effect.timeoutOrElse({
        duration: COMMIT_TIMEOUT,
        orElse: () =>
          Effect.fail(new ProfileCommitError({ message: "timeout" })),
      }),
    );

  return { commit, attach } satisfies ProfileCommitterShape;
});

export class ProfileCommitter extends Context.Service<
  ProfileCommitter,
  ProfileCommitterShape
>()("@cg/agent/ProfileCommitter") {
  static readonly layer: Layer.Layer<ProfileCommitter> = Layer.effect(
    ProfileCommitter,
    make,
  );
}
