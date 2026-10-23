// Экран «Вход в Steam по QR»: при монтировании заводит попытку (`steamLogin.start`),
// опрашивает её состояние раз в секунду (`steamLogin.status`) до терминального статуса,
// рисует QR в браузере из `qrUrl` и перерисовывает его, если Steam выдал новый код
// (спека §5.5); используется в `/library`, в профиле и на экране сессии.
import type { SteamLoginView } from "@cg/rpc";
import { useAtomSet } from "@effect/atom-react";
import { Exit } from "effect";
import { LoaderCircle } from "lucide-react";
import QRCode from "qrcode";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { startSteamLoginAtom, steamLoginStatusAtom } from "@/rpc";

/** Между опросами статуса попытки («раз в 1 с», спека §5.5). */
const POLL_MS = 1_000;

const STATUS_TEXT: Record<"waiting" | "scanned" | "done", string> = {
  waiting: "Ждём сканирования",
  scanned: "Подтвердите вход в приложении Steam",
  done: "Готово",
};

const HINT =
  "Откройте приложение Steam на телефоне → значок щита → «Сканировать QR-код»";

/**
 * Логика и разметка экрана; `start`/`status` — вызовы RPC как простые функции (а не
 * атомы), чтобы тест мог подменить их фейком без настоящего сокета. `SteamQrLogin`
 * ниже просто подключает сюда настоящие `steamLogin.*` — так эта вьюшка тестируется
 * прямо, без атомов `@/rpc`.
 */
export function SteamQrLoginView({
  title,
  onDone,
  start,
  status,
  pollMs = POLL_MS,
}: {
  title: string;
  onDone: () => void;
  start: () => Promise<{ readonly attemptId: string } | null>;
  status: (attemptId: string) => Promise<SteamLoginView | null>;
  pollMs?: number;
}) {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [view, setView] = useState<SteamLoginView | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const doneFired = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const begin = () => {
    setView(null);
    setSvg(null);
    doneFired.current = false;
    void start().then((result) => {
      if (result !== null) setAttemptId(result.attemptId);
    });
  };

  // Завести попытку при монтировании.
  useEffect(() => {
    begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Опрос раз в `pollMs`, пока статус не терминальный (done/expired/failed).
  useEffect(() => {
    if (attemptId === null) return;
    let stopped = false;
    const tick = async () => {
      const result = await status(attemptId);
      if (stopped || result === null) return;
      setView(result);
      if (result.status !== "waiting" && result.status !== "scanned") {
        stopped = true;
        clearInterval(timer);
      }
    };
    const timer = setInterval(() => void tick(), pollMs);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [attemptId, status, pollMs]);

  // Рисуем QR заново, когда код появился или Steam выдал новый.
  useEffect(() => {
    if (view?.status !== "waiting" || view.qrUrl === null) {
      setSvg(null);
      return;
    }
    let cancelled = false;
    void QRCode.toString(view.qrUrl, { type: "svg" }).then((markup) => {
      if (!cancelled) setSvg(markup);
    });
    return () => {
      cancelled = true;
    };
  }, [view?.status, view?.qrUrl]);

  // «Готово» — экран уже отрисован, зовём `onDone` следом (один раз).
  useEffect(() => {
    if (view?.status === "done" && !doneFired.current) {
      doneFired.current = true;
      onDoneRef.current();
    }
  }, [view]);

  const failed = view?.status === "expired" || view?.status === "failed";

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <p className="text-lg font-medium">{title}</p>
      {view === null ? (
        <LoaderCircle className="size-6 animate-spin" />
      ) : failed ? (
        <>
          <p className="text-sm text-destructive">
            {view.reason ?? "Время вышло"}
          </p>
          <Button onClick={begin}>Показать новый код</Button>
        </>
      ) : (
        <>
          {svg !== null && (
            <div
              className="size-48 [&_svg]:size-full"
              // biome-ignore lint: разметка — доверенный SVG от локальной библиотеки `qrcode`.
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
          <p className="text-sm text-muted-foreground">{HINT}</p>
          <p className="text-sm font-medium">{STATUS_TEXT[view.status]}</p>
        </>
      )}
    </div>
  );
}

/** Тип компонента `SteamQrLogin` — общий для всех мест, где его подменяют в тестах. */
export type SteamQrLoginComponent = (props: {
  title: string;
  onDone: () => void;
}) => React.ReactElement;

/** Обёртка для приложения: `start`/`status` — настоящие `steamLogin.*` из `@/rpc`. */
export const SteamQrLogin: SteamQrLoginComponent = ({ title, onDone }) => {
  const startCall = useAtomSet(startSteamLoginAtom, { mode: "promiseExit" });
  const statusCall = useAtomSet(steamLoginStatusAtom, { mode: "promiseExit" });
  return (
    <SteamQrLoginView
      title={title}
      onDone={onDone}
      start={async () => {
        const exit = await startCall({ payload: undefined });
        return Exit.isSuccess(exit) ? exit.value : null;
      }}
      status={async (attemptId) => {
        const exit = await statusCall({ payload: { attemptId } });
        return Exit.isSuccess(exit) ? exit.value : null;
      }}
    />
  );
};

/**
 * Модальная обёртка для карточки `/library` и строки Steam в `/profile`.
 * `QrLogin` подменяется в тестах, чтобы не тянуть настоящий RPC-клиент.
 */
export function SteamQrLoginDialog({
  open,
  title,
  onDone,
  QrLogin = SteamQrLogin,
}: {
  open: boolean;
  title: string;
  onDone: () => void;
  QrLogin?: SteamQrLoginComponent;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-lg">
        <QrLogin title={title} onDone={onDone} />
      </div>
    </div>
  );
}
