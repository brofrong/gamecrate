// Роутер для тестов компонентов, которые рендерят `Link`: один корневой маршрут с заданным
// элементом, память вместо истории браузера.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type * as React from "react";

export const testRouter = (element: React.ReactNode) => {
  const root = createRootRoute({ component: () => element });
  return createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
};
