// Ссылка «Скачать приложение» на `/download`: только в браузере — в самом десктоп-приложении
// она не нужна (спека «Раздача и автообновление»).
import { Link } from "@tanstack/react-router";
import { isDesktop } from "@/lib/desktop";

export function DownloadLink({ className }: { className?: string }) {
  if (isDesktop()) return null;
  return (
    <Link to="/download" className={className}>
      Скачать приложение
    </Link>
  );
}
