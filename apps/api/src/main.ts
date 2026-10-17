// Точка входа сервера: миграции БД, затем HTTP-сервер на Bun.
import { Db, runMigrations } from "@cg/db";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { BetterAuth } from "./auth/auth";
import { AppConfig } from "./config";
import { HttpApp } from "./http";
import { ProtonDb } from "./steam/ProtonDb";
import { SteamApi } from "./steam/SteamApi";

const BunServer = Layer.unwrap(
  AppConfig.useSync((config) => BunHttpServer.layer({ port: config.port })),
);

/** БД и внешние API (Steam Web API, ProtonDB) — для библиотеки и хука входа. */
const Services = Layer.mergeAll(SteamApi.layer, ProtonDb.layer).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(Db.layer),
);

const Server = HttpRouter.serve(HttpApp).pipe(
  Layer.provide(BetterAuth.layer),
  Layer.provide(Services),
  Layer.provide(BunServer),
  Layer.provide(AppConfig.layer),
);

const main = Effect.gen(function* () {
  yield* runMigrations.pipe(Effect.provide(Db.layer));
  return yield* Layer.launch(Server);
});

BunRuntime.runMain(main);
