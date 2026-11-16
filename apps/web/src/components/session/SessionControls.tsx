// Кнопки поверх стрима (спека §2.1–2.4): «Меню» в правом верхнем углу и под ним «На весь экран» с
// подписью (только вне полного экрана), подсказка новичку у меню (клик по ней тоже открывает меню),
// выпадающая панель настроек и подтверждение выхода. Здесь же — клавиши по физическому месту
// (`localLayout`). Обучение полному экрану (правка владельца 2026-11-05): шаг 1 — плашка «Играй на
// весь экран» у кнопки, шаг 2 — при первом входе вверху «Чтобы выйти — зажми Esc» (`EscPrompt`);
// пройдено — `fullscreenTutorialSeen`. После перерыва в игре (`TUTORIAL_BREAK_MS`, правка владельца
// 2026-11-05) обучение повторяется — один раз за сессию. В полном экране каждое нажатие Esc
// показывает ту же полоску со шкалой удержания. Шаг 3 (правка владельца 2026-11-05): когда шаги 1–2
// позади и игрок вне полного экрана — подсказка у меню, а первое открытие меню — обход его разделов
// (`menuTour`); пройден — `menuTourSeen`, после перерыва — снова, тоже раз за сессию. В полном
// экране с мышью «Меню» нет (правка владельца 2026-11-05): после клика по игре мышь захвачена и до
// кнопки не дотянуться. На сенсорном экране без мыши кнопка остаётся — тап до неё достаёт.
// Панель и диалог порталятся в корень экрана сессии (`rootRef`): в полном экране браузер
// показывает только поддерево полноэкранного элемента. Закрылись — фокус обратно в стрим.
// В десктоп-приложении полный экран — нативный (`enterFullscreen` → `enter_game_fullscreen`),
// Esc уходит в игру, а удержание Esc (`escHold`) выходит через `exit_game_fullscreen`; уход с
// экрана сессии в игровом полном экране — тоже выход (иначе на macOS Dock и Cmd+Tab остались бы
// выключенными).
import { Maximize, Menu, Minimize, X } from "lucide-react";
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
import { isDesktop } from "@/lib/desktop";
import {
  enterFullscreen,
  escHold,
  escHoldExits,
  exitGameFullscreen,
  focusStream,
  lockPointerOnClick,
  useIsFullscreen,
  watchEscape,
} from "@/lib/fullscreen";
import { physicalKeysInFrame } from "@/lib/physicalKeys";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import type { StreamSettingsControl } from "@/lib/useStreamSettings";
import { cn } from "@/lib/utils";
import { EscPrompt, type EscPromptState } from "./EscPrompt";
import {
  noQualityLimits,
  type PlayedClock,
  type QualityLimits,
  SessionMenu,
} from "./SessionMenu";

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

/** Перерыв в игре, после которого обучение полному экрану показывается снова (14 дней). */
export const TUTORIAL_BREAK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Игрок вернулся после перерыва: до этой сессии он играл (`SessionView.previousPlayedAt`) дольше
 * `TUTORIAL_BREAK_MS` назад. Не играл совсем — не перерыв: тогда обучение и так не пройдено.
 */
