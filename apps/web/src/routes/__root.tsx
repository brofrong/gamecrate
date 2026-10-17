// Корневой маршрут: страница + тосты.
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";

function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster position="bottom-right" richColors />
    </>
  );
}

function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <p className="text-lg">Страница не найдена</p>
      <Button asChild variant="outline">
        <Link to="/">На главную</Link>
      </Button>
    </main>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});
