// Содержимое меню сессии (спека §2.3): шапка с игрой и игровым временем, «Качество» (Авто / битрейт / разрешение), «Отладка»,
// «Клавиатура» (печатать на своей раскладке), подсказка про захват мыши (§2.5) и «Закончить игру». Правки применяются сразу через `onChange`; ползунок — по отпусканию;
// разрешение только сохраняется — применится со следующего запуска (§4.1).
import {
  type DebugMode,
  maxBitrateMbps,
  minBitrateMbps,
  type StreamResolution,
  type StreamSettings,
} from "@cg/rpc";
import { LogOut } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatClock } from "@/lib/formatTime";

const resolutions: ReadonlyArray<StreamResolution> = ["720p", "1080p", "1440p"];

const debugModes: ReadonlyArray<{ value: DebugMode; label: string }> = [
  { value: "off", label: "Выкл" },
  { value: "short", label: "Коротко" },
  { value: "detailed", label: "Подробно" },
];

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
}: {
  gameName: string;
  played: PlayedClock;
  settings: StreamSettings;
  onChange: (patch: Partial<StreamSettings>) => void;
  /** «Закончить игру» — дальше подтверждение (его показывает вызывающий). */
  onEndGame: () => void;
}) {
  const ids = useId();
  // Значение под пальцем, пока ползунок тянут; отпустили — `null`, на экране снова `settings`.
  const [dragMbps, setDragMbps] = useState<number | null>(null);
  const manual = settings.quality === "manual";
  const debugOptions = debugModes.map((mode) => mode.value);

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
      <section className="grid gap-3" aria-labelledby={`${ids}-quality`}>
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
                  {dragMbps ?? settings.bitrateMbps} Мбит/с
                </span>
              </div>
              <Slider
                thumbLabel="Битрейт"
                min={minBitrateMbps}
                max={maxBitrateMbps}
                step={1}
                value={[dragMbps ?? settings.bitrateMbps]}
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
                  if (resolution !== undefined) onChange({ resolution });
                }}
              >
                {resolutions.map((resolution) => (
                  <ToggleGroupItem key={resolution} value={resolution}>
                    {resolution}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className={note}>со следующего запуска</p>
            </div>
          </>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby={`${ids}-debug`}>
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
      <section className="grid gap-2" aria-labelledby={`${ids}-keyboard`}>
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
      </section>

      {/* Захват мыши (спека §2.5): в окне — только сочетанием Selkies, в полном экране — кликом. */}
      <section className="grid gap-2" aria-labelledby={`${ids}-mouse`}>
        <h3 id={`${ids}-mouse`} className={sectionTitle}>
          Мышь
        </h3>
        <p className={note}>
          Камера в игре не крутится? <kbd className={key}>Ctrl+Shift+клик</kbd>{" "}
          по игре захватит мышь, <kbd className={key}>Esc</kbd> отпустит. В
          полном экране хватит клика, выйти — удержать{" "}
          <kbd className={key}>Esc</kbd>.
        </p>
      </section>

      <Button variant="secondary" className="w-full" onClick={onEndGame}>
        <LogOut />
        Закончить игру
      </Button>
    </div>
  );
}
