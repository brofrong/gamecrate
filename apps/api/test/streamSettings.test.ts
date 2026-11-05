// Настройки стрима пользователя (`streamSettings.*`, спека §4): тест StreamSettingsRepo
// через RPC — по образцу `time.test.ts`.
import { describe, expect, it } from "bun:test";
import { Db, user, userStreamSettings } from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  type CurrentUserShape,
  defaultStreamSettings,
  StreamSettingsRpcs,
} from "@cg/rpc";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { StreamSettingsRpcHandlers } from "../src/streamSettings/rpc";

const streamUser: CurrentUserShape = {
  id: "u-stream",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
};

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.succeed(Option.some(streamUser)),
});

const env = Layer.mergeAll(StreamSettingsRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));

const insertUser = (db: Db["Service"], id: string) =>
  db.insert(user).values({ id, name: "Игрок", email: `${id}@example.test` });

const client = RpcTest.makeClient(StreamSettingsRpcs);

describe("streamSettings.get", () => {
  it("returns defaults when nothing is stored", async () => {
    const settings = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, streamUser.id);
        return yield* (yield* client)["streamSettings.get"]();
      }),
    );

    expect(settings).toEqual(defaultStreamSettings);
  });

  it("broken stored value falls back per field", async () => {
    const settings = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, streamUser.id);
        yield* db.insert(userStreamSettings).values({
          userId: streamUser.id,
          value: {
            quality: "turbo",
            bitrateMbps: 99,
            debug: "detailed",
            menuTourSeen: true,
          },
        });
        return yield* (yield* client)["streamSettings.get"]();
      }),
    );

    expect(settings).toEqual({
      ...defaultStreamSettings,
      debug: "detailed",
      menuTourSeen: true,
    });
  });

  it("settings are per user", async () => {
    const settings = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, streamUser.id);
        yield* insertUser(db, "u-other");
        yield* db.insert(userStreamSettings).values({
          userId: "u-other",
          value: { ...defaultStreamSettings, debug: "detailed" },
        });
        return yield* (yield* client)["streamSettings.get"]();
      }),
    );

    expect(settings).toEqual(defaultStreamSettings);
  });
});

describe("streamSettings.save", () => {
  it("save then get returns the saved value; second save overwrites, one row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, streamUser.id);
        const rpc = yield* client;

        const first = yield* rpc["streamSettings.save"]({
          quality: "manual",
          bitrateMbps: 10,
          resolution: "720p",
          debug: "short",
          menuTourSeen: true,
          localLayout: true,
          fullscreenTutorialSeen: true,
        });
        const second = yield* rpc["streamSettings.save"]({
          quality: "auto",
          bitrateMbps: 20,
          resolution: "1440p",
          debug: "off",
          menuTourSeen: true,
          localLayout: false,
          fullscreenTutorialSeen: false,
        });
        const got = yield* rpc["streamSettings.get"]();
        const rows = yield* db
          .select()
          .from(userStreamSettings)
          .pipe(Effect.orDie);

        return { first, second, got, rowCount: rows.length };
      }),
    );

    expect(result.first).toEqual({
      quality: "manual",
      bitrateMbps: 10,
      resolution: "720p",
      debug: "short",
      menuTourSeen: true,
      localLayout: true,
      fullscreenTutorialSeen: true,
    });
    expect(result.second).toEqual({
      quality: "auto",
      bitrateMbps: 20,
      resolution: "1440p",
      debug: "off",
      menuTourSeen: true,
      localLayout: false,
      fullscreenTutorialSeen: false,
    });
    expect(result.got).toEqual(result.second);
    expect(result.rowCount).toBe(1);
  });
});
