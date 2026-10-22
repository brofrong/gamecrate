// Фиксация новой версии профиля у оркестратора (`agent.profileCommit`). RPC идёт
// по текущему соединению OrchestratorLink: оно подключает себя (`attach`) на время
// своей жизни, а `commit` ждёт соединения до COMMIT_TIMEOUT.
import type { ProfileCommit } from "@cg/rpc";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Schema,
  type Scope,
} from "effect";

/** Сколько ждать соединения и ответа оркестратора. */
export const COMMIT_TIMEOUT = Duration.seconds(60);

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
      Effect.flatMap((call) => call(payload)),
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
