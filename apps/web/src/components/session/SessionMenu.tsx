// Содержимое меню сессии (спека §2.3): «Качество» (Авто / битрейт / разрешение), «Отладка» и
// «Закончить игру». Правки применяются сразу через `onChange`; ползунок — по отпусканию;
// разрешение только сохраняется — применится со следующего запуска (§4.1).
import {
  type DebugMode,
  maxBitrateMbps,
  minBitrateMbps,
  type StreamResolution,
  type StreamSettings,
} from "@cg/rpc";
import { LogOut } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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

const sectionTitle =
  "text-xs font-medium tracking-wide text-muted-foreground uppercase";
const note = "text-xs text-muted-foreground";

export function SessionMenu({
  settings,
  onChange,
  onEndGame,
}: {
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
    <div className="grid gap-5 text-sm">
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

      <Button variant="secondary" className="w-full" onClick={onEndGame}>
        <LogOut />
        Закончить игру
      </Button>
    </div>
  );
}
