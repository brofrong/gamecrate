// Кнопки поверх стрима (спека §2.1–2.4): «Меню» в правом верхнем углу и под ним «На весь экран» с
// подписью (только вне полного экрана), подсказка новичку у меню (клик по ней тоже открывает меню),
// выпадающая панель настроек и подтверждение выхода. Здесь же — клавиши по физическому месту
// (`localLayout`). Обучение полному экрану (правка владельца 2026-11-05): шаг 1 — плашка «Играй на
// весь экран» у кнопки, шаг 2 — при первом входе вверху «Чтобы выйти — зажми Esc» (`EscPrompt`);
// пройдено — `fullscreenTutorialSeen`. В полном экране каждое нажатие Esc показывает ту же полоску
// со шкалой удержания.
// Панель и диалог порталятся в корень экрана сессии (`rootRef`): в полном экране браузер
// показывает только поддерево полноэкранного элемента. Закрылись — фокус обратно в стрим.
import { Maximize, Menu, X } from "lucide-react";
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
  keyboardLockSupported,
  lockPointerOnClick,
  useIsFullscreen,
  watchEscape,
} from "@/lib/fullscreen";
import { physicalKeysInFrame } from "@/lib/physicalKeys";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import type { StreamSettingsControl } from "@/lib/useStreamSettings";
import { cn } from "@/lib/utils";
import { EscPrompt, type EscPromptState } from "./EscPrompt";
import { type PlayedClock, SessionMenu } from "./SessionMenu";

/**
 * Полупрозрачная квадратная кнопка поверх игры: ярче при наведении и фокусе. Клики берут
 * только сами кнопки — контейнер сквозной.
 */
const overlayButton =
  "pointer-events-auto size-[34px] opacity-60 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

/** Плашка подсказки новичку рядом с кнопкой. */
const hintClassName =
  "pointer-events-auto rounded-md border border-brand-cyan/40 bg-black/70 text-sm text-brand-text shadow-lg hover:border-brand-cyan";

/** Сколько держится шаг 2 обучения («Чтобы выйти — зажми Esc») после первого входа в полный экран. */
const TUTORIAL_STEP2_MS = 6_000;

/** Через сколько после отпускания Esc уходит полоска «Зажми Esc». */
const ESC_PROMPT_LINGER_MS = 3_000;

/**
 * Только сенсорный экран, без мыши и клавиатуры (телефон, планшет): шаг 2 обучения про Esc там
 * не нужен. matchMedia читаем при вызове — тесты подменяют его.
 */
