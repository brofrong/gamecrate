// Вход в десктоп-приложение через системный браузер.
// - `/login/desktop?provider=…&state=…` (системный браузер): `state` создало окно приложения,
//   без него входа нет. Гость уходит на OAuth и возвращается на `/login/desktop?done=1&state=…`.
//   Вошедшему токен не выдаётся сам: экран «Войти в приложение GameCrate как …», и только по
//   клику — одноразовый токен и ссылка `gamecrate://auth?token=…&state=…` (`done=1` можно
//   подделать ссылкой, а Chrome может не открыть свою схему без жеста пользователя).
// - `/login/desktop/finish#token=…&state=…` (только окно приложения): фрагмент (на сервер он не
//   уходит) сразу убираем, `state` сверяем с `sessionStorage` окна, затем обмен POST-ом на
//   cookie сессии и домой полной навигацией (сокет RPC привязан к cookie). Ошибка, чужой или
//   потерянный `state` (холодный старт по ссылке) — `/login?error=DESKTOP_TOKEN` без обмена.
import { useAtomValue } from "@effect/atom-react";
import { createRoute } from "@tanstack/react-router";
import type { AuthProviders } from "@cg/rpc";
import { AsyncResult } from "effect/reactivity";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  createDesktopToken,
  currentAccount,
  exchangeDesktopToken,
  signInWithProvider,
  type SocialProvider,
} from "@/auth";
import { pageProviders } from "@/brands";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { homePath, isDesktop } from "@/lib/desktop";
import {
  browserProvider,
  DESKTOP_ERROR_PATH,
  desktopAuthLink,
  desktopDonePath,
  fromHash,
  takeDesktopState,
  validState,
} from "@/lib/desktopLogin";
import { providersAtom } from "@/rpc";
import { rootRoute } from "./__root";

const NO_PROVIDER =
  "Этот способ входа недоступен. Вернитесь в GameCrate и выберите другой.";
const NO_STATE =
  "Ссылка входа неполная. Вернитесь в GameCrate и начните вход заново.";
const FAILED = "Не удалось войти. Вернитесь в GameCrate и попробуйте ещё раз.";

type BrowserState =
  | { kind: "working" }
  | { kind: "confirm"; label: string; pending: boolean }
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
 * Страница системного браузера. `state` — из адреса, его создало окно приложения;
 * `providers` — включённые способы входа (`undefined`, пока список грузится); `done` — вернулись
 * с OAuth, провайдер уже не нужен.
 */
export function DesktopBrowserLogin({
  provider,
  state: rawState,
  done = false,
  providers,
}: {
  provider?: string | undefined;
  state?: string | undefined;
  done?: boolean;
  providers: AuthProviders | undefined;
}) {
  const [view, setView] = useState<BrowserState>({ kind: "working" });
  // один запуск на страницу (StrictMode зовёт эффект дважды)
  const started = useRef(false);
  const state = validState(rawState);

  useEffect(() => {
    if (started.current) return;
    if (state === null) {
      started.current = true;
      setView({ kind: "error", text: NO_STATE });
      return;
    }
    let chosen: SocialProvider | null = null;
    if (!done) {
      if (providers === undefined) return;
      chosen = browserProvider(provider, providers);
      if (chosen === null) {
        started.current = true;
        setView({ kind: "error", text: NO_PROVIDER });
        return;
      }
    }
    started.current = true;
    void (async () => {
      const account = await currentAccount();
      if (account.kind === "signed-in") {
        setView({ kind: "confirm", label: account.label, pending: false });
        return;
      }
      // гость — на OAuth; после `done=1` сессии всё ещё нет — не зацикливаемся
      if (account.kind === "guest" && chosen !== null) {
        void signInWithProvider(chosen, desktopDonePath(state));
        return;
      }
      setView({ kind: "error", text: FAILED });
    })();
  }, [done, provider, providers, state]);

  /** Только по клику: токен и ссылка в приложение (клик — ещё и жест для Chrome). */
  const confirm = async (label: string) => {
    if (state === null) return;
    setView({ kind: "confirm", label, pending: true });
    const result = await createDesktopToken();
    if (!("token" in result)) {
      setView({ kind: "error", text: FAILED });
      return;
    }
    const link = desktopAuthLink(result.token, state);
    setView({ kind: "sent", link });
    window.location.assign(link);
  };

  if (view.kind === "error") {
    return (
      <Screen>
        <p role="alert" className="text-sm text-red-400">
          {view.text}
        </p>
      </Screen>
    );
  }
  if (view.kind === "confirm") {
    return (
      <Screen>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] break-words">
          {`Войти в приложение GameCrate как ${view.label}`}
        </h1>
        <p className="text-sm text-brand-muted">
          Нажмите, только если вход начали вы — в приложении GameCrate на этом
          компьютере.
        </p>
        <button
          type="button"
          disabled={view.pending}
          onClick={() => void confirm(view.label)}
          className="inline-flex h-11 items-center rounded-xl bg-brand-gradient px-6 text-sm font-semibold text-brand-on-accent disabled:opacity-60"
        >
          Открыть GameCrate
        </button>
      </Screen>
    );
  }
  if (view.kind === "sent") {
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
          href={view.link}
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

/** Окно приложения: обмен токена из фрагмента на сессию — только при совпавшем `state`. */
export function DesktopLoginFinish() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const link = fromHash(window.location.hash);
    // токен не должен оставаться в адресе и истории (ни во фрагменте, ни в query)
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
    // сохранённый state одноразовый: удаляем при любом исходе
    const saved = takeDesktopState();
    if (
      !isDesktop() ||
      link === null ||
      saved === null ||
      link.state !== saved
    ) {
      window.location.replace(DESKTOP_ERROR_PATH);
      return;
    }
    void exchangeDesktopToken(link.token).then(({ error }) => {
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
  const { provider, state, done } = loginDesktopRoute.useSearch();
  const providersResult = useAtomValue(providersAtom);
  const providers = AsyncResult.isSuccess(providersResult)
    ? pageProviders(providersResult.value)
    : AsyncResult.isFailure(providersResult)
      ? { google: false, yandex: false, pocketId: false, telegram: false }
      : undefined;
  return (
    <DesktopBrowserLogin
      provider={provider}
      state={state}
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
  ): { provider?: string; state?: string; done?: boolean } => ({
    ...(typeof search.provider === "string"
      ? { provider: search.provider }
      : {}),
    ...(typeof search.state === "string" ? { state: search.state } : {}),
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
