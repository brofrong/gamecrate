// Содержимое меню сессии (спека §2.3): шапка с игрой и игровым временем, «Качество» (Авто / битрейт / разрешение), «Отладка»,
// «Клавиатура» (печатать на своей раскладке), подсказка про захват мыши (§2.5) и «Закончить игру». Правки применяются сразу через `onChange`; ползунок — по отпусканию;
// разрешение только сохраняется — применится со следующего запуска (§4.1). Обход меню (правка
// владельца 2026-11-05): по разделу за шаг — подсвечен, остальные приглушены, под ним короткая фраза,
// «Пропустить» и «Дальше»; шаг ведёт `SessionControls`.
import {
  capResolution,
  type DebugMode,
  maxBitrateMbps as globalMaxBitrateMbps,
  minBitrateMbps,
  type StreamResolution,
  type StreamSettings,
} from "@cg/rpc";
import { Lock, LogOut } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatClock } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

const resolutions: ReadonlyArray<StreamResolution> = ["720p", "1080p", "1440p"];

/**
 * Потолок качества тарифа (дизайн §6/§8): разрешения выше `maxResolution` показаны
 * с замком («Доступно в тарифе выше»), ползунок битрейта не поднимается выше
 * `maxBitrateMbps`. Плана ещё нет — вызывающий (`Player`) подставляет верхнюю границу
 * без ограничения («Базовый» тариф по умолчанию: `1440p`, `maxBitrateMbps` глобальный).
 */
export type QualityLimits = {
  readonly maxResolution: StreamResolution;
  readonly maxBitrateMbps: number;
};

export const noQualityLimits: QualityLimits = {
  maxResolution: "1440p",
  maxBitrateMbps: globalMaxBitrateMbps,
};

const debugModes: ReadonlyArray<{ value: DebugMode; label: string }> = [
  { value: "off", label: "Выкл" },
  { value: "short", label: "Коротко" },
  { value: "detailed", label: "Подробно" },
];

type TourSection = "quality" | "keyboard" | "mouse" | "end";

/** Шаги обхода меню: какой раздел подсвечен и что про него сказать. «Отладку» не объясняем. */
export const menuTour: ReadonlyArray<{ section: TourSection; text: string }> = [
  {
    section: "quality",
    text: "«Авто» подстраивается под сеть. Выключи, чтобы самому задать битрейт и разрешение.",
  },
  {
    section: "keyboard",
    text: "Пишешь в чат по-русски — включи. Для игры лучше выключить.",
  },
  {
    section: "mouse",
    text: "Камера не крутится — кликни по игре в полном экране или Ctrl+Shift+клик в окне.",
  },
  { section: "end", text: "Игра закроется, сохранения останутся." },
];

