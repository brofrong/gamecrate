// Точка входа оркестратора: миграции БД, затем ведение сессий (планировщик,
// события агентов, таймеры) и HTTP-сервер на Bun (агенты на /agent).
import { Db, runMigrations } from "@cg/db";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AgentHub } from "./AgentHub";
import { OrchestratorConfig } from "./config";
import { HttpApp } from "./http";
import * as Scheduler from "./Scheduler";
import { SessionRunner } from "./SessionRunner";

const BunServer = Layer.unwrap(
  OrchestratorConfig.useSync((config) =>
    BunHttpServer.layer({ port: config.port }),
  ),
);

/** Фоновая работа: подписка на хаб, таймеры сессий, планировщик. */
const Sessions = Layer.mergeAll(SessionRunner.layer, Scheduler.layer);

// `Layer.provide(Sessions)` строит ведение сессий раньше HTTP-сервера: раннер
// подписан на хаб до того, как подключится первый агент. Один AgentHub на всех.
const Server = HttpRouter.serve(HttpApp).pipe(
  Layer.provide(Sessions),
  Layer.provide(AgentHub.layer),
  Layer.provide(Db.layer),
  Layer.provide(BunServer),
  Layer.provide(OrchestratorConfig.layer),
);

const main = Effect.gen(function* () {
  yield* runMigrations.pipe(Effect.provide(Db.layer));
  return yield* Layer.launch(Server);
});

BunRuntime.runMain(main);
