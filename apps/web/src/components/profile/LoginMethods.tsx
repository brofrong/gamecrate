// Способы входа в профиле: статус привязки по рядам, привязать/отвязать с правилом «последний способ».
import {
  canUnlink,
  type AuthProviders,
  type CurrentUserShape,
  type LoginProviderId,
} from "@cg/rpc";
import { Button } from "@/components/ui/button";

export interface LinkedAccount {
  readonly providerId: string;
  readonly accountId: string;
}

export const METHOD_LABELS: Record<LoginProviderId, string> = {
  yandex: "Яндекс",
  google: "Google",
  telegram: "Telegram",
  "pocket-id": "Pocket ID",
  steam: "Steam",
};

const ORDER: ReadonlyArray<LoginProviderId> = [
  "yandex",
  "google",
  "telegram",
  "pocket-id",
  "steam",
];

/** Pocket ID и Steam показываются всегда [решение контроллера]; остальные — если включены на сервере. */
const isConfigured = (
  providerId: LoginProviderId,
  providers: AuthProviders,
): boolean => {
  if (providerId === "pocket-id" || providerId === "steam") return true;
  if (providerId === "yandex") return providers.yandex;
  if (providerId === "google") return providers.google;
  return providers.telegram;
};

export function LoginMethods({
  user,
  accounts,
  providers,
  onLink,
  onUnlink,
  busy,
}: {
  user: CurrentUserShape;
  accounts: ReadonlyArray<LinkedAccount>;
  providers: AuthProviders;
  onLink: (p: LoginProviderId) => void;
  onUnlink: (a: LinkedAccount) => void;
  busy: string | null;
}) {
  return (
    <div className="grid gap-2">
      {ORDER.filter((providerId) => isConfigured(providerId, providers)).map(
        (providerId) => {
          const account = accounts.find((a) => a.providerId === providerId);
          const linked = account !== undefined;
          const allowed = linked && canUnlink(accounts, providerId, user);
          return (
            <div
              key={providerId}
              className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
            >
              <p className="text-sm">
                {METHOD_LABELS[providerId]} —{" "}
                {linked ? "привязан" : "не привязан"}
                {linked && providerId === "steam"
                  ? ` · SteamID ${user.steamId}`
                  : ""}
              </p>
              {linked ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!allowed || busy === providerId}
                  title={allowed ? undefined : "Это единственный способ входа"}
                  onClick={() => account && onUnlink(account)}
                >
                  Отвязать
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === providerId}
                  onClick={() => onLink(providerId)}
                >
                  Привязать
                </Button>
              )}
            </div>
          );
        },
      )}
    </div>
  );
}
