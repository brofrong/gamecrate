// «Ждём слишком долго»: RPC-сокет переподключается бесконечно (retryTransientErrors) и
// не отдаёт ошибку, поэтому недоступный сервер узнаём по таймауту.
import { useCallback, useEffect, useState } from "react";

/** Сколько ждать ответа сервера, прежде чем показать «Не удалось связаться с сервером». */
export const SERVER_WAIT_MS = 10_000;

/**
 * `stalled` — `pending` держится дольше `ms`. `restart()` сбрасывает флаг и
 * запускает отсчёт заново (после «Повторить»). Когда `pending` снимается — флаг сброшен.
 */
export function useStalled(pending: boolean, ms: number = SERVER_WAIT_MS) {
  const [stalled, setStalled] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    setStalled(false);
    if (!pending) return;
    const timer = setTimeout(() => setStalled(true), ms);
    return () => clearTimeout(timer);
  }, [pending, ms, epoch]);

  const restart = useCallback(() => {
    setStalled(false);
    setEpoch((n) => n + 1);
  }, []);

  return [stalled && pending, restart] as const;
}
