// Точка входа агента воркера: подхват контейнеров сессий и уборка установок
// прошлого запуска (Docker API), затем исходящее соединение с оркестратором. Запуск: `bun apps/agent/src/main.ts`
// с переменными окружения из config.ts и смонтированным сокетом Docker.
// AgentConfig.layer сначала читает окружение (WORKER_ID, WORKER_TOKEN, …), затем
// ждёт S3/PROFILE_KEY с главного (GET /agent/config, см. RemoteConfig.ts) —
// сеть/5xx/401 агент пережидает повтором, неверные данные ответа — ошибка при
// старте. Неверный формат PROFILE_KEY — тоже ошибка при старте (слой ProfileStore).
import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { AgentConfig } from "./config";
import { DockerClient } from "./DockerClient";
import { Installer } from "./Installer";
import * as OrchestratorLink from "./OrchestratorLink";
import { prefixTemplatesLayer } from "./PrefixTemplate";
import { ProfileCommitter } from "./profile/ProfileCommitter";
import { ProfileStore } from "./profile/ProfileStore";
import { SessionSupervisor } from "./SessionSupervisor";
import { WorkerMonitor } from "./WorkerMonitor";

const Agent = OrchestratorLink.layer.pipe(
  // По очереди, не параллельно: супервизор при старте убирает всех помощников
  // (`cg.helper`), а уборка установок сама запускает помощника очистки.
  Layer.provide(SessionSupervisor.layer),
  // Роль gamestore — установки; без неё Installer только отказывает.
  Layer.provide(Installer.layer),
  // Шаблоны префикса Proton — и супервизору (после сессии), и установщику.
  Layer.provide(prefixTemplatesLayer),
  // Один ProfileCommitter на супервизор, установщик и соединение с оркестратором.
  Layer.provideMerge(ProfileCommitter.layer),
  Layer.provide(ProfileStore.layer),
  Layer.provide(DockerClient.layer),
  // Железо, версии и загрузка воркера для админки.
  Layer.provide(WorkerMonitor.layer),
  Layer.provideMerge(AgentConfig.layer),
);

BunRuntime.runMain(Layer.launch(Agent));
