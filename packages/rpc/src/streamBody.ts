// Тело HTTP-запроса к стриму (`/stream/<id>/…` api и relay оркестратора):
// оба буферизуют его целиком (fetch к relay; одно бинарное сообщение канала
// тоннеля), так что без предела любой вошедший игрок одним большим или
// бесконечным chunked-запросом съел бы память процесса (у оркестратора
// mem_limit 256m). Selkies по HTTP принимает только мелкие запросы —
// мегабайта с запасом.
import { Data, Effect, Stream } from "effect";
import type { HttpServerRequest } from "effect/http";

/** Предел тела HTTP-запроса к стриму: больше — 413 без запроса дальше. */
export const MAX_STREAM_BODY_BYTES = 1024 * 1024;

/** Тело запроса больше `MAX_STREAM_BODY_BYTES` (по Content-Length или по факту). */
export class StreamBodyTooLarge extends Data.TaggedError("StreamBodyTooLarge")<{
  readonly limit: number;
}> {}

/**
 * Тело запроса целиком, не больше `limit` байт. Content-Length больше
 * предела — отказ сразу, тело не читается; без него (chunked) или с ложным —
 * чтение обрывается на первом куске сверх предела.
 */
export const readStreamBody = (
  request: HttpServerRequest.HttpServerRequest,
  limit: number = MAX_STREAM_BODY_BYTES,
) =>
  Effect.gen(function* () {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit)
      return yield* new StreamBodyTooLarge({ limit });
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    let tooLarge = false;
    yield* Stream.runForEachWhile(request.stream, (chunk) =>
      Effect.sync(() => {
        total += chunk.byteLength;
        if (total > limit) {
          tooLarge = true;
          return false;
        }
        chunks.push(chunk);
        return true;
      }),
    );
    if (tooLarge) return yield* new StreamBodyTooLarge({ limit });
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  });
