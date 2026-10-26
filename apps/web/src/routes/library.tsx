// `/library`: старый адрес библиотеки — редирект на `/app` (см.
// `docs/superpowers/specs/2026-10-23-app-home-design.md`). Better Auth возвращает
// ошибку привязки Steam как `/library?error=...` (errorCallbackURL из старых ссылок/
// писем), поэтому редирект сохраняет `?error=`.
import { createRoute, Navigate } from "@tanstack/react-router";
import { rootRoute } from "./__root";

function LibraryRedirect() {
  const { error } = libraryRoute.useSearch();
  return (
    <Navigate to="/app" search={error === undefined ? {} : { error }} replace />
  );
}

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  // Better Auth возвращает ошибку привязки Steam как `/library?error=...` (errorCallbackURL).
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  component: LibraryRedirect,
});
