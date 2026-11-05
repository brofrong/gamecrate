// Подсказка о выходе из полного экрана вверху по центру (ниже пузыря самого Chrome «Удерживайте
// Esc», чтобы его не перекрыть). Два вида:
// - `tutorial` — шаг 2 обучения при первом входе: клавиша Esc на картинке сама нажимается и
//   держится, шкала заполняется (цикл `gc-esc-press`/`gc-esc-fill` в `styles.css`);
// - `pressed` — игрок нажал Esc: пока держит, шкала заполняется за `ESC_HOLD_MS` — столько браузер
//   ждёт до выхода. `press` — номер нажатия: новое нажатие запускает шкалу заново.
// Без Keyboard Lock API (`holdable === false`) Esc выходит сразу — «нажми», без шкалы. Клики
// сквозь подсказку уходят в игру. При «уменьшить движение» — без анимации.
import type { CSSProperties } from "react";
import { ESC_HOLD_MS } from "@/lib/fullscreen";
import { cn } from "@/lib/utils";

export type EscPromptState =
  | { readonly mode: "tutorial" }
  | {
      readonly mode: "pressed";
      readonly holding: boolean;
      readonly press: number;
    };

const TUTORIAL_CYCLE_MS = 2_500;

/**
 * Шкала удержания: в обучении — цикл, у нажатия — заполнение за `ESC_HOLD_MS`, пока держат;
 * без анимации — полная, пока держат, иначе пустая.
 */
function progressStyle(
  tutorial: boolean,
  holding: boolean,
  animate: boolean,
): CSSProperties | undefined {
  if (!animate) return holding ? { width: "100%" } : undefined;
  if (tutorial)
    return {
      animation: `gc-esc-fill ${TUTORIAL_CYCLE_MS}ms ease-in-out infinite`,
    };
  if (holding) return { animation: `gc-fill ${ESC_HOLD_MS}ms linear forwards` };
  return undefined;
}

export function EscPrompt({
  state,
  holdable,
  reducedMotion,
}: {
  state: EscPromptState;
  holdable: boolean;
  reducedMotion: boolean;
}) {
  const tutorial = state.mode === "tutorial";
  const holding = state.mode === "pressed" && state.holding;
  const animate = !reducedMotion;

  return (
    <div
      role="status"
      className="pointer-events-none absolute top-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-white/15 bg-black/75 px-4 py-2.5 text-sm text-brand-text shadow-lg"
    >
      <span
        aria-hidden
        className={cn(
          "rounded-md border border-white/40 bg-white/10 px-2 py-0.5 font-mono text-xs font-semibold shadow-[0_3px_0_rgb(255_255_255/0.25)]",
          holding &&
            "translate-y-[2px] border-brand-cyan text-brand-cyan shadow-[0_1px_0_rgb(255_255_255/0.25)]",
        )}
        style={
          tutorial && animate && holdable
            ? {
                animation: `gc-esc-press ${TUTORIAL_CYCLE_MS}ms ease-in-out infinite`,
              }
            : undefined
        }
      >
        Esc
      </span>
      <span className="flex flex-col gap-1.5">
        <span>
          {tutorial ? (
            <>
              Чтобы выйти — <strong>{holdable ? "зажми" : "нажми"} Esc</strong>
            </>
          ) : (
            <>
              <strong>Зажми Esc</strong>, чтобы выйти из полного экрана
            </>
          )}
        </span>
        {holdable && (
          <span
            aria-hidden
            className="h-1 w-full overflow-hidden rounded-full bg-white/15"
          >
            <span
              // Новое нажатие — новый элемент: анимация шкалы начинается с нуля.
              key={state.mode === "pressed" ? state.press : "tutorial"}
              data-testid="esc-progress"
              className="block h-full w-0 rounded-full bg-brand-cyan"
              style={progressStyle(tutorial, holding, animate)}
            />
          </span>
        )}
      </span>
    </div>
  );
}
