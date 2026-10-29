// Кнопки поверх стрима (спека §2.1–2.4): «На весь экран» (только вне полного экрана) и «Меню»
// в правом верхнем углу, подсказка новичку, выпадающая панель настроек и подтверждение выхода.
// Панель и диалог порталятся в корень экрана сессии (`rootRef`): в полном экране браузер
// показывает только поддерево полноэкранного элемента. Закрылись — фокус обратно в стрим.
import { Maximize, Menu } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  enterFullscreen,
  focusStream,
  lockPointerOnClick,
  useIsFullscreen,
} from "@/lib/fullscreen";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import type { StreamSettingsControl } from "@/lib/useStreamSettings";
import { cn } from "@/lib/utils";
import { type PlayedClock, SessionMenu } from "./SessionMenu";

/**
 * Полупрозрачная квадратная кнопка поверх игры: ярче при наведении и фокусе. Клики берут
 * только сами кнопки — контейнер сквозной.
 */
const overlayButton =
  "pointer-events-auto size-[34px] opacity-60 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

export function SessionControls({
  control,
  gameName,
  played,
  onExit,
  rootRef,
  frameRef,
}: {
  control: StreamSettingsControl;
  gameName: string;
  played: PlayedClock;
  /** Игрок подтвердил «Закончить игру». */
  onExit: () => void;
  /** Корень экрана сессии: его разворачиваем на весь экран, в него порталим панель и диалог. */
  rootRef: RefObject<HTMLElement | null>;
  /** Iframe стрима: в него возвращается фокус. */
  frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  const { settings, loaded, update } = control;
  const fullscreen = useIsFullscreen();
  const reducedMotion = usePrefersReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Панель закрылась ради диалога выхода — фокус берёт диалог, не стрим. Ref, а не состояние:
  // Radix зовёт `onCloseAutoFocus` таймером уже после размонтирования панели.
  const toConfirm = useRef(false);
  // Пока признак не загрузился — без подсказки (не мигать у тех, кто уже открывал меню).
  const hint = loaded && !settings.menuSeen;

  // Отметка «меню видели» — только когда подсказка была показана: до загрузки настроек
  // признака ещё не знаем, и записывать его не за что.
  const onMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (open && hint) update({ menuSeen: true });
  };

  // В полном экране клик по игре захватывает мышь (камера в играх от первого лица); вышли — отпускаем.
  useEffect(() => {
    const frame = frameRef.current;
    if (!fullscreen || frame === null) return;
    return lockPointerOnClick(frame);
  }, [fullscreen, frameRef]);

  // Клик по игре уводит фокус в iframe — до документа страницы не доходит ни `pointerdown`,
  // ни `focusin`, и Radix «клика мимо» не видит. Видно только потерю фокуса окном страницы.
  useEffect(() => {
    if (!menuOpen) return;
    const onBlur = () => setMenuOpen(false);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [menuOpen]);

  const returnFocus = (event: Event) => {
    event.preventDefault();
    focusStream(frameRef.current);
  };

  return (
    // Сквозной контейнер: щели между кнопками и плашка подсказки не перехватывают клики по
    // игре (иначе клик уводит фокус из стрима и клавиши перестают доходить до игры).
    <div className="pointer-events-none absolute top-3 right-3 z-30 flex items-center gap-2">
      {hint && (
        <div className="pointer-events-none rounded-md border border-brand-cyan/40 bg-black/70 px-3 py-1.5 text-sm text-brand-text shadow-lg">
          Здесь <strong className="text-brand-cyan">настройки игры</strong> и
          выход
        </div>
      )}
      {!fullscreen && (
        <Button
          variant="secondary"
          size="icon"
          aria-label="На весь экран"
          className={overlayButton}
          onClick={() => {
            const root = rootRef.current;
            if (root === null) return;
            // Браузер отказал (нет жеста, запрещено политикой) — остаёмся в окне.
            enterFullscreen(root, frameRef.current).catch(() => {});
          }}
        >
          <Maximize />
        </Button>
      )}
      <Popover open={menuOpen} onOpenChange={onMenuOpenChange}>
        <div className="relative">
          {hint && (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute -inset-1 rounded-lg ring-2 ring-brand-cyan",
                !reducedMotion && "animate-pulse",
              )}
            />
          )}
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Меню"
              className={overlayButton}
            >
              <Menu />
            </Button>
          </PopoverTrigger>
        </div>
        <PopoverContent
          container={rootRef.current}
          align="end"
          sideOffset={8}
          className="w-[300px]"
          // В полном экране Esc (захваченный) — клавиша игры, а не «закрыть меню».
          onEscapeKeyDown={(event) => {
            if (fullscreen) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (toConfirm.current) {
              toConfirm.current = false;
              event.preventDefault();
              return;
            }
            returnFocus(event);
          }}
        >
          <SessionMenu
            gameName={gameName}
            played={played}
            settings={settings}
            onChange={update}
            onEndGame={() => {
              toConfirm.current = true;
              setMenuOpen(false);
              setConfirmOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          container={rootRef.current}
          onCloseAutoFocus={returnFocus}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Закончить игру? Прогресс сохранится.
            </AlertDialogTitle>
            <AlertDialogDescription>
              Игра закроется, сохранения синхронизируются со Steam Cloud.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Продолжить играть</AlertDialogCancel>
            <AlertDialogAction onClick={onExit}>
              Закончить игру
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
