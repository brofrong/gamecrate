// Точка входа SPA: роутер TanStack, реестр атомов Effect.
import { brandForHost } from "@cg/brands";
import { RegistryProvider } from "@effect/atom-react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadBrandFonts } from "./fonts";
import { rootRoute } from "./routes/__root";
import { adminRoute } from "./routes/admin";
import {
  appCrateRoute,
  appIndexRoute,
  appPlansRoute,
  appRoute,
  appTimeRoute,
  appGameRoute,
  appTrendingRoute,
} from "./routes/app";
import { indexRoute } from "./routes/index";
import { libraryRoute } from "./routes/library";
import { loginRoute } from "./routes/login";
import { profileRoute } from "./routes/profile";
import { sessionRoute } from "./routes/session.$id";

const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  loginRoute,
  profileRoute,
  sessionRoute,
  adminRoute,
  appRoute.addChildren([
    appIndexRoute,
    appTrendingRoute,
    appCrateRoute,
    appTimeRoute,
    appPlansRoute,
    appGameRoute,
  ]),
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Прод: api уже поставил `data-brand` в index.html. Dev без api — по хосту
// (`beeline.localhost`), иначе gamecrate. `data-oauth` в dev не трогаем.
document.documentElement.dataset.brand ??= brandForHost(
  location.host,
  new Map(),
);

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
