// `/profile`: способы входа, смена почты, выход — для вошедшего пользователя.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { LoginProviderId } from "@cg/rpc";
import { createRoute, Navigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { linkProvider, listLinkedAccounts, unlinkProvider } from "@/auth";
import { pageProviders } from "@/brands";
import { AppHeader } from "@/components/AppHeader";
import { DownloadLink } from "@/components/DownloadLink";
import { AccountSummary } from "@/components/profile/AccountSummary";
import { EmailSection } from "@/components/profile/EmailSection";
import {
  type LinkedAccount,
  LoginMethods,
} from "@/components/profile/LoginMethods";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { authErrorMessage } from "@/lib/authErrors";
import { isDesktop } from "@/lib/desktop";
import { useStalled } from "@/lib/useStalled";
import { meAtom, providersAtom, resultErrorTag } from "@/rpc";
import { rootRoute } from "./__root";

/**
 * Привязка способа входа через `linkSocial`. Steam через сюда не ходит: его
 * «Подключить» открывает `SteamQrLogin` прямо в `LoginMethods` (OpenID-привязка
 * убрана из интерфейса, `linkSteam` остаётся определённой, но не вызывается) —
 * ранний выход ниже просто сужает тип для `linkProvider` и не должен срабатывать.
 */
export const handleLink = async (provider: LoginProviderId): Promise<void> => {
  if (provider === "steam") return;
  await linkProvider(provider);
};

/** Отвязка способа входа; при успехе перезагружает список, а для Steam — ещё и `meAtom` (пропадёт `steamId`). */
export const handleUnlink = async (
  account: LinkedAccount,
  callbacks: { reloadAccounts: () => void; reloadMe: () => void },
): Promise<void> => {
  const { error } = await unlinkProvider(account.id);
  if (error) {
    toast.error(authErrorMessage(error));
    return;
  }
  callbacks.reloadAccounts();
  if (account.providerId === "steam") callbacks.reloadMe();
};

function ProfilePage() {
  const me = useAtomValue(meAtom);
  const reloadMe = useAtomRefresh(meAtom);
  const providersResult = useAtomValue(providersAtom);
  const { error } = profileRoute.useSearch();
  const [accounts, setAccounts] = useState<ReadonlyArray<LinkedAccount> | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [stalled, restartWait] = useStalled(
    AsyncResult.isInitial(me) || AsyncResult.isInitial(providersResult),
  );

  const reloadAccounts = () => {
    void listLinkedAccounts().then(setAccounts);
  };

  useEffect(reloadAccounts, []);

  useEffect(() => {
    if (error) toast.error(authErrorMessage(error));
  }, [error]);

  if (resultErrorTag(me) === "Unauthorized") {
    return <Navigate to="/login" search={{ next: "/profile" }} />;
  }

  const user = AsyncResult.isSuccess(me) ? me.value : undefined;
  const providers = AsyncResult.isSuccess(providersResult)
    ? pageProviders(providersResult.value)
    : undefined;
  const unreachable =
    AsyncResult.isFailure(me) ||
    AsyncResult.isFailure(providersResult) ||
    stalled;

  const onLink = (p: LoginProviderId) => {
    setBusy(p);
    void handleLink(p).finally(() => setBusy(null));
  };

  const onUnlink = (account: LinkedAccount) => {
    setBusy(account.providerId);
    void handleUnlink(account, { reloadAccounts, reloadMe }).finally(() =>
      setBusy(null),
    );
  };

  const retry = () => {
    restartWait();
    reloadMe();
    reloadAccounts();
  };

  return (
    <div className="min-h-dvh">
      <AppHeader user={user} />
      <main className="mx-auto max-w-screen-sm px-4 py-6 sm:px-6">
        <h1 className="mb-6 text-2xl font-semibold">Профиль</h1>
        {unreachable ? (
          <ServerUnreachable onRetry={retry} />
        ) : user !== undefined ? (
          <div className="grid gap-8">
            <AccountSummary user={user} />
            <EmailSection user={user} onChanged={reloadMe} />
            {providers !== undefined && accounts !== null && (
              <LoginMethods
                user={user}
                accounts={accounts}
                providers={providers}
                onLink={onLink}
                onUnlink={onUnlink}
                onSteamDone={() => {
                  reloadAccounts();
                  reloadMe();
                }}
                busy={busy}
              />
            )}
            {!isDesktop() && (
              <section className="grid gap-2">
                <h2 className="text-lg font-semibold">Приложение</h2>
                <p className="text-sm text-muted-foreground">
                  Играйте в отдельном окне на Windows, macOS или Linux.
                </p>
                <DownloadLink className="w-fit text-sm font-medium underline underline-offset-4" />
              </section>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}

export const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  validateSearch: (search: Record<string, unknown>): { error?: string } => ({
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  component: ProfilePage,
});
