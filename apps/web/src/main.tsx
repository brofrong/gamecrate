// Точка входа SPA: роутер TanStack, реестр атомов Effect.
import { RegistryProvider } from "@effect/atom-react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadBrandFonts } from "./fonts";
import { rootRoute } from "./routes/__root";
import { adminRoute } from "./routes/admin";
import { indexRoute } from "./routes/index";
import { libraryRoute } from "./routes/library";
import { sessionRoute } from "./routes/session.$id";

const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  sessionRoute,
  adminRoute,
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

loadBrandFonts();

const container = document.getElementById("root");
if (!container) throw new Error("#root не найден в index.html");

createRoot(container).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  </StrictMode>,
);