/** Плашка шага обхода под подсвеченным разделом. «Дальше» берёт фокус — без мыши тоже пройти. */
function TourCallout({
  step,
  onStep,
}: {
  step: number;
  onStep: (next: number | null) => void;
}) {
  const last = step === menuTour.length - 1;
  return (
    <div
      data-testid="menu-tour"
      aria-live="polite"
      className="grid gap-2 rounded-md border border-brand-cyan/40 bg-brand-cyan/10 p-2.5 text-xs text-brand-text"
    >
      <p>{menuTour[step]?.text}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground tabular-nums">
          {step + 1} из {menuTour.length}
        </span>
        <div className="flex items-center gap-1">
          {!last && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => onStep(null)}
            >
              Пропустить
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 px-3"
            // biome-ignore lint/a11y/noAutofocus: шаг сменился — фокус на следующей кнопке обхода.
            autoFocus
            onClick={() => onStep(last ? null : step + 1)}
          >
            {last ? "Понятно" : "Дальше"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Значение `ToggleGroup` как один из `options`; пустой выбор (снятие нажатого) — `undefined`. */
const pick = <T extends string>(
  options: ReadonlyArray<T>,
  value: string,
): T | undefined => options.find((option) => option === value);

/**
 * Игровое время сессии для шапки меню: `seconds` с сервера (`SessionView.playedSeconds`),
 * пришедшее в момент `at` (`Date.now()`); `running` — время идёт, между обновлениями
 * досчитываем сами.
 */
export type PlayedClock = { seconds: number; at: number; running: boolean };

const CLOCK_TICK_MS = 1_000;

function PlayedTime({ played }: { played: PlayedClock }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!played.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [played.running]);
  const extra = played.running
    ? Math.max(0, Math.floor((now - played.at) / 1000))
    : 0;
  return (
    <span
      className="shrink-0 font-mono text-muted-foreground tabular-nums"
      title="Игровое время"
    >
      {formatClock(played.seconds + extra)}
    </span>
  );
}

const sectionTitle =
  "text-xs font-medium tracking-wide text-muted-foreground uppercase";
const note = "text-xs text-muted-foreground";
const key =
  "rounded border border-border px-1 font-mono text-[11px] text-foreground";

export function SessionMenu({
  gameName,
  played,
  settings,
  onChange,
  onEndGame,
  limits = noQualityLimits,
  tourStep = null,
  onTourStep = () => {},
}: {
  gameName: string;
  played: PlayedClock;
  settings: StreamSettings;
  onChange: (patch: Partial<StreamSettings>) => void;
  /** «Закончить игру» — дальше подтверждение (его показывает вызывающий). */
  onEndGame: () => void;
  /** Потолок качества тарифа; план не загрузился — без ограничения (`noQualityLimits`). */
  limits?: QualityLimits;
  /** Шаг обхода (индекс в `menuTour`) или `null` — обхода нет. */
  tourStep?: number | null;
  /** Следующий шаг; `null` — обход закончен («Пропустить», «Понятно»). */
  onTourStep?: (next: number | null) => void;
}) {
  const ids = useId();
  // Значение под пальцем, пока ползунок тянут; отпустили — `null`, на экране снова `settings`.
  const [dragMbps, setDragMbps] = useState<number | null>(null);
  const manual = settings.quality === "manual";
  // Слайдер не выше потолка тарифа (дизайн §6); разрешения выше потолка — с замком.
  const sliderMaxMbps = Math.min(globalMaxBitrateMbps, limits.maxBitrateMbps);
  const lockedResolution = (resolution: StreamResolution) =>
    capResolution(resolution, limits.maxResolution) !== resolution;
  const anyLocked = resolutions.some(lockedResolution);
  const debugOptions = debugModes.map((mode) => mode.value);
  const touring =
    tourStep === null ? null : (menuTour[tourStep]?.section ?? null);
  // Раздел в обходе: текущий — с кольцом и плашкой шага, остальные приглушены.
  const spot = (section: TourSection | "debug") =>
    touring === null
      ? undefined
      : touring === section
        ? "relative"
        : "opacity-40 transition-opacity";
  const tourRing = (section: TourSection) =>
    touring === section && (
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-2 rounded-lg ring-2 ring-brand-cyan"
      />
    );
  const callout = (section: TourSection) =>
    touring === section &&
    tourStep !== null && (
      <TourCallout key={tourStep} step={tourStep} onStep={onTourStep} />
    );

  return (
    // `grid-cols-1` — колонка шириной панели (`minmax(0, 1fr)`): у неявной колонки ширина не
    // меньше самого длинного текста, и длинное название игры распирало всё меню.
    <div className="grid grid-cols-1 gap-5 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium" title={gameName}>
          {gameName}
        </span>
        <PlayedTime played={played} />
      </div>
      <section
        className={cn("grid gap-3", spot("quality"))}
        aria-labelledby={`${ids}-quality`}
      >
        {tourRing("quality")}
        <h3 id={`${ids}-quality`} className={sectionTitle}>
          Качество
        </h3>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`${ids}-auto`}>Авто — под вашу сеть</label>
          <Switch
            id={`${ids}-auto`}
            checked={!manual}
            onCheckedChange={(checked) =>
              onChange({ quality: checked ? "auto" : "manual" })
            }
          />
        </div>
        {manual && (
          <>
            <div className="grid gap-2">
              <div className="flex items-baseline justify-between">
                <span>Битрейт</span>
                <span className="font-mono tabular-nums">
                  {Math.min(dragMbps ?? settings.bitrateMbps, sliderMaxMbps)}{" "}
                  Мбит/с
                </span>
              </div>
              <Slider
                thumbLabel="Битрейт"
                min={minBitrateMbps}
                max={sliderMaxMbps}
                step={1}
                value={[Math.min(dragMbps ?? settings.bitrateMbps, sliderMaxMbps)]}
                onValueChange={([value]) => {
                  if (value !== undefined) setDragMbps(value);
                }}
                onValueCommit={([value]) => {
                  setDragMbps(null);
                  if (value !== undefined) onChange({ bitrateMbps: value });
                }}
              />
              <p className={note}>максимум; при плохой сети будет ниже</p>
            </div>
            <div className="grid gap-2">
              <span id={`${ids}-resolution`}>Разрешение</span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="w-full"
                aria-labelledby={`${ids}-resolution`}
                value={settings.resolution}
                onValueChange={(value) => {
                  const resolution = pick(resolutions, value);
                  if (resolution !== undefined && !lockedResolution(resolution))
                    onChange({ resolution });
                }}
              >
                {resolutions.map((resolution) => {
                  const locked = lockedResolution(resolution);
                  return (
                    <ToggleGroupItem
                      key={resolution}
                      value={resolution}
                      disabled={locked}
                      aria-disabled={locked}
                    >
                      {locked && <Lock className="size-3" />}
                      {resolution}
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
              <p className={note}>со следующего запуска</p>
              {anyLocked && <p className={note}>Доступно в тарифе выше</p>}
            </div>
          </>
        )}
        {callout("quality")}
      </section>

      <section
        className={cn("grid gap-3", spot("debug"))}
        aria-labelledby={`${ids}-debug`}
      >
        <h3 id={`${ids}-debug`} className={sectionTitle}>
          Отладка
        </h3>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="w-full"
          aria-labelledby={`${ids}-debug`}
          value={settings.debug}
          onValueChange={(value) => {
            const debug = pick(debugOptions, value);
            if (debug !== undefined) onChange({ debug });
          }}
        >
          {debugModes.map((mode) => (
            <ToggleGroupItem key={mode.value} value={mode.value}>
              {mode.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </section>

      {/* Раскладка: по умолчанию клавиши уходят по месту (`physicalKeys.ts`), чтобы игры понимали
          WASD на русской раскладке; включённый переключатель — символы своей раскладки. */}
      <section
        className={cn("grid gap-2", spot("keyboard"))}
        aria-labelledby={`${ids}-keyboard`}
      >
        {tourRing("keyboard")}
        <h3 id={`${ids}-keyboard`} className={sectionTitle}>
          Клавиатура
        </h3>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`${ids}-layout`}>Печатать на своей раскладке</label>
          <Switch
            id={`${ids}-layout`}
            checked={settings.localLayout}
            onCheckedChange={(localLayout) => onChange({ localLayout })}
          />
        </div>
        <p className={note}>
          Для чатов на русском. Выключено — клавиши работают как на английской
          раскладке, и игры понимают их на любой.
        </p>
        {callout("keyboard")}
      </section>

      {/* Захват мыши (спека §2.5): в окне — только сочетанием Selkies, в полном экране — кликом. */}
      <section
        className={cn("grid gap-2", spot("mouse"))}
        aria-labelledby={`${ids}-mouse`}
      >
        {tourRing("mouse")}
        <h3 id={`${ids}-mouse`} className={sectionTitle}>
          Мышь
        </h3>
        <p className={note}>
          Камера в игре не крутится? <kbd className={key}>Ctrl+Shift+клик</kbd>{" "}
          по игре захватит мышь, <kbd className={key}>Esc</kbd> отпустит. В
          полном экране хватит клика, выйти — удержать{" "}
          <kbd className={key}>Esc</kbd>.
        </p>
        {callout("mouse")}
      </section>

      <div className={cn("grid gap-3", spot("end"))}>
        {tourRing("end")}
        <Button variant="secondary" className="w-full" onClick={onEndGame}>
          <LogOut />
          Закончить игру
        </Button>
        {callout("end")}
      </div>
    </div>
  );
}
