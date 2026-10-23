// Панель «Steam» в правой колонке `/app` (прототип `docs/brand/prototypes/app-home.html`):
// без привязанного Steam — заголовок с кнопкой «Привязать Steam» вместо остальной
// карточки; привязан — аватар/имя/SteamID (с копированием), три числа («игр»/«готовы»/
// «синхр.») и кнопка «Обновить библиотеку».
import type { CurrentUserShape, LibraryView } from "@cg/rpc";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { linkSteam } from "@/auth";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/formatTime";

export function SteamPanel({
  user,
  view,
  onRefresh,
  refreshing,
}: {
  user: CurrentUserShape;
  view: LibraryView | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const linked = user.steamId !== null;
  const total = view?._tag === "Ready" ? view.entries.length : 0;
  const ready =
    view?._tag === "Ready"
      ? view.entries.filter((entry) => entry.cloud._tag === "Ready").length
      : 0;
  const syncedAt = view?._tag === "Ready" ? view.syncedAt : null;

  const onCopy = () => {
    if (user.steamId === null) return;
    void navigator.clipboard.writeText(user.steamId);
    toast.success("Скопировано");
  };

  return (
    <section className="flex flex-col gap-3 rounded-[20px] bg-[#13161d] p-[18px]">
      <h2 className="flex items-center gap-2.5 text-[17px] font-bold text-[#eef1ff]">
        <span
          aria-hidden
          className="flex size-[30px] items-center justify-center rounded-full bg-[#2a2e3a] font-mono text-[10px] font-bold"
        >
          ST
        </span>
        Steam
        {linked ? (
          <span className="ml-auto flex items-center gap-1.5 rounded-xl bg-[#3ddc97]/10 px-2.5 py-1 text-xs font-medium text-[#3ddc97]">
            <span aria-hidden className="size-1.5 rounded-full bg-[#3ddc97]" />
            Привязан
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => void linkSteam("/app")}
          >
            Привязать Steam
          </Button>
        )}
      </h2>

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
                  onClick={onCopy}
                  className="text-[#8a90a8] hover:text-[#eef1ff]"
                >
                  <Copy className="size-3.5" />
                </button>
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-[#8a90a8]">игр</span>
              <span className="text-lg font-bold text-[#eef1ff]">{total}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-[#8a90a8]">готовы</span>
              <span className="text-lg font-bold text-[#eef1ff]">{ready}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-[#8a90a8]">синхр.</span>
              <span className="text-lg font-bold text-[#eef1ff]">
                {syncedAt === null
                  ? "—"
                  : formatRelativeDate(syncedAt, new Date())}
              </span>
            </div>
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
    </section>
  );
}