const touchOnly = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches &&
  !window.matchMedia("(any-pointer: fine)").matches;

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
  const tutorial = loaded && !settings.fullscreenTutorialSeen;
  const holdable = keyboardLockSupported();
  const [tutorialStep2, setTutorialStep2] = useState(false);
  const [esc, setEsc] = useState<EscPromptState | null>(null);

  // Отметка «меню видели» — только когда подсказка была показана: до загрузки настроек
  // признака ещё не знаем, и записывать его не за что.
  const onMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (open && hint) update({ menuSeen: true });
  };

  // Первый вход в полный экран с непройденным обучением — шаг 2, и обучение пройдено. Признак и
  // `update` читаются через ref: их смена (запись признака) не должна снимать таймер шага.
  const tutorialRef = useRef(tutorial);
  tutorialRef.current = tutorial;
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(() => {
    if (!fullscreen) {
      setTutorialStep2(false);
      return;
    }
    if (!tutorialRef.current) return;
    updateRef.current({ fullscreenTutorialSeen: true });
    if (touchOnly()) return;
    setTutorialStep2(true);
    const timer = setTimeout(() => setTutorialStep2(false), TUTORIAL_STEP2_MS);
    return () => clearTimeout(timer);
  }, [fullscreen]);

  // В полном экране с захватом клавиш нажатый Esc — полоска «Зажми Esc» со шкалой; отпустили —
  // уходит через `ESC_PROMPT_LINGER_MS`. Без захвата Esc выходит сразу — полоске не успеть.
  useEffect(() => {
    const frame = frameRef.current;
    if (!fullscreen || !holdable || frame === null) return;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const stop = watchEscape(frame, {
      onDown: () => {
        clearTimeout(hide);
        setTutorialStep2(false);
        setEsc((prev) => ({
          mode: "pressed",
          holding: true,
          press: (prev?.mode === "pressed" ? prev.press : 0) + 1,
        }));
      },
      onUp: () => {
        setEsc((prev) =>
          prev?.mode === "pressed" ? { ...prev, holding: false } : prev,
        );
        clearTimeout(hide);
        hide = setTimeout(() => setEsc(null), ESC_PROMPT_LINGER_MS);
      },
    });
    return () => {
      stop();
      clearTimeout(hide);
      setEsc(null);
    };
  }, [fullscreen, holdable, frameRef]);

  const goFullscreen = () => {
    const root = rootRef.current;
    if (root === null) return;
    // Браузер отказал (нет жеста, запрещено политикой) — остаёмся в окне.
    enterFullscreen(root, frameRef.current).catch(() => {});
  };

  const escPrompt: EscPromptState | null = !fullscreen
    ? null
    : (esc ?? (tutorialStep2 ? { mode: "tutorial" } : null));

  // В полном экране клик по игре захватывает мышь (камера в играх от первого лица); вышли — отпускаем.
  useEffect(() => {
    const frame = frameRef.current;
    if (!fullscreen || frame === null) return;
    return lockPointerOnClick(frame);
  }, [fullscreen, frameRef]);

  // Клавиши по месту, пока не выбрано «печатать на своей раскладке»; переключатель читается на
  // каждое нажатие — переподписываться на его смену не нужно.
  const localLayoutRef = useRef(settings.localLayout);
  localLayoutRef.current = settings.localLayout;
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    return physicalKeysInFrame(frame, () => !localLayoutRef.current);
  }, [frameRef]);

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
    <>
      {/* Сквозной контейнер: щели между кнопками и плашки подсказок не перехватывают клики по
        игре (иначе клик уводит фокус из стрима и клавиши перестают доходить до игры). */}
      <div className="pointer-events-none absolute top-3 right-3 z-30 flex flex-col items-end gap-2">
        <div data-testid="menu-row" className="flex items-center gap-2">
          {/* Подсказку тоже нажимают вместо кнопки — она открывает меню. Клик по ней уводит фокус
          из стрима, но меню и так его забирает, а закрывшись — вернёт. */}
          {hint && (
            <button
              type="button"
              onClick={() => onMenuOpenChange(true)}
              className={cn(hintClassName, "cursor-pointer px-3 py-1.5")}
            >
              Здесь <strong className="text-brand-cyan">настройки игры</strong>{" "}
              и выход
            </button>
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
        </div>
        {!fullscreen && (
          <div data-testid="fullscreen-row" className="flex items-center gap-2">
            {/* Шаг 1 обучения: плашка тоже разворачивает на весь экран, × — обучение не нужно. */}
            {tutorial && (
              <div className={cn(hintClassName, "flex items-center")}>
                <button
                  type="button"
                  onClick={goFullscreen}
                  className="cursor-pointer py-1.5 pl-3"
                >
                  Играй{" "}
                  <strong className="text-brand-cyan">на весь экран</strong> →
                </button>
                <button
                  type="button"
                  aria-label="Скрыть подсказку"
                  onClick={() => update({ fullscreenTutorialSeen: true })}
                  className="cursor-pointer px-2 py-1.5 text-muted-foreground hover:text-brand-text"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="pointer-events-auto h-[34px] opacity-60 hover:opacity-100 focus-visible:opacity-100"
              onClick={goFullscreen}
            >
              <Maximize />
              На весь экран
            </Button>
          </div>
        )}
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
      {escPrompt !== null && (
        <EscPrompt
          state={escPrompt}
          holdable={holdable}
          reducedMotion={reducedMotion}
        />
      )}
    </>
  );
}
