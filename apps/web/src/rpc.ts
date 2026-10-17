// Effect RPC-клиент по WebSocket на `/rpc` (NDJSON, как на сервере) и атомы для React.
import { AppRpcs } from "@cg/rpc";
import { BrowserSocket } from "@effect/platform-browser";
import { Cause, Layer, Option } from "effect";
import { AsyncResult, AtomRpc } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";

/** `ws(s)://<тот же хост>/rpc`: cookie сессии уходит с апгрейдом сам (same origin). */
const rpcUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/rpc`;
};

export class Api extends AtomRpc.Service<Api>()("@cg/web/Api", {
  group: AppRpcs,
  protocol: (_get) =>
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(BrowserSocket.layerWebSocket(rpcUrl())),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
}) {}

/** Ключ реактивности библиотеки: `library.refresh` после успеха перезапрашивает `library.list`. */
const libraryKeys = ["library"] as const;

/** Пользователь сессии; `Unauthorized` — не вошёл. */
export const meAtom = Api.query("auth.me", undefined);

/** Библиотека из БД (сервер сам синхронизирует её при первом обращении). */
export const libraryAtom = Api.query("library.list", undefined, {
  reactivityKeys: libraryKeys,
});

/** Синхронизировать библиотеку со Steam сейчас. */
export const refreshLibraryAtom = Api.mutation("library.refresh");
export const refreshLibraryArgs = {
  payload: undefined,
  reactivityKeys: libraryKeys,
} as const;

/** Проверка доступа к `admin.*` (только роль admin). */
export const adminPingAtom = Api.query("admin.ping", undefined);

/** `_tag` типизированной ошибки RPC (`Unauthorized`, `Forbidden`, `SteamUnavailable`, `RpcClientError`…). */
export const errorTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.getOrUndefined(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
  );

/** `_tag` ошибки неуспешного `AsyncResult`, иначе `undefined`. */
export const resultErrorTag = <A, E extends { readonly _tag: string }>(
  result: AsyncResult.AsyncResult<A, E>,
) => (AsyncResult.isFailure(result) ? errorTag(result.cause) : undefined);
