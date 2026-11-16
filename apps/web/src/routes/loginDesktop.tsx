// Вход в десктоп-приложение через системный браузер.
// - `/login/desktop?provider=…` (системный браузер): гость уходит на OAuth и возвращается на
//   `/login/desktop?done=1`; вошедший получает одноразовый токен и ссылку `gamecrate://auth`.
// - `/login/desktop/finish#token=…` (окно приложения): токен из фрагмента (на сервер он не
//   уходит), фрагмент сразу убираем, обмен POST-ом на cookie сессии, затем домой полной
//   навигацией (сокет RPC привязан к cookie). Ошибка — `/login?error=DESKTOP_TOKEN`.
import { useAtomValue } from "@effect/atom-react";
import { createRoute } from "@tanstack/react-router";
import type { AuthProviders } from "@cg/rpc";
import { AsyncResult } from "effect/reactivity";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  createDesktopToken,
  exchangeDesktopToken,
  signInWithProvider,
  type SocialProvider,
} from "@/auth";
import { pageProviders } from "@/brands";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { homePath } from "@/lib/desktop";
import {
  browserProvider,
  DESKTOP_DONE_PATH,
  DESKTOP_ERROR_PATH,
  desktopAuthLink,
  tokenFromHash,
} from "@/lib/desktopLogin";
import { providersAtom } from "@/rpc";
import { rootRoute } from "./__root";

const NO_PROVIDER =
  "Этот способ входа недоступен. Вернитесь в GameCrate и выберите другой.";
const FAILED = "Не удалось войти. Вернитесь в GameCrate и попробуйте ещё раз.";

type BrowserState =
  | { kind: "working" }
  | { kind: "sent"; link: string }
  | { kind: "error"; text: string };

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-brand-bg p-6 font-sans text-brand-text">
      <div className="grid w-full max-w-sm justify-items-center gap-4 text-center">
        <BrandLogo height={36} />
        {children}
      </div>
    </main>
  );
}

/**
 * Страница системного браузера. `providers` — включённые способы входа (`undefined`, пока
 * список грузится); `done` — вернулись с OAuth, провайдер уже не нужен.
 */
export function DesktopBrowserLogin({
  provider,
  done = false,
  providers,
}: {
  provider?: string | undefined;
  done?: boolean;
  providers: AuthProviders | undefined;
}) {
  const [state, setState] = useState<BrowserState>({ kind: "working" });
  // один запуск на страницу (StrictMode зовёт эффект дважды — второй токен не нужен)
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    let chosen: SocialProvider | null = null;
    if (!done) {
      if (providers === undefined) return;
      chosen = browserProvider(provider, providers);
      if (chosen === null) {
        started.current = true;
        setState({ kind: "error", text: NO_PROVIDER });
        return;
      }
    }
    started.current = true;
    void (async () => {
      const result = await createDesktopToken();
      if ("token" in result) {
        const link = desktopAuthLink(result.token);
        setState({ kind: "sent", link });
        window.location.assign(link);
        return;
      }
      // гость — на OAuth; после `done=1` сессии всё ещё нет — не зацикливаемся
      if (result.error === "UNAUTHORIZED" && chosen !== null) {
        void signInWithProvider(chosen, DESKTOP_DONE_PATH);
        return;
      }
      setState({ kind: "error", text: FAILED });
    })();
  }, [done, provider, providers]);

  if (state.kind === "error") {
    return (
      <Screen>
        <p role="alert" className="text-sm text-red-400">
          {state.text}
        </p>
      </Screen>
    );
  }
  if (state.kind === "sent") {
    return (
      <Screen>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">
          Можно вернуться в GameCrate
        </h1>
        <p className="text-sm text-brand-muted">
          Вход выполнен, эту вкладку можно закрыть. Если GameCrate не открылся
          сам — нажмите кнопку.
        </p>
        <a
          href={state.link}
          className="inline-flex h-11 items-center rounded-xl bg-brand-gradient px-6 text-sm font-semibold text-brand-on-accent"
        >
          Открыть GameCrate
        </a>
      </Screen>
    );
  }
  return (
    <Screen>
      <p role="status" className="text-sm text-brand-muted">
        Входим…
      </p>
    </Screen>
  );
}

/** Окно приложения: обмен токена из фрагмента на сессию. */
export function DesktopLoginFinish() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = tokenFromHash(window.location.hash);
    // токен не должен оставаться в адресе и истории (ни во фрагменте, ни в query)
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
    if (token === null) {
      window.location.replace(DESKTOP_ERROR_PATH);
      return;
    }
    void exchangeDesktopToken(token).then(({ error }) => {
      window.location.replace(error ? DESKTOP_ERROR_PATH : homePath());
    });
  }, []);

  return (
    <Screen>
      <p role="status" className="text-sm text-brand-muted">
        Входим…
      </p>
    </Screen>
  );
}

function LoginDesktopPage() {
  const { provider, done } = loginDesktopRoute.useSearch();
  const providersResult = useAtomValue(providersAtom);
  const providers = AsyncResult.isSuccess(providersResult)
    ? pageProviders(providersResult.value)
    : AsyncResult.isFailure(providersResult)
      ? { google: false, yandex: false, pocketId: false, telegram: false }
      : undefined;
  return (
    <DesktopBrowserLogin
      provider={provider}
      done={done === true}
      providers={providers}
    />
  );
}

export const loginDesktopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/desktop",
  validateSearch: (
    search: Record<string, unknown>,
  ): { provider?: string; done?: boolean } => ({
    ...(typeof search.provider === "string"
      ? { provider: search.provider }
      : {}),
    // роутер разбирает `?done=1` как число
    ...(search.done === 1 || search.done === "1" ? { done: true } : {}),
  }),
  component: LoginDesktopPage,
});

export const loginDesktopFinishRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login/desktop/finish",
  component: DesktopLoginFinish,
});