export const afterBreak = (
  previousPlayedAt: string | null,
  now: number,
): boolean =>
  previousPlayedAt !== null &&
  now - Date.parse(previousPlayedAt) > TUTORIAL_BREAK_MS;

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
  returning = false,
  limits = noQualityLimits,
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
  /** Игрок вернулся после перерыва (`afterBreak`) — обучение ещё раз, даже пройденное. */
  returning?: boolean;
  /** Потолок качества тарифа (меню «Качество»); план не загрузился — `noQualityLimits`. */
  limits?: QualityLimits;
}) {
  const { settings, loaded, update } = control;
  const fullscreen = useIsFullscreen();
  const reducedMotion = usePrefersReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Панель закрылась ради диалога выхода — фокус берёт диалог, не стрим. Ref, а не состояние:
  // Radix зовёт `onCloseAutoFocus` таймером уже после размонтирования панели.
  const toConfirm = useRef(false);
  // Обучение в этой сессии уже было (вошёл в полный экран или нажал ×) — второй раз не показываем,
  // даже если признак ещё не записан или игрок вернулся после перерыва.
  const [tutorialDone, setTutorialDone] = useState(false);
  const tutorial =
    loaded && !tutorialDone && (!settings.fullscreenTutorialSeen || returning);
  // Признак пишем, только если его ещё нет: после перерыва он уже `true`.
  const finishTutorial = () => {
    setTutorialDone(true);
    if (!settings.fullscreenTutorialSeen)
      update({ fullscreenTutorialSeen: true });
  };
  // Обход меню в этой сессии уже начинали — второй раз не показываем (как `tutorialDone`). Пока
  // признак не загрузился — ни подсказки, ни обхода (не мигать у тех, кто его уже прошёл).
  const [tourDone, setTourDone] = useState(false);
  const tourPending =
    loaded && !tourDone && (!settings.menuTourSeen || returning);
  const [tourStep, setTourStep] = useState<number | null>(null);
  // Шаг 3: подсказка у меню — после шагов 1–2 и вне полного экрана.
  const hint = tourPending && !tutorial && !fullscreen;
  const menuHidden = fullscreen && !touchOnly();
  const holdable = escHoldExits();
  const [tutorialStep2, setTutorialStep2] = useState(false);
  const [esc, setEsc] = useState<EscPromptState | null>(null);

  // Первое открытие меню, пока обход не пройден, — обход с первого шага (закрыли посреди — тоже
  // пройден). Признак пишем при старте и только если его нет: после перерыва он уже `true`.
  const onMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (!open) return;
    setTourStep(tourPending ? 0 : null);
    if (!tourPending) return;
    setTourDone(true);
    if (!settings.menuTourSeen) update({ menuTourSeen: true });
  };

  // Первый вход в полный экран с обучением — шаг 2, и обучение пройдено. Признак и `update`
  // читаются через ref: их смена (запись признака) не должна снимать таймер шага.
  const tutorialRef = useRef(tutorial);
  tutorialRef.current = tutorial;
  const finishRef = useRef(finishTutorial);
  finishRef.current = finishTutorial;
  useEffect(() => {
    if (!fullscreen) {
      setTutorialStep2(false);
      return;
    }
    if (!tutorialRef.current) return;
    finishRef.current();
    if (touchOnly()) return;
    setTutorialStep2(true);
    const timer = setTimeout(() => setTutorialStep2(false), TUTORIAL_STEP2_MS);
    return () => clearTimeout(timer);
  }, [fullscreen]);

  // В полном экране с захватом клавиш нажатый Esc — полоска «Зажми Esc» со шкалой; отпустили —
  // уходит через `ESC_PROMPT_LINGER_MS`. Без захвата Esc выходит сразу — полоске не успеть. В
  // приложении выход по удержанию — наш таймер (`escHold`), в браузере его делает сам Chrome.
  useEffect(() => {
    const frame = frameRef.current;
    if (!fullscreen || !holdable || frame === null) return;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const hold = isDesktop()
      ? escHold(() => void exitGameFullscreen())
      : undefined;
    const stop = watchEscape(frame, {
      onDown: () => {
        hold?.down();
        clearTimeout(hide);
        setTutorialStep2(false);
        setEsc((prev) => ({
          mode: "pressed",
          holding: true,
          press: (prev?.mode === "pressed" ? prev.press : 0) + 1,
        }));
      },
      onUp: () => {
        hold?.up();
        setEsc((prev) =>
          prev?.mode === "pressed" ? { ...prev, holding: false } : prev,
        );
        clearTimeout(hide);
        hide = setTimeout(() => setEsc(null), ESC_PROMPT_LINGER_MS);
      },
    });
    return () => {
      stop();
      hold?.stop();
      clearTimeout(hide);
      setEsc(null);
    };
  }, [fullscreen, holdable, frameRef]);

  // Приложение: ушли с экрана сессии в игровом полном экране — выйти из него. Состояние — через
  // ref: выход нужен только при размонтировании, не при каждой смене `fullscreen`.
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  useEffect(
    () => () => {
      if (fullscreenRef.current && isDesktop()) void exitGameFullscreen();
    },
    [],
  );

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

  // Кнопка ушла вместе с открытой панелью — после выхода из полного экрана панель сама не всплывает.
  useEffect(() => {
    if (menuHidden) setMenuOpen(false);
  }, [menuHidden]);

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
          {!menuHidden && (
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
                  limits={limits}
                  onEndGame={() => {
                    toConfirm.current = true;
                    setMenuOpen(false);
                    setConfirmOpen(true);
                  }}
                  tourStep={tourStep}
                  onTourStep={setTourStep}
                />
              </PopoverContent>
            </Popover>
          )}
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
                  onClick={finishTutorial}
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
        {/* Приложение на сенсорном экране без клавиатуры: удержать Esc нечем, а жестов выхода,
            как у браузера, у окна нет. */}
        {fullscreen && isDesktop() && touchOnly() && (
          <Button
            variant="secondary"
            size="sm"
            className="pointer-events-auto h-[34px] self-start opacity-60 hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void exitGameFullscreen()}
          >
            <Minimize />
            Выйти из полного экрана
          </Button>
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
