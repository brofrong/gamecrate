// Точка входа оркестратора: миграции БД, затем ведение сессий (планировщик,
// события агентов, таймеры) и HTTP-сервер на Bun (агенты на /agent).
import { Db, runMigrations } from "@cg/db";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AgentHub } from "./AgentHub";
import { OrchestratorConfig } from "./config";
import { GameDeleter } from "./GameDeleter";
import { HttpApp } from "./http";
import { InstallDispatcher } from "./InstallDispatcher";
import * as Scheduler from "./Scheduler";
import { SessionRunner } from "./SessionRunner";
import { SteamLoginRunner, SteamQr } from "./SteamLoginRunner";
import { SteamLoginSeeds } from "./SteamLoginSeeds";

const BunServer = Layer.unwrap(
  OrchestratorConfig.useSync((config) =>
    BunHttpServer.layer({ port: config.port }),
  ),
);

/**
 * Фоновая работа: подписки на хаб, таймеры сессий, планировщик, установки и
 * удаление игр, входы в Steam по QR.
 */
const Sessions = Layer.mergeAll(
  SessionRunner.layer,
  Scheduler.layer,
  InstallDispatcher.layer,
  GameDeleter.layer,
  SteamLoginRunner.layer.pipe(Layer.provide(SteamQr.live)),
);

// `Layer.provide(Sessions)` строит ведение сессий раньше HTTP-сервера: раннер,
// диспетчер установок и удаление игр подписаны на хаб до того, как подключится
// первый агент.
// Один AgentHub и один SteamLoginSeeds на всех: вход, полученный по QR
// (SteamLoginRunner), приложенный к запуску сессии/установки
// (Scheduler/InstallDispatcher) и очищенный принятым посеянным коммитом
// профиля (http.ts) — одна и та же память процесса.
const Server = HttpRouter.serve(HttpApp).pipe(
  Layer.provide(Sessions),
  Layer.provide(AgentHub.layer),
  Layer.provide(SteamLoginSeeds.layer),
  Layer.provide(Db.layer),
  Layer.provide(BunServer),
  Layer.provide(OrchestratorConfig.layer),
);

const main = Effect.gen(function* () {
  yield* runMigrations.pipe(Effect.provide(Db.layer));
  return yield* Layer.launch(Server);
});

BunRuntime.runMain(main);
