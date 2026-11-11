// Корневой маршрут: страница + тосты.
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { QueueWatcher } from "@/components/QueueWatcher";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";

function RootLayout() {
  return (
    <>
      {/* Хук очереди (спека §5): heartbeat `queueOnly` и уведомление «сервер
          готов» с любой страницы сайта, не только `/session/$id`. Ничего не
          рендерит без активной сессии пользователя. */}
      <QueueWatcher />
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
