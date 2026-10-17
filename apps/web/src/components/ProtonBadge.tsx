// Плашка совместимости ProtonDB с русской подписью тира.
import { type ProtonTier, tierLabel } from "@cg/rpc";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Цвета тиров — как на protondb.com. */
const tierClass: Record<ProtonTier, string> = {
  platinum: "bg-[#b4c7dc]/15 text-[#b4c7dc] border-[#b4c7dc]/30",
  gold: "bg-[#cfb53b]/15 text-[#e0c552] border-[#cfb53b]/30",
  silver: "bg-[#a6a6a6]/15 text-[#c0c0c0] border-[#a6a6a6]/30",
  bronze: "bg-[#cd7f32]/15 text-[#de9b5a] border-[#cd7f32]/30",
  borked: "bg-red-500/15 text-red-400 border-red-500/30",
  pending: "bg-muted text-muted-foreground border-transparent",
};

export function ProtonBadge({ tier }: { tier: ProtonTier }) {
  return (
    <Badge
      variant="outline"
      title={`ProtonDB: ${tierLabel[tier]}`}
      className={cn("max-w-full shrink", tierClass[tier])}
    >
      <span className="truncate">{tierLabel[tier]}</span>
    </Badge>
  );
}
