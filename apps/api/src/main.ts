// Точка входа сервера: миграции БД, затем HTTP-сервер на Bun.
import { Db, runMigrations } from "@cg/db";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { BetterAuth } from "./auth/auth";
import { AppConfig } from "./config";
import { HttpApp } from "./http";
import { Mailer } from "./mail/Mailer";
import { ProtonDb } from "./steam/ProtonDb";
import { SteamApi } from "./steam/SteamApi";
import { SteamStoreApi } from "./steam/SteamStoreApi";

const BunServer = Layer.unwrap(
  AppConfig.useSync((config) => BunHttpServer.layer({ port: config.port })),
);

/** БД, внешние API (Steam Web API, Steam Store, ProtonDB) и почта — для библиотеки, страницы игры, входа и кодов на e-mail. */
const Services = Layer.mergeAll(
  SteamApi.layer,
  SteamStoreApi.layer,
  ProtonDb.layer,
  Mailer.layer,
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(Db.layer));

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
