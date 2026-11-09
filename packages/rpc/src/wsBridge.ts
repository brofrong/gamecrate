// Мост WebSocket ↔ WebSocket: перекачка кадров одной стороны в другую и
// перенос кода закрытия. Общий для прокси стрима api (браузер ↔ Selkies или
// relay) и relay оркестратора (api ↔ канал тоннеля агента).
import { Effect } from "effect";
import * as Socket from "effect/socket/Socket";

/** Коды закрытия, которые можно отправить в кадре Close (RFC 6455 §7.4). */
export const sendableCloseCode = (code: number, browserApi: boolean) =>
  code === 1000 ||
  (code >= 3000 && code <= 4999) ||
  (!browserApi &&
    ((code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014)));

/**
 * Закрытие для второй стороны, когда первая закрылась или упала. `browserApi` —
 * сторона за WebSocket-клиентом (`globalThis.WebSocket`): его `close()`
 * принимает только 1000 и 3000–4999. Серверная сторона (апгрейд Bun)
 * отправляет и 1001–1003, 1007–1014.
 */
export const closeFor = (error: Socket.SocketError, browserApi: boolean) => {
  const reason = error.reason;
  if (reason._tag === "SocketCloseError") {
    if (sendableCloseCode(reason.code, browserApi))
      return new Socket.CloseEvent(reason.code, reason.closeReason);
    if (browserApi || reason.code === 1005) return new Socket.CloseEvent(1000);
    if (reason.code === 1006) return new Socket.CloseEvent(1001);
  }
  return new Socket.CloseEvent(browserApi ? 1000 : 1011);
};

/** Кадры из `from` в `to`, пока `from` не закроется; затем закрывает `to`. */
export const pipeFrames = (
  from: Socket.Reader,
  to: Socket.Writer,
  browserApi: boolean,
) =>
  Effect.forever(
    Effect.flatMap(from.pull, (chunks) => to.writeAll(chunks)),
  ).pipe(
    Effect.catch((error) => to.write(closeFor(error, browserApi))),
    Effect.ignore,
  );
