// Preload для `bun test` (bunfig.toml): DOM от happy-dom и очистка Testing Library.
// Именно preload: Testing Library (CommonJS) читает `document` при загрузке, раньше тел ES-модулей теста.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// URL задаём: клиент Better Auth (`src/auth.ts`) при импорте читает `location.origin`
// и падает на `about:blank`.
GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { afterEach } = await import("bun:test");
const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
});
