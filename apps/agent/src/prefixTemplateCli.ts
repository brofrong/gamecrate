// Разовая сборка шаблонов префикса Proton (см. PrefixTemplate.ts) для списка
// appid — например, после ручной смены Proton в библиотеке (README, «Шаблоны
// префикса Proton»). Запускать в контейнере агента, где есть его окружение,
// сокет Docker и каталоги:
//   docker exec cg-agent bun apps/agent/src/prefixTemplateCli.ts <appId>…
// Только когда на сервере нет сессий и установок: имена помощника и слоёв те
// же, что у агента, а шаблон игры с живым контейнером не переносится
// (`deferred`). По очереди: на каждый appid — строка `<appId> <исход>`; код 1,
// если есть `failed` или неверный appid.
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { AgentConfig } from "./config";
import { DockerClient } from "./DockerClient";
import { PrefixTemplates, prefixTemplatesLayer } from "./PrefixTemplate";

const APP_ID = /^[1-9]\d{0,9}$/;

const program = Effect.gen(function* () {
  const templates = yield* PrefixTemplates;
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: prefixTemplateCli.ts <appId>…");
    process.exitCode = 1;
    return;
  }
  let ok = true;
  for (const arg of args) {
    if (!APP_ID.test(arg)) {
      console.log(`${arg} invalid`);
      ok = false;
      continue;
    }
    const outcome = yield* templates.ensure(Number(arg));
    console.log(`${arg} ${outcome}`);
    if (outcome === "failed") ok = false;
  }
  if (!ok) process.exitCode = 1;
});

BunRuntime.runMain(
  program.pipe(
    Effect.provide(
      prefixTemplatesLayer.pipe(
        Layer.provide(DockerClient.layer),
        Layer.provideMerge(AgentConfig.layer),
      ),
    ),
  ),
);
