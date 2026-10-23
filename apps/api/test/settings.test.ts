// RPC `admin.settings.*`: настройки сессий в таблице `settings`.
import { describe, expect, it } from "bun:test";
import { Db, settings } from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  AdminRpcs,
  type CurrentUserShape,
  defaultSessionSettings,
  type SessionSettings,
  sessionSettingsKey,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";

const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};
const player: CurrentUserShape = { ...admin, id: "u-player", role: "player" };

const auth = { current: admin as CurrentUserShape | null };
const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.sync(() => Option.fromNullishOr(auth.current)),
});

const env = Layer.mergeAll(AdminRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => {
  auth.current = admin;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(AdminRpcs);

const storedValue = Effect.gen(function* () {
  const db = yield* Db;
  const [row] = yield* db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, sessionSettingsKey));
  return row?.value;
});

const custom: SessionSettings = {
  idleWarningMinutes: 30,
  idleGraceMinutes: 5,
  disconnectGraceMinutes: 10,
  startTimeoutMinutes: 20,
  installTimeoutMinutes: 45,
};

describe("admin.settings", () => {
  it("admin.settings.update validates ranges and persists", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rpc = yield* client;
        const initial = yield* rpc["admin.settings.get"]();
        const updated = yield* rpc["admin.settings.update"](custom);
        const read = yield* rpc["admin.settings.get"]();
        const stored = yield* storedValue;
        const invalid = yield* Effect.forEach(
          [
            { ...custom, idleWarningMinutes: 0 },
            { ...custom, idleWarningMinutes: 121 },
            { ...custom, idleGraceMinutes: 31 },
            { ...custom, disconnectGraceMinutes: 0 },
            { ...custom, startTimeoutMinutes: 4 },
            { ...custom, startTimeoutMinutes: 61 },
            { ...custom, idleGraceMinutes: 2.5 },
          ],
          (value) => Effect.exit(rpc["admin.settings.update"](value)),
        );
        const afterInvalid = yield* rpc["admin.settings.get"]();
        // Границы диапазонов допустимы.
        const bounds = yield* rpc["admin.settings.update"]({
          idleWarningMinutes: 120,
          idleGraceMinutes: 1,
          disconnectGraceMinutes: 60,
          startTimeoutMinutes: 5,
          installTimeoutMinutes: 10,
        });
        return {
          initial,
          updated,
          read,
          stored,
          invalid,
          afterInvalid,
          bounds,
        };
      }),
    );
    expect(result.initial).toEqual(defaultSessionSettings);
    expect(result.updated).toEqual(custom);
    expect(result.read).toEqual(custom);
    expect(result.stored).toEqual(custom);
    expect(result.invalid.map((exit) => exit._tag)).toEqual(
      Array(7).fill("Failure"),
    );
    expect(result.afterInvalid).toEqual(custom);
    expect(result.bounds).toEqual({
      idleWarningMinutes: 120,
      idleGraceMinutes: 1,
      disconnectGraceMinutes: 60,
      startTimeoutMinutes: 5,
      installTimeoutMinutes: 10,
    });
  });

  it("invalid stored value falls back to defaults", async () => {
    const read = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(settings).values({
          key: sessionSettingsKey,
          value: { idleWarningMinutes: 0 },
        });
        return yield* (yield* client)["admin.settings.get"]();
      }),
    );
    expect(read).toEqual(defaultSessionSettings);
  });

  it("MVP-2 stored row without installTimeoutMinutes keeps its timers", async () => {
    const mvp2 = {
      idleWarningMinutes: 30,
      idleGraceMinutes: 5,
      disconnectGraceMinutes: 10,
      startTimeoutMinutes: 20,
    };
    const read = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db
          .insert(settings)
          .values({ key: sessionSettingsKey, value: mvp2 });
        return yield* (yield* client)["admin.settings.get"]();
      }),
    );
    expect(read).toEqual({
      ...mvp2,
      installTimeoutMinutes: defaultSessionSettings.installTimeoutMinutes,
    });
  });

  it("player cannot call admin.settings.update", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = player;
        const rpc = yield* client;
        const update = yield* Effect.flip(rpc["admin.settings.update"](custom));
        const get = yield* Effect.flip(rpc["admin.settings.get"]());
        auth.current = null;
        const anonymous = yield* Effect.flip(
          rpc["admin.settings.update"](custom),
        );
        const stored = yield* storedValue;
        return { update, get, anonymous, stored };
      }),
    );
    expect(result.update._tag).toBe("Forbidden");
    expect(result.get._tag).toBe("Forbidden");
    expect(result.anonymous._tag).toBe("Unauthorized");
    expect(result.stored).toBeUndefined();
  });
});
