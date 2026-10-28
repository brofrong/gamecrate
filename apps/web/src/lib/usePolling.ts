// Опрос атома-запроса раз в `ms`, пока вкладка браузера видима (админка: воркеры и сессии
// раз в 5 с). Скрытая вкладка не опрашивает; вернулись на неё — перезапрос сразу.
import { useAtomRefresh } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { useEffect } from "react";

export function usePolling<A>(atom: Atom.Atom<A>, ms = 5000): void {
  const refresh = useAtomRefresh(atom);

  useEffect(() => {
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
  }, [refresh, ms]);
}
