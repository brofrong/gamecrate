// Effect RPC-клиент по WebSocket на `/rpc` (NDJSON, как на сервере) и атомы для React.
import { AppRpcs } from "@cg/rpc";
import { BrowserSocket } from "@effect/platform-browser";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { AsyncResult, Atom, AtomRpc } from "effect/reactivity";
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

/** Какие способы входа включены на сервере — доступно без сессии. */
export const providersAtom = Api.query("auth.providers", undefined);

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

/** Ключ реактивности сессий: `session.start` перезапрашивает `session.active`. */
const sessionKeys = ["session"] as const;

/** Активная сессия пользователя (не `ended`/`failed`) или null. */
export const activeSessionAtom = Api.query("session.active", undefined, {
  reactivityKeys: sessionKeys,
});

/** Запустить игру (или получить уже активную сессию). */
export const startSessionAtom = Api.mutation("session.start");
export const startSessionArgs = (appId: number) =>
  ({ payload: { appId }, reactivityKeys: sessionKeys }) as const;

/**
 * Поток `session.watch`: последнее представление сессии. Пока поток идёт — `Success`
 * с `waiting`; после терминального состояния поток завершается — `Success` без `waiting`.
 * Обрыв сокета — `Failure` (с прошлым значением): переподписка — `useAtomRefresh`.
 * Атом не keepAlive: ушли со страницы — подписка отменяется.
 */
export const sessionWatchAtom = Atom.family((sessionId: string) =>
  Api.runtime.atom(
    Stream.unwrap(
      Api.use((client) =>
        Effect.succeed(client("session.watch", { sessionId })),
      ),
    ),
  ),
);

/** Heartbeat страницы сессии (`inputAgeMs` — мс с последнего ввода). */
export const heartbeatAtom = Api.mutation("session.heartbeat");

/** Попросить остановить сессию («Выйти из игры»). */
export const stopSessionAtom = Api.mutation("session.stop");

/** Завести новую попытку входа в Steam по QR (отменяет прежнюю активную). */
export const startSteamLoginAtom = Api.mutation("steamLogin.start");

/** Текущее состояние попытки входа в Steam по QR — опрашивается вручную, не атомом-запросом. */
export const steamLoginStatusAtom = Api.mutation("steamLogin.status");

/** Ключ реактивности настроек сессий в админке. */
const settingsKeys = ["settings"] as const;

export const sessionSettingsAtom = Api.query("admin.settings.get", undefined, {
  reactivityKeys: settingsKeys,
});
export const updateSessionSettingsAtom = Api.mutation("admin.settings.update");
export const updateSessionSettingsArgs = <A>(payload: A) =>
  ({ payload, reactivityKeys: settingsKeys }) as const;

/** `_tag` типизированной ошибки RPC (`Unauthorized`, `Forbidden`, `SteamUnavailable`, `RpcClientError`…). */
export const errorTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.getOrUndefined(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
  );

/** `_tag` ошибки неуспешного `AsyncResult`, иначе `undefined`. */
export const resultErrorTag = <A, E extends { readonly _tag: string }>(
  result: AsyncResult.AsyncResult<A, E>,
) => (AsyncResult.isFailure(result) ? errorTag(result.cause) : undefined);
