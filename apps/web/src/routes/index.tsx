// `/`: лендинг для всех. Вошедшего не уводим в `/app` (владелец, 2026-10-29: лендинг
// должен открываться и авторизованному) — кнопки лендинга сами ведут его в библиотеку.
// Лендинг статичен, поэтому показываем его сразу, не дожидаясь `auth.me`: пока ответа нет
// или сервер недоступен, кнопки ведут на `/login`.
import { useAtomValue } from "@effect/atom-react";
import { createRoute, Navigate } from "@tanstack/react-router";
import type { CurrentUserShape } from "@cg/rpc";
import { AsyncResult } from "effect/reactivity";
import { BrandSlot } from "@/components/brand/BrandSlot";
import { LandingPage } from "@/components/landing/LandingPage";
import { isDesktop } from "@/lib/desktop";
import { meAtom } from "@/rpc";
import { rootRoute } from "./__root";

/** Вошёл ли пользователь по состоянию `auth.me`: только успешный ответ, всё остальное — нет. */
export const landingSignedIn = (
  me: AsyncResult.AsyncResult<CurrentUserShape, { readonly _tag: string }>,
): boolean => AsyncResult.isSuccess(me);

function BrowserLanding() {
  const me = useAtomValue(meAtom);
  return (
    <BrandSlot
      name="landing"
      fallback={LandingPage}
      signedIn={landingSignedIn(me)}
    />
  );
}

/** В десктоп-приложении лендинга нет — сразу библиотека; в браузере — лендинг. */
export function IndexPage() {
  return isDesktop() ? <Navigate to="/app" replace /> : <BrowserLanding />;
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});
