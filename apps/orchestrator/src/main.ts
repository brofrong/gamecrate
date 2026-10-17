// Точка входа оркестратора: миграции БД, затем HTTP-сервер на Bun (агенты на /agent).
import { Db, runMigrations } from "@cg/db";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AgentHub } from "./AgentHub";
import { OrchestratorConfig } from "./config";
import { HttpApp } from "./http";

const BunServer = Layer.unwrap(
  OrchestratorConfig.useSync((config) =>
    BunHttpServer.layer({ port: config.port }),
  ),
);

const Server = HttpRouter.serve(HttpApp).pipe(
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
