// Панель «Steam» в правой колонке `/app` (прототип `docs/brand/prototypes/app-home.html`):
// без привязанного Steam — заголовок с кнопкой «Подключить Steam» вместо остальной
// карточки (открывает QR-вход, как `ConnectSteam` в основной сетке); привязан —
// аватар/имя/SteamID (с копированием), три числа («игр»/«готовы»/«синхр.») и кнопка
// «Обновить библиотеку».
import type { CurrentUserShape, LibraryView } from "@cg/rpc";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Panel, PanelHeader, Stat } from "@/components/app/Panel";
import {
  SteamQrLogin,
  SteamQrLoginDialog,
  type SteamQrLoginComponent,
} from "@/components/SteamQrLogin";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/formatTime";

export function SteamPanel({
  user,
  view,
  onRefresh,
  refreshing,
  onConnected,
  QrLogin = SteamQrLogin,
}: {
  user: CurrentUserShape;
  view: LibraryView | undefined;
  onRefresh: () => void;
  refreshing: boolean;
  onConnected: () => void;
  QrLogin?: SteamQrLoginComponent;
}) {
  const [open, setOpen] = useState(false);
  const linked = user.steamId !== null;
  const total = view?._tag === "Ready" ? view.entries.length : 0;
  const ready =
    view?._tag === "Ready"
      ? view.entries.filter((entry) => entry.cloud._tag === "Ready").length
      : 0;
  const syncedAt = view?._tag === "Ready" ? view.syncedAt : null;

  const stats = [
    { label: "игр", value: total },
    { label: "готовы", value: ready },
    {
      label: "синхр.",
      value: syncedAt === null ? "—" : formatRelativeDate(syncedAt, new Date()),
    },
  ];

  const onCopy = async () => {
    if (user.steamId === null) return;
    try {
      await navigator.clipboard.writeText(user.steamId);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  };

  return (
    <Panel>
      <PanelHeader
        icon="ST"
        title="Steam"
        pill={
          linked ? (
            <span className="flex items-center gap-1.5 rounded-xl bg-[#3ddc97]/10 px-2.5 py-1 text-xs font-medium text-[#3ddc97]">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-[#3ddc97]"
              />
              Привязан
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpen(true)}
            >
              Подключить Steam
            </Button>
          )
        }
      />

      {!linked && (
        <SteamQrLoginDialog
          open={open}
          title="Подключите Steam"
          onDone={() => {
            setOpen(false);
            onConnected();
          }}
          onClose={() => setOpen(false)}
          QrLogin={QrLogin}
        />
      )}

      {linked && (
        <>
          <div className="flex items-center gap-3">
            {user.image !== null ? (
              <img
                src={user.image}
                alt=""
                className="size-10 rounded-full object-cover"
              />
            ) : (
              <div
                aria-hidden
                className="flex size-10 items-center justify-center rounded-full bg-gradient-to-br from-[#3cc2ff] via-[#3a6cff] to-[#5b2fff] text-sm font-semibold text-[#eef1ff]"
              >
                {user.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-[#eef1ff]">
                {user.name}
              </span>
              <span className="flex items-center gap-1.5 font-mono text-xs text-[#8a90a8]">
                {user.steamId}
                <button
                  type="button"
                  aria-label="Скопировать Steam ID"
                  onClick={() => void onCopy()}
                  className="text-[#8a90a8] hover:text-[#eef1ff]"
                >
                  <Copy className="size-3.5" />
                </button>
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-center">
            {stats.map((stat) => (
              <Stat key={stat.label} {...stat} />
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={onRefresh}
            disabled={refreshing}
          >
            Обновить библиотеку
          </Button>
        </>
      )}
    </Panel>
  );
}
