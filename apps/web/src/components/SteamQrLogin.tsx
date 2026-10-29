// Экран «Вход в Steam по QR»: при монтировании заводит попытку (`steamLogin.start`),
// опрашивает её состояние раз в секунду (`steamLogin.status`) до терминального статуса,
// рисует QR в браузере из `qrUrl` и перерисовывает его, если Steam выдал новый код
// (спека §5.5); используется в `/library`, в профиле и на экране сессии.
import { type SteamLoginView, steamLoginReasons } from "@cg/rpc";
import { useAtomSet } from "@effect/atom-react";
import { Exit } from "effect";
import { LoaderCircle } from "lucide-react";
import QRCode from "qrcode";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { SteamGuardHint } from "@/components/SteamGuardHint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorTag, startSteamLoginAtom, steamLoginStatusAtom } from "@/rpc";

/** Между опросами статуса попытки («раз в 1 с», спека §5.5). */
const POLL_MS = 1_000;

/**
 * Опрос переживает отдельные сбои сети (транзиентная `RpcClientError` и т.п.), но не
 * бесконечно — после стольких подряд неудачных опросов сдаёмся и показываем ошибку,
 * а не крутим спиннер вечно.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

const STATUS_TEXT: Record<"waiting" | "scanned" | "done", string> = {
  waiting: "Ждём сканирования",
  scanned: "Продолжайте в приложении Steam",
  done: "Готово",
};

const HINT =
  "Откройте приложение Steam на телефоне → значок щита → «Сканировать QR-код»";

/**
 * Результат одного опроса `status`: сама попытка (`view`), `notFound` — попытки уже
 * нет на сервере (истекла безвозвратно, не просто «подождите ещё секунду»), или
 * `error` — сетевая/прочая ошибка, которую можно попробовать пережить повторным опросом.
 */
export type SteamLoginStatusResult =
  | { readonly kind: "view"; readonly view: SteamLoginView }
  | { readonly kind: "notFound" }
  | { readonly kind: "error" };

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
  status: (attemptId: string) => Promise<SteamLoginStatusResult>;
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
      if (result !== null) {
        setAttemptId(result.attemptId);
        return;
      }
      // Попытку завести не удалось — показываем ошибку и «Показать новый код»,
      // а не вечный спиннер (опрашивать нечего, `attemptId` пустой и не используется).
      setView({
        attemptId: "",
        status: "failed",
        qrUrl: null,
        reason: steamLoginReasons.steamError,
      });
    });
  };

  // Завести попытку при монтировании.
  useEffect(() => {
    begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Опрос раз в `pollMs`, пока статус не терминальный (done/expired/failed).
  // Опросы идут строго по очереди: следующий планируется только после ответа на
  // предыдущий, так медленные ответы не накладываются и не приходят не по порядку.
  // `notFound` сдаётся сразу (попытки больше нет — ждать нечего); прочие ошибки
  // (сеть и т.п.) переживаем до `MAX_CONSECUTIVE_FAILURES` подряд, иначе крутили бы
  // спиннер вечно без видимого результата.
  useEffect(() => {
    if (attemptId === null) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (!stopped) timer = setTimeout(() => void tick(), pollMs);
    };
    const giveUp = () => {
      stopped = true;
      setView({
        attemptId,
        status: "failed",
        qrUrl: null,
        reason: steamLoginReasons.steamError,
      });
    };
    const tick = async () => {
      const result = await status(attemptId);
      if (stopped) return;
      if (result.kind === "notFound") {
        giveUp();
        return;
      }
      if (result.kind === "error") {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) giveUp();
        else next();
        return;
      }
      failures = 0;
      setView(result.view);
      if (
        result.view.status === "waiting" ||
        result.view.status === "scanned"
      ) {
        next();
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
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
  const scanned = view?.status === "scanned";

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
        // Пока ждём сканирования — QR слева, шаги справа (на узком экране — под ним);
        // после сканирования QR не нужен, и шаги занимают всю ширину.
        <div
          className={cn(
            "flex w-full flex-col items-center gap-5",
            !scanned && "md:flex-row md:items-start",
          )}
        >
          <div
            className={cn(
              "flex flex-col items-center gap-3",
              !scanned && "md:w-52 md:shrink-0",
            )}
          >
            {svg !== null && (
              <div
                className="size-48 [&_svg]:size-full"
                // biome-ignore lint: разметка — доверенный SVG от локальной библиотеки `qrcode`.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
            {!scanned && (
              <p className="text-sm text-muted-foreground">{HINT}</p>
            )}
            <p className="text-sm font-medium">{STATUS_TEXT[view.status]}</p>
          </div>
          <SteamGuardHint wide={scanned} />
        </div>
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
        if (Exit.isSuccess(exit)) return { kind: "view", view: exit.value };
        return errorTag(exit.cause) === "SteamLoginNotFound"
          ? { kind: "notFound" }
          : { kind: "error" };
      }}
    />
  );
};

/**
 * Модальная обёртка для карточки `/library` и строки Steam в `/profile`.
 * Закрывается кнопкой «Отмена» или Escape (`onClose`).
 * `QrLogin` подменяется в тестах, чтобы не тянуть настоящий RPC-клиент.
 */
export function SteamQrLoginDialog({
  open,
  title,
  onDone,
  onClose,
  QrLogin = SteamQrLogin,
}: {
  open: boolean;
  title: string;
  onDone: () => void;
  onClose: () => void;
  QrLogin?: SteamQrLoginComponent;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg">
        <QrLogin title={title} onDone={onDone} />
        <Button variant="ghost" className="self-center" onClick={onClose}>
          Отмена
        </Button>
      </div>
    </div>
  );
}
