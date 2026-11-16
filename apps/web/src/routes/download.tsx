// `/download`: скачать десктоп-приложение. Манифест `latest.json` отдаёт API (в нём версия и
// ссылки), страница под ОС посетителя показывает большую кнопку, остальные системы — ниже.
// Приложение пока без подписи разработчика, поэтому здесь же объяснено, что нажать, когда
// система ругается. Манифеста нет (первый релиз ещё не выложен) — «Скоро» и ссылка в браузер.
import { createRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { type DesktopOs, detectOs } from "@/lib/detectOs";
import { formatSize, parseRelease, type Release } from "@/lib/desktopRelease";
import { homePath } from "@/lib/desktop";
import { rootRoute } from "./__root";

export type DownloadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; release: Release };

const osNames: Record<DesktopOs, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

const osOrder: ReadonlyArray<DesktopOs> = ["windows", "macos", "linux"];

const requirements: Record<DesktopOs, string> = {
  windows: "Windows 10 и новее",
  macos: "macOS 11 и новее",
  linux: "Ubuntu 22.04 и новее, AppImage",
};

const manifestUrl = "/download/desktop/latest.json";

const loadRelease = async (): Promise<DownloadState> => {
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) return { kind: "missing" };
    const release = parseRelease(await response.json());
    return release === null ? { kind: "missing" } : { kind: "ready", release };
  } catch {
    // сеть, не JSON (SPA отдала index.html): для посетителя это «сборки ещё нет»
    return { kind: "missing" };
  }
};

function DownloadButton({
  os,
  release,
  big,
}: {
  os: DesktopOs;
  release: Release;
  big: boolean;
}) {
  const file = release.downloads[os];
  if (file === undefined) return null;
  const size = file.size === undefined ? null : formatSize(file.size);
  return (
    <a
      href={file.url}
      download
      className={
        big
          ? "inline-flex flex-col items-center rounded-xl bg-brand-gradient px-8 py-4 text-lg font-semibold text-white shadow-lg transition hover:brightness-110"
          : "inline-flex flex-col items-center rounded-lg border border-brand-line px-5 py-3 text-sm font-medium transition hover:border-brand-muted"
      }
    >
      <span>Скачать для {osNames[os]}</span>
      {size !== null && (
        <span className={big ? "text-sm font-normal text-white/80" : "text-xs text-brand-muted"}>
          {size}
        </span>
      )}
    </a>
  );
}

/** Что нажать, когда система не доверяет приложению без подписи разработчика. */
function UnsignedHelp() {
  return (
    <section className="grid gap-3 rounded-xl border border-brand-line p-5 text-sm text-brand-muted">
      <h2 className="text-base font-semibold text-brand-text">
        Система ругается на приложение
      </h2>
      <p>
        Приложение пока без подписи разработчика, поэтому при первом запуске
        система спросит подтверждение. Это нормально.
      </p>
      <ul className="grid gap-2">
        <li>
          <b className="text-brand-text">Windows.</b> Появилось окно «Windows
          защитила ваш компьютер»: нажмите «Подробнее», затем «Выполнить в
          любом случае».
        </li>
        <li>
          <b className="text-brand-text">macOS.</b> Если система не открывает
          приложение, нажмите на него правой кнопкой и выберите «Открыть», потом
          ещё раз «Открыть» в окне.
        </li>
        <li>
          <b className="text-brand-text">Linux.</b> Сделайте файл исполняемым:{" "}
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-brand-text">
            chmod +x GameCrate_*.AppImage
          </code>{" "}
          и запустите его.
        </li>
      </ul>
    </section>
  );
}

function ReadyContent({
  release,
  os,
}: {
  release: Release;
  os: DesktopOs | null;
}) {
  const others = osOrder.filter((name) => name !== os);
  const own = os !== null && release.downloads[os] !== undefined;
  return (
    <>
      <h1 className="text-3xl font-semibold">Приложение GameCrate</h1>
      <p className="text-brand-muted">
        Играйте в окне приложения: полный экран, сохранение настроек и
        уведомление, когда подошла очередь.
      </p>
      {os !== null && own && (
        <div className="grid justify-items-start gap-2">
          <DownloadButton os={os} release={release} big />
          <p className="text-xs text-brand-muted">{requirements[os]}</p>
        </div>
      )}
      {os !== null && !own && (
        <p className="text-sm text-brand-muted">
          Для {osNames[os]} пока нет сборки.
        </p>
      )}
      {os === null ? (
        <div className="flex flex-wrap gap-3">
          {osOrder.map((name) => (
            <DownloadButton key={name} os={name} release={release} big={false} />
          ))}
        </div>
      ) : (
        <div role="group" aria-label="Другие системы" className="grid gap-2">
          <span className="text-sm text-brand-muted">Другие системы</span>
          <div className="flex flex-wrap gap-3">
            {others.map((name) => (
              <DownloadButton key={name} os={name} release={release} big={false} />
            ))}
          </div>
        </div>
      )}
      <p className="text-sm text-brand-muted">Версия {release.version}</p>
      <UnsignedHelp />
    </>
  );
}

function SoonContent() {
  return (
    <>
      <h1 className="text-3xl font-semibold">Скоро</h1>
      <p className="text-brand-muted">
        Приложение GameCrate для компьютера ещё готовится. А пока можно играть
        прямо в браузере.
      </p>
      <Link
        to="/app"
        className="inline-flex w-fit rounded-xl bg-brand-gradient px-6 py-3 font-semibold text-white transition hover:brightness-110"
      >
        Играть в браузере
      </Link>
    </>
  );
}

export function DownloadContent({
  state,
  os,
}: {
  state: DownloadState;
  os: DesktopOs | null;
}) {
  return (
    <div className="grid gap-5">
      {state.kind === "loading" && (
        <p className="text-brand-muted">Загружаем сведения о приложении…</p>
      )}
      {state.kind === "missing" && <SoonContent />}
      {state.kind === "ready" && <ReadyContent release={state.release} os={os} />}
    </div>
  );
}

export function DownloadPage() {
  const [state, setState] = useState<DownloadState>({ kind: "loading" });
  const [os] = useState(() => detectOs());

  useEffect(() => {
    let active = true;
    void loadRelease().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="min-h-dvh bg-brand-bg font-sans text-brand-text">
      <header className="mx-auto flex max-w-screen-md items-center px-6 py-6">
        <Link to={homePath()} aria-label="GameCrate">
          <Logo height={32} />
        </Link>
      </header>
      <main className="mx-auto max-w-screen-md px-6 pb-16">
        <DownloadContent state={state} os={os} />
      </main>
    </div>
  );
}

export const downloadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/download",
  component: DownloadPage,
});
