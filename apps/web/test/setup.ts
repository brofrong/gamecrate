// Preload для `bun test` (bunfig.toml): DOM от happy-dom, очистка Testing Library и
// исходные `window.matchMedia`/`HTMLCanvasElement.prototype.getContext` после каждого теста.
// Именно preload: Testing Library (CommonJS) читает `document` при загрузке, раньше тел ES-модулей теста.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// URL задаём: клиент Better Auth (`src/auth.ts`) при импорте читает `location.origin`
// и падает на `about:blank`.
GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { afterEach } = await import("bun:test");
const { cleanup } = await import("@testing-library/react");

// Тесты подменяют `window.matchMedia` (reduced motion, узкий экран) и `getContext`
// холста присваиванием; без возврата подмена утекала в следующие файлы, и при
// `--randomize` падали чужие тесты: `FilterBar` считал себя на телефоне, анимация
// лендинга рисовала в заглушку контекста без `fillRect`.
const matchMedia = window.matchMedia;
const getContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  // Сначала размонтировать: компоненты снимают слушателей и останавливают
  // анимацию, пока подмены ещё на месте.
  cleanup();
  window.matchMedia = matchMedia;
  HTMLCanvasElement.prototype.getContext = getContext;
});
