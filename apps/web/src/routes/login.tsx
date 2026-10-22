// `/login`: сцена «сборка куба» слева, панель входа справа; вошедшего пользователя
// уводит на `next`/`/library` полной навигацией (сокет RPC привязан к cookie сессии).
import { useAtomValue } from "@effect/atom-react";
import { createRoute, Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/brand/Logo";
import { CubeScene } from "@/components/login/CubeScene";
import { LoginPanel } from "@/components/login/LoginPanel";
import { authErrorMessage } from "@/lib/authErrors";
import type { Level, PROVIDER_TINT } from "@/lib/cubeAssembly";
import { safeNext } from "@/lib/safeNext";
import { meAtom, providersAtom } from "@/rpc";
import { rootRoute } from "./__root";

/** `next` из query — только относительный путь на этом же origin, иначе `/library`. */
export const loginNext = (search: { next?: string }): string =>
  safeNext(search.next);

function LoginPage() {
  const me = useAtomValue(meAtom);
  const providersResult = useAtomValue(providersAtom);
  const { next, error } = loginRoute.useSearch();
  const target = loginNext(next === undefined ? {} : { next });

  const [level, setLevel] = useState<Level>(0);
  const [tint, setTint] = useState<keyof typeof PROVIDER_TINT | null>(null);
  const [lit, setLit] = useState(false);

  useEffect(() => {
    if (error) toast.error(authErrorMessage(error));
  }, [error]);

  if (AsyncResult.isSuccess(me)) {
    window.location.assign(target);
    return null;
  }

  const providers = AsyncResult.isSuccess(providersResult)
    ? providersResult.value
    : undefined;

  return (
    <main className="grid min-h-dvh bg-brand-bg font-sans text-brand-text lg:grid-cols-[55fr_45fr]">
      <div className="relative order-2 h-[240px] lg:order-1 lg:h-auto">
        <Link
          to="/"
          aria-label="GameCrate"
          className="absolute top-7 left-7 z-10"
        >
          <Logo height={36} />
        </Link>
        <CubeScene level={level} tint={tint} lit={lit} />
      </div>
      <div className="order-1 flex items-center justify-center p-6 lg:order-2">
        <div className="grid w-full max-w-sm gap-4">
          {error && (
            <p className="text-sm text-red-400">{authErrorMessage(error)}</p>
          )}
          <LoginPanel
            providers={providers}
            next={target}
            onLevel={setLevel}
            onTint={setTint}
            onLit={() => setLit(true)}
          />
        </div>
      </div>
    </main>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (
    search: Record<string, unknown>,
  ): { next?: string; error?: string } => ({
    ...(typeof search.next === "string" ? { next: search.next } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  component: LoginPage,
});
