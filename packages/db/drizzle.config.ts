// Конфиг drizzle-kit: `bunx drizzle-kit generate` пишет SQL-миграции в ./migrations.
// Применяет их runMigrations (src/migrate.ts) при старте сервера и в тестах.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Нужен только командам, которые ходят в БД (migrate/push/pull/studio).
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
});
