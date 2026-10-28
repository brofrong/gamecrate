// Настройки стрима (спека §4): локальное состояние меню, debounced-сохранение в аккаунт.
// `useStreamSettingsState` — чистая логика (тестируется без атомов/сети); `useStreamSettings` —
// её обёртка над RPC-атомами `streamSettings.*`.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { defaultStreamSettings, type StreamSettings } from "@cg/rpc";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  saveStreamSettingsArgs,
  saveStreamSettingsAtom,
  streamSettingsAtom,
} from "@/rpc";

/** Сколько ждать после последней правки, прежде чем отправить сохранение. */
export const SAVE_DEBOUNCE_MS = 500;

export type StreamSettingsControl = {
  /** Текущие настройки: умолчания до загрузки, дальше — загруженные с учётом правок. */
  readonly settings: StreamSettings;
  /** Загруженное с сервера значение уже применено (раз; дальше его смена не перетирает правки). */
  readonly loaded: boolean;
  /** Применяет правку сразу (локально) и ставит debounced-сохранение. */
  readonly update: (patch: Partial<StreamSettings>) => void;
};

/**
 * `loaded` — значение из `streamSettings.get` (ещё не пришло — `undefined`); принимается
 * в состояние ровно один раз (дальнейшая реактивность запроса не должна перетирать то, что
 * игрок уже успел поменять в меню до её прихода — правки накапливаются отдельно и
 * подмешиваются поверх). `save` — промис; отказ не бросает исключение и не откатывает
 * настройку (она уже применена к стриму) — только предупреждение в консоли без значений.
 */
export function useStreamSettingsState(
  loaded: StreamSettings | undefined,
  save: (settings: StreamSettings) => Promise<unknown>,
): StreamSettingsControl {
  const [settings, setSettings] = useState<StreamSettings>(
    defaultStreamSettings,
  );
  const [isLoaded, setIsLoaded] = useState(false);
  const adoptedRef = useRef(false);
  const editsRef = useRef<Partial<StreamSettings>>({});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Загруженное значение принимается один раз, с учётом правок, сделанных до его прихода.
  useEffect(() => {
    if (loaded === undefined || adoptedRef.current) return;
    adoptedRef.current = true;
    setIsLoaded(true);
    setSettings({ ...loaded, ...editsRef.current });
  }, [loaded]);

  const flush = useCallback((next: StreamSettings) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    saveRef.current(next).catch(() => {
      console.warn("Stream settings not saved");
    });
  }, []);

  const scheduleSave = useCallback(
    (next: StreamSettings) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flush(next), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const update = useCallback(
    (patch: Partial<StreamSettings>) => {
      editsRef.current = { ...editsRef.current, ...patch };
      setSettings((current) => {
        const next = { ...current, ...patch };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  // Несохранённая правка не теряется при уходе со страницы — сохраняем сразу без ожидания.
  useEffect(
    () => () => {
      if (timerRef.current !== null) flush(settingsRef.current);
    },
    [flush],
  );

  return { settings, loaded: isLoaded, update };
}

/** Обёртка `useStreamSettingsState` над атомами `streamSettings.*`: ошибка загрузки — умолчания. */
export function useStreamSettings(): StreamSettingsControl {
  const result = useAtomValue(streamSettingsAtom);
  const save = useAtomSet(saveStreamSettingsAtom, { mode: "promise" });
  const loaded = Option.getOrUndefined(AsyncResult.value(result));
  return useStreamSettingsState(loaded, (settings) =>
    save(saveStreamSettingsArgs(settings)),
  );
}
