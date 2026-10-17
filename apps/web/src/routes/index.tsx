// `/`: лендинг с входом через Steam; вошедшего пользователя уводим в библиотеку.
import { useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Gamepad2, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { signInWithSteam } from "@/auth";
import { FullscreenLoader } from "@/components/FullscreenLoader";
import { Button } from "@/components/ui/button";
import { meAtom } from "@/rpc";
import { rootRoute } from "./__root";

const loginFailed = "Не удалось войти через Steam. Попробуйте ещё раз.";

function SteamIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 fill-current">
      <path d="M11.98 0C5.67 0 .5 4.86.01 11.03l6.44 2.66a3.38 3.38 0 0 1 2.14-.6l2.87-4.15v-.06a4.53 4.53 0 1 1 4.53 4.53h-.1l-4.08 2.92.01.17a3.4 3.4 0 0 1-6.74.66L.47 15.33A12 12 0 1 0 11.98 0Zm-4.45 18.2-1.48-.6a2.55 2.55 0 1 0 1.4-3.5l1.53.63a1.88 1.88 0 1 1-1.45 3.47Zm11.5-9.37a3.02 3.02 0 1 0-6.04 0 3.02 3.02 0 0 0 6.04 0Zm-5.28 0a2.27 2.27 0 1 1 4.54 0 2.27 2.27 0 0 1-4.54 0Z" />
    </svg>
  );
}

function Landing({ error }: { error: boolean }) {
  const [pending, setPending] = useState(false);

  const login = async () => {
    setPending(true);
    // При успехе клиент Better Auth сам переходит на steamcommunity.com.
    const result = await signInWithSteam().catch(() => ({ error: true }));
    if (result.error) {
      setPending(false);
      toast.error(loginFailed);
    }
  };

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.6_0.17_255/0.25),transparent_60%)]" />
      <div className="relative flex max-w-lg flex-col items-center gap-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/15 ring-1 ring-primary/30">
          <Gamepad2 className="size-8 text-primary" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Облачный гейминг
        </h1>
        <p className="text-lg text-muted-foreground">
          Ваша библиотека Steam в браузере — без установки и мощного железа.
        </p>
        {error && <p className="text-sm text-destructive">{loginFailed}</p>}
        <Button
          size="lg"
          onClick={() => void login()}
          disabled={pending}
          className="h-12 bg-[#171a21] px-8 text-base text-white ring-1 ring-white/15 hover:bg-[#2a475e]"
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <SteamIcon />}
          Войти через Steam
        </Button>
        <p className="text-xs text-muted-foreground">
          Вход на сайте Steam: пароль Steam мы не видим и не храним.
        </p>
      </div>
    </main>
  );
}

function IndexPage() {
  const me = useAtomValue(meAtom);
  const { error } = indexRoute.useSearch();

  if (AsyncResult.isInitial(me)) return <FullscreenLoader />;
  if (AsyncResult.isSuccess(me)) return <Navigate to="/library" />;
  return <Landing error={error !== undefined} />;
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // Better Auth возвращает ошибку входа как `/?error=...` (errorCallbackURL).
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  component: IndexPage,
});
