// Точка входа оркестратора: миграции БД, затем ведение сессий (планировщик,
// события агентов, таймеры), HTTP-сервер на Bun (агенты на /agent) и
// внутренний relay стрима для api на RELAY_PORT.
import { Db, runMigrations } from "@cg/db";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AgentHub } from "./AgentHub";
import { OrchestratorConfig } from "./config";
import { GameDeleter } from "./GameDeleter";
import { HttpApp } from "./http";
import { InstallDispatcher } from "./InstallDispatcher";
import { RelayServer } from "./relay";
import * as Scheduler from "./Scheduler";
import { SessionRunner } from "./SessionRunner";
import { SteamLoginRunner, SteamQr } from "./SteamLoginRunner";
import { SteamLoginSeeds } from "./SteamLoginSeeds";
import { Tunnels } from "./Tunnels";
import { WorkerAuth } from "./WorkerAuth";

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
// профиля (http.ts) — одна и та же строка `steam_login_seeds` (ключ `SEED_KEY`
// из конфига; Db и конфиг подаются ниже). WorkerAuth (токены серверов и
// фоновое отключение отозванных) — на том же хабе. Один Tunnels на оба
// сервера: relay ждёт канал, который агент открывает на публичном
// (/agent/tunnel/:tunnelId). Relay — на своём Bun-сервере (RELAY_PORT,
// только внутренняя сеть), не в роутере публичного.
const Server = Layer.mergeAll(
  HttpRouter.serve(HttpApp).pipe(Layer.provide(BunServer)),
  RelayServer,
).pipe(
  Layer.provide(Sessions),
  Layer.provide(Tunnels.layer),
  Layer.provide(WorkerAuth.layer),
  Layer.provide(AgentHub.layer),
  Layer.provide(SteamLoginSeeds.layer),
  Layer.provide(Db.layer),
  Layer.provide(OrchestratorConfig.layer),
);

const main = Effect.gen(function* () {
  yield* runMigrations.pipe(Effect.provide(Db.layer));
  return yield* Layer.launch(Server);
});

BunRuntime.runMain(main);
