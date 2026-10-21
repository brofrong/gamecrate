// Точка входа агента воркера: подхват контейнеров сессий (Docker API), затем
// исходящее соединение с оркестратором. Запуск: `bun apps/agent/src/main.ts`
// с переменными окружения из config.ts и смонтированным сокетом Docker.
import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { AgentConfig } from "./config";
import { DockerClient } from "./DockerClient";
import * as OrchestratorLink from "./OrchestratorLink";
import { SessionSupervisor } from "./SessionSupervisor";

const Agent = OrchestratorLink.layer.pipe(
  Layer.provide(SessionSupervisor.layer),
  Layer.provide(DockerClient.layer),
  Layer.provideMerge(AgentConfig.layer),
);

BunRuntime.runMain(Layer.launch(Agent));
