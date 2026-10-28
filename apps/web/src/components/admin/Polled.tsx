// Общий хелпер вкладок админки (`routes/admin.tsx`, `SessionsTab.tsx`): отрисовка
// опрашиваемого запроса (`usePolling`) без мигания при очередном неудачном опросе.
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type * as React from "react";

function LoadError({ text }: { text: string }) {
  return <p className="text-sm text-destructive">{text}</p>;
}

/**
 * Результат опрашиваемого запроса: первый ответ ещё не пришёл — `skeleton`; очередной
 * запрос упал — ошибка над прошлыми данными (если они были), а не вместо них.
 */
export function Polled<A, E>({
  result,
  error,
  skeleton,
  children,
}: {
  result: AsyncResult.AsyncResult<A, E>;
  error: string;
  skeleton: React.ReactNode;
  children: (value: A) => React.ReactNode;
}) {
  const value = AsyncResult.value(result);
  return (
    <>
      {AsyncResult.isFailure(result) && <LoadError text={error} />}
      {Option.isSome(value)
        ? children(value.value)
        : AsyncResult.isInitial(result) && skeleton}
    </>
  );
}
