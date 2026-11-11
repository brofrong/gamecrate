// Хук очереди в оболочке сайта (спека §5, бриф задачи 11), монтируется один раз в
// `__root.tsx` для вошедшего пользователя. Пока есть активная сессия
// (`activeSessionAtom`), раз в 5 с шлёт `session.heartbeat` с `queueOnly: true` — так
// игрок остаётся в очереди, даже листая другие страницы сайта (сервер учитывает этот
// heartbeat только пока сессия `queued`; в остальных состояниях — принятый no-op).
// Подписан на `sessionWatchAtom`: при переходе `queued → другое`, если вкладка
// скрыта, играет короткий сигнал (WebAudio, без файлов) и показывает уведомление
// браузера, если разрешение уже дано (кнопка на экране загрузки,
// `LoadingScreen.tsx` — спека просит спросить при входе в очередь, но Safari и
// другие браузеры разрешают запрос только по нажатию, отступление записано в
// задаче 11). Ничего не рендерит — чистый побочный эффект.
import type { SessionState, SessionView } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";
import { activeSessionAtom, heartbeatAtom, sessionWatchAtom } from "@/rpc";

/** Период heartbeat очереди (сервер учитывает его только пока сессия `queued`). */
const QUEUE_HEARTBEAT_MS = 5_000;

/** Текст уведомления браузера (спека §5, глобальные константы текстов задачи). */
export const queueReadyNotification = "Сервер готов — возвращайтесь в игру";

/** Короткий сигнал без файлов (спека §5): осциллятор ~0,3 с через WebAudio. */
export function playQueueChime(): void {
  try {
    const ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!ctor) return;
    const ctx = new ctor();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.2;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.3);
    oscillator.onended = () => void ctx.close();
  } catch {
    // Окружение без WebAudio (или он бросил) — тихо пропускаем, игру не ломаем.
  }
}

/** Уведомление браузера «Сервер готов…», только если разрешение уже дано. */
export function notifyQueueReady(): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    new Notification(queueReadyNotification);
  } catch {
    // `Notification` может бросать в некоторых окружениях — не мешаем игре.
  }
}

/**
 * `true` ровно на тот рендер, когда предыдущее состояние было `queued`, а текущее —
 * другое (однократный «импульс» на переходе; на следующем рендере с тем же
 * состоянием снова `false` — не залипает).
 */
export function useLeftQueue(state: SessionState | undefined): boolean {
  const prev = useRef<SessionState | undefined>(undefined);
  const left =
    prev.current === "queued" && state !== undefined && state !== "queued";
  useEffect(() => {
    prev.current = state;
  });
  return left;
}

/** Heartbeat `queueOnly` каждые 5 с, пока смонтирован компонент с этим `sessionId`. */
function useQueueHeartbeat(sessionId: string): void {
  const send = useAtomSet(heartbeatAtom, { mode: "promiseExit" });
  useEffect(() => {
    const beat = () =>
      void send({ payload: { sessionId, inputAgeMs: 0, queueOnly: true } });
    beat();
    const timer = setInterval(beat, QUEUE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [sessionId, send]);
}

function QueueWatcherActive({ sessionId }: { sessionId: string }) {
  useQueueHeartbeat(sessionId);
  const watch = useAtomValue(sessionWatchAtom(sessionId));
  const view = Option.getOrUndefined(AsyncResult.value(watch));
  const left = useLeftQueue(view?.state);

  useEffect(() => {
    if (!left) return;
    if (!document.hidden) return;
    playQueueChime();
    notifyQueueReady();
  }, [left]);

  return null;
}

/** Монтируется один раз в `__root.tsx`; без активной сессии ничего не делает. */
export function QueueWatcher() {
  const active = useAtomValue(activeSessionAtom);
  const session: SessionView | null = AsyncResult.isSuccess(active)
    ? active.value
    : null;
  if (session === null) return null;
  // `key` — чтобы смена сессии (новая игра сразу после прошлой) не унесла с собой
  // «предыдущее состояние» старой сессии в `useLeftQueue`.
  return <QueueWatcherActive key={session.id} sessionId={session.id} />;
}
