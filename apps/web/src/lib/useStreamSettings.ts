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
  /** Применяет правку сразу (локально) и ставит debounced-сохранение (после загрузки). */
  readonly update: (patch: Partial<StreamSettings>) => void;
};

/**
 * `loaded` — значение из `streamSettings.get` (ещё не пришло — `undefined`); принимается
 * в состояние ровно один раз (дальнейшая реактивность запроса не должна перетирать то, что
 * игрок уже успел поменять в меню до её прихода — правки накапливаются отдельно и
 * подмешиваются поверх). До принятия правки только применяются к стриму и в аккаунт не
 * пишутся: сохранить можно лишь целую запись, а без загруженной она собралась бы из
 * умолчаний и молча перетёрла бы сохранённые настройки. При принятии, если правки были,
 * сохраняется один раз `{ ...loaded, ...правки }`; загрузка так и не пришла — правки
 * действуют до конца страницы, но не запоминаются (спека §4). `save` — промис; отказ не
 * бросает исключение и не откатывает настройку (она уже применена к стриму) — только
 * предупреждение в консоли без значений.
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
  // Последнее значение, считается вне апдейтеров `setSettings` (они должны быть чистыми:
  // StrictMode вызывает их дважды) — из него же берут сохранение таймер и сброс при уходе.
  const currentRef = useRef<StreamSettings>(defaultStreamSettings);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    saveRef.current(currentRef.current).catch(() => {
      console.warn("Stream settings not saved");
    });
  }, []);

  const scheduleSave = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Загруженное значение принимается один раз, с учётом правок, сделанных до его прихода;
  // были правки — сохраняем объединённое (до этого момента они не сохранялись).
  useEffect(() => {
    if (loaded === undefined || adoptedRef.current) return;
    adoptedRef.current = true;
    const merged = { ...loaded, ...editsRef.current };
    currentRef.current = merged;
    setIsLoaded(true);
    setSettings(merged);
    if (Object.keys(editsRef.current).length > 0) scheduleSave();
    editsRef.current = {};
  }, [loaded, scheduleSave]);

  const update = useCallback(
    (patch: Partial<StreamSettings>) => {
      const next = { ...currentRef.current, ...patch };
      currentRef.current = next;
      setSettings(next);
      if (adoptedRef.current) scheduleSave();
      else editsRef.current = { ...editsRef.current, ...patch };
    },
    [scheduleSave],
  );

  // Несохранённая правка не теряется при уходе со страницы — сохраняем сразу без ожидания.
  // До принятия загруженного таймера нет, сбрасывать нечего.
  useEffect(
    () => () => {
      if (timerRef.current !== null) flush();
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
