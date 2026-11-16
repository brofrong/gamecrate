// Точка входа сервера: миграции БД, затем каталог своих игр и HTTP-сервер на Bun.
import { Db, runMigrations } from "@cg/db";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { BetterAuth } from "./auth/auth";
import { AppConfig } from "./config";
import { maxUploadBytes } from "./download/routes";
import { HttpApp } from "./http";
import { OwnGameCatalog } from "./library/OwnGameCatalog";
import { Mailer } from "./mail/Mailer";
import { ProtonDb } from "./steam/ProtonDb";
import { SteamApi } from "./steam/SteamApi";
import { SteamStoreApi } from "./steam/SteamStoreApi";

/**
 * `maxRequestBodySize`: по умолчанию Bun режет тело на 128 МБ, а выкладка десктоп-сборок
 * (`PUT /download/desktop/*`) — до `maxUploadBytes`. Запас в 1 МиБ — чтобы сверх лимита ответил
 * сам маршрут (413), а не обрыв потока в Bun.
 */
const BunServer = Layer.unwrap(
  AppConfig.useSync((config) =>
    BunHttpServer.layer({
      port: config.port,
      maxRequestBodySize: maxUploadBytes + 1024 * 1024,
    }),
  ),
);

/**
 * БД, внешние API (Steam Web API, Steam Store, ProtonDB) и почта — для библиотеки, страницы игры,
 * входа и кодов на e-mail; каталог своих игр (`games/<slug>/game.json`, при построении — синхронизация
 * в БД; строится в `Layer.launch`, то есть уже после миграций).
 */
const Services = Layer.mergeAll(
  SteamApi.layer,
  SteamStoreApi.layer,
  ProtonDb.layer,
  Mailer.layer,
  OwnGameCatalog.layer,
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
