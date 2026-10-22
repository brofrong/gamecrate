// Точка входа агента воркера: подхват контейнеров сессий и уборка установок
// прошлого запуска (Docker API), затем исходящее соединение с оркестратором. Запуск: `bun apps/agent/src/main.ts`
// с переменными окружения из config.ts и смонтированным сокетом Docker.
// Неверный PROFILE_KEY — ошибка при старте (слой ProfileStore).
import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { AgentConfig } from "./config";
import { DockerClient } from "./DockerClient";
import { Installer } from "./Installer";
import * as OrchestratorLink from "./OrchestratorLink";
import { ProfileCommitter } from "./profile/ProfileCommitter";
import { ProfileStore } from "./profile/ProfileStore";
import { SessionSupervisor } from "./SessionSupervisor";

const Agent = OrchestratorLink.layer.pipe(
  // По очереди, не параллельно: супервизор при старте убирает всех помощников
  // (`cg.helper`), а уборка установок сама запускает помощника очистки.
  Layer.provide(SessionSupervisor.layer),
  // Роль gamestore — установки; без неё Installer только отказывает.
  Layer.provide(Installer.layer),
  // Один ProfileCommitter на супервизор, установщик и соединение с оркестратором.
  Layer.provideMerge(ProfileCommitter.layer),
  Layer.provide(ProfileStore.layer),
  Layer.provide(DockerClient.layer),
  Layer.provideMerge(AgentConfig.layer),
);

BunRuntime.runMain(Layer.launch(Agent));
