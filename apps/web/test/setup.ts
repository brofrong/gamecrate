// Preload для `bun test` (bunfig.toml): DOM от happy-dom и очистка Testing Library.
// Именно preload: Testing Library (CommonJS) читает `document` при загрузке, раньше тел ES-модулей теста.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const { afterEach } = await import("bun:test");
const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
});
