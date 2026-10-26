import { describe, expect, it } from "bun:test";
import { AgentNotConnected } from "@cg/rpc";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ProfileCommitter } from "../src/profile/ProfileCommitter";

const payload = {
  userId: "u1",
  baseVersion: 1,
  objectKey: "profiles/u1/a.cgp",
  sizeBytes: 1,
  steamLoginSeeded: false,
};

const run = <A, E>(effect: Effect.Effect<A, E, ProfileCommitter>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ProfileCommitter.layer),
      Effect.provide(TestClock.layer()),
    ),
  );

describe("ProfileCommitter", () => {
  it("call interrupted by a closing connection is a commit error, not an interruption", () =>
    run(
      Effect.gen(function* () {
        const committer = yield* ProfileCommitter;
        yield* committer.attach(() => Effect.interrupt);
        const exit = yield* Effect.exit(committer.commit(payload));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain("connection closed");
      }).pipe(Effect.scoped),
    ));

  it("AgentNotConnected is retried until accepted", () =>
    run(
      Effect.gen(function* () {
        const committer = yield* ProfileCommitter;
        let calls = 0;
        yield* committer.attach(() =>
          ++calls < 3
            ? Effect.fail(new AgentNotConnected())
            : Effect.succeed({ accepted: true }),
        );
        const fiber = yield* Effect.forkChild(committer.commit(payload));
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(fiber)).toBe(true);
        expect(calls).toBe(3);
      }).pipe(Effect.scoped),
    ));

  it("other errors are not retried", () =>
    run(
      Effect.gen(function* () {
        const committer = yield* ProfileCommitter;
        let calls = 0;
        yield* committer.attach(() => {
          calls++;
          return Effect.fail(new Error("socket reset"));
        });
        const error = yield* Effect.flip(committer.commit(payload));
        expect(error.message).toContain("socket reset");
        expect(calls).toBe(1);
      }).pipe(Effect.scoped),
    ));
});
