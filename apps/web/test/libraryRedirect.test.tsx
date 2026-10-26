// `/library` больше не рендерит библиотеку — только редирект на `/app`,
// сохраняя `?error=` (Better Auth возвращает ошибку привязки Steam как
// `/library?error=...`, старые ссылки/закладки не должны ломаться).
//
// `appRoute` (`AppLayout`) читает `meAtom`/`activeSessionAtom` из `../src/rpc`,
// который без подмены открывает настоящий WebSocket — подменяем модуль минимальным
// набором атомов (initial, не success/failure), этого достаточно, чтобы `AppLayout`
// отрисовал `null` и не упал.
import { describe, expect, it, mock } from "bun:test";
import type { CurrentUserShape, SessionView } from "@cg/rpc";
import { render, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Cause, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";

const meAtom = Atom.make(
  AsyncResult.initial<CurrentUserShape, { readonly _tag: string }>(),
);
const activeSessionAtom = Atom.make(
  AsyncResult.initial<SessionView | null, { readonly _tag: string }>(),
);
const resultErrorTag = <A, E extends { readonly _tag: string }>(
  result: AsyncResult.AsyncResult<A, E>,
) =>
  AsyncResult.isFailure(result)
    ? Option.getOrUndefined(
        Option.map(Cause.findErrorOption(result.cause), (error) => error._tag),
      )
    : undefined;

mock.module("../src/rpc", () => ({
  meAtom,
  activeSessionAtom,
  resultErrorTag,
}));

const { libraryRoute } = await import("../src/routes/library");
const { appRoute } = await import("../src/routes/app");
const { rootRoute } = await import("../src/routes/__root");

const routeTree = rootRoute.addChildren([libraryRoute, appRoute]);

const renderAt = (path: string) => {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
  return router;
};

describe("library redirect", () => {
  it("redirects /library?error=X to /app?error=X", async () => {
    const router = renderAt("/library?error=X");
    await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
    expect(router.state.location.search).toEqual({ error: "X" });
  });

  it("redirects bare /library to bare /app", async () => {
    const router = renderAt("/library");
    await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
    expect(router.state.location.search).toEqual({});
  });
});
