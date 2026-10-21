// Расписание демо «Как это работает» (чистые данные): три фазы по кругу, внутри каждой —
// реплики (cues) с отметками времени. Компонент ставит таймеры по этому расписанию.

export type DemoPhase = 0 | 1 | 2;

export const PHASE_DURATION_MS: Readonly<Record<DemoPhase, number>> = {
  0: 4200,
  1: 4600,
  2: 5000,
};

export type DemoCue =
  | "linked"
  | "cursor-tile"
  | "tile-hot"
  | "cursor-play"
  | "click"
  | "tile-cool"
  | "boot-gpu"
  | "boot-stream"
  | "playing";

export const PHASE_CUES: Readonly<
  Record<DemoPhase, ReadonlyArray<{ at: number; cue: DemoCue }>>
> = {
  0: [{ at: 2600, cue: "linked" }],
  1: [
    { at: 300, cue: "cursor-tile" },
    { at: 1300, cue: "tile-hot" },
    { at: 1900, cue: "cursor-play" },
    { at: 2800, cue: "click" },
    { at: 3100, cue: "tile-cool" },
  ],
  2: [
    { at: 900, cue: "boot-gpu" },
    { at: 1500, cue: "boot-stream" },
    { at: 2000, cue: "playing" },
  ],
};

/** Финальный кадр фазы — для reduced motion и статичного показа. */
export const FINAL_CUE: Readonly<Record<DemoPhase, DemoCue>> = {
  0: "linked",
  1: "tile-hot",
  2: "playing",
};

export const nextPhase = (p: DemoPhase): DemoPhase =>
  p === 2 ? 0 : ((p + 1) as DemoPhase);
