// Опрос атома-запроса раз в `ms`, пока вкладка браузера видима (админка: воркеры и сессии
// раз в 5 с). Скрытая вкладка не опрашивает; вернулись на неё — перезапрос сразу.
//
// `enabled: false` не ставит интервал вообще — для случая, когда тот же атом уже
// опрашивается другим вызовом `usePolling` в этом же компоненте (`Atom.family` отдаёт
// один и тот же объект атома на одинаковый аргумент, так что двух вызовов с ним не
// бывает без этого флага: правило хуков не даёт звать `usePolling` условно, а поставить
// на один атом два независимых интервала означало бы опрашивать его вдвое чаще).
import { useAtomRefresh } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { useEffect } from "react";

export function usePolling<A>(
  atom: Atom.Atom<A>,
  ms = 5000,
  enabled = true,
): void {
  const refresh = useAtomRefresh(atom);

  useEffect(() => {
    if (!enabled) return;
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => {
      if (visible()) refresh();
    }, ms);
    const onVisibility = () => {
      if (visible()) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, ms, enabled]);
}
