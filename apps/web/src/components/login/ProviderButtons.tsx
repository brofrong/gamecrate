// Кнопки способов входа: показываются только провайдеры, включённые на сервере;
// наведение подсвечивает кубики цветом сервиса, клик запускает вход этим провайдером.
import { cn } from "@/lib/utils";
import type { AuthProviders } from "@cg/rpc";

type Provider = "yandex" | "google" | "telegram";

const META: Record<
  Provider,
  { label: string; icon: string; className: string }
> = {
  yandex: {
    label: "Войти через Яндекс",
    icon: "Я",
    className: "bg-[#fc3f1d] text-white hover:bg-[#e2360f]",
  },
  google: {
    label: "Войти через Google",
    icon: "G",
    className: "bg-white text-[#1f1f1f] hover:bg-white/90",
  },
  telegram: {
    label: "Войти через Telegram",
    icon: "✈",
    className: "bg-[#29a9eb] text-white hover:bg-[#1f95d1]",
  },
};

export function ProviderButtons({
  providers,
  onProvider,
  onHover,
  pending,
}: {
  providers: AuthProviders;
  onProvider: (p: Provider) => void;
  onHover: (p: Provider | null) => void;
  pending: boolean;
}) {
  const active: Provider[] = (
    [
      providers.yandex && "yandex",
      providers.google && "google",
      providers.telegram && "telegram",
    ] as const
  ).filter((p): p is Provider => Boolean(p));

  if (active.length === 0) return null;

  return (
    <div className="grid gap-2.5">
      {active.map((p) => {
        const meta = META[p];
        return (
          <button
            key={p}
            type="button"
            disabled={pending}
            onMouseEnter={() => onHover(p)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onProvider(p)}
            className={cn(
              "flex h-11 items-center gap-3 rounded-xl px-4 text-sm font-semibold transition-colors disabled:opacity-50",
              meta.className,
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center font-bold"
            >
              {meta.icon}
            </span>
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
