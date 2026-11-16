// Ссылка «Скачать приложение» на `/download`: только в браузере — в самом десктоп-приложении
// она не нужна (спека «Раздача и автообновление»). На витринах партнёров тоже нет: приложение —
// GameCrate и открывает сайт GameCrate.
import { Link } from "@tanstack/react-router";
import { useBrand } from "@/brands";
import { isDesktop } from "@/lib/desktop";

export function DownloadLink({ className }: { className?: string }) {
  const brand = useBrand();
  if (isDesktop() || brand.id !== "gamecrate") return null;
  return (
    <Link to="/download" className={className}>
      Скачать приложение
    </Link>
  );
}
