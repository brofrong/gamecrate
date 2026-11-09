// Протокол канала тоннеля стрима (спека 2026-11-09 §4): один WebSocket
// `/agent/tunnel/<id тоннеля>`, который агент открывает к оркестратору по
// команде `OpenTunnel`, — одно соединение api с Selkies сессии (один
// HTTP-запрос или один WebSocket). Общий для оркестратора (relay) и агента.
//
// Первое сообщение после открытия — текстовый JSON от оркестратора:
// - `TunnelOpenHttp` — HTTP-запрос. Если `hasBody`, следом одно бинарное
//   сообщение с телом (не больше `MAX_STREAM_BODY_BYTES`). Агент отвечает текстом `TunnelHttpResponse`, затем
//   бинарными кусками тела и закрывает канал кодом 1000. Сбой —
//   `TunnelFailure` и код 1011.
// - `TunnelOpenWs` — WebSocket. Агент отвечает `TunnelWsOpen` (протокол,
//   выбранный Selkies; пусто — без протокола) или `TunnelFailure`. После
//   `open` каждое сообщение канала — кадр Selkies 1:1 (текст остаётся
//   текстом, бинарное — бинарным), а закрытие канала повторяет код и
//   причину закрытия Selkies (и наоборот).
//
// Путь (`path`) — путь у Selkies с query (`/index.html?x=1`); адрес
// назначения агент берёт только из `sessionId` команды (`cg-session-<id>:8080`
// на своём сервере), в канале его нет — защита от SSRF.
import { Option, Schema } from "effect";

/**
 * Заголовок общего секрета relay (`RELAY_SECRET` api и оркестратора): api
 * ставит его в каждый запрос и открытие WebSocket к relay, relay без него
 * (или с другим значением) отвечает 403 до обращения к БД и агенту. Relay
 * слушается и в сети обратного прокси (`proxy`), а сам владельца сессии не
 * проверяет. Дальше relay заголовок не передаёт.
 */
export const RELAY_SECRET_HEADER = "x-cg-relay-secret";

/** Заголовки как пары: повторяющиеся (`set-cookie`) не склеиваются. */
const HeaderPairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

export const TunnelOpenHttp = Schema.Struct({
  kind: Schema.Literal("http"),
  method: Schema.String,
  path: Schema.String,
  headers: HeaderPairs,
  hasBody: Schema.Boolean,
});
export type TunnelOpenHttp = typeof TunnelOpenHttp.Type;

export const TunnelOpenWs = Schema.Struct({
  kind: Schema.Literal("ws"),
  path: Schema.String,
  headers: HeaderPairs,
  /** Подпротоколы из `Sec-WebSocket-Protocol` api (пусто — не просили). */
  protocols: Schema.Array(Schema.String),
});
export type TunnelOpenWs = typeof TunnelOpenWs.Type;

export const TunnelHttpResponse = Schema.Struct({
  kind: Schema.Literal("response"),
  status: Schema.Int,
  headers: HeaderPairs,
});
export type TunnelHttpResponse = typeof TunnelHttpResponse.Type;

export const TunnelWsOpen = Schema.Struct({
  kind: Schema.Literal("open"),
  protocol: Schema.String,
});
export type TunnelWsOpen = typeof TunnelWsOpen.Type;

/** Агент не смог: Selkies не ответил, не открыл WebSocket и т. п. */
export const TunnelFailure = Schema.Struct({
  kind: Schema.Literal("error"),
  message: Schema.String,
});
export type TunnelFailure = typeof TunnelFailure.Type;

/** Любое управляющее (текстовое) сообщение канала. */
export const TunnelControl = Schema.Union([
  TunnelOpenHttp,
  TunnelOpenWs,
  TunnelHttpResponse,
  TunnelWsOpen,
  TunnelFailure,
]);
export type TunnelControl = typeof TunnelControl.Type;

const TunnelControlJson = Schema.fromJsonString(TunnelControl);
const encodeJson = Schema.encodeSync(TunnelControlJson);
const decodeJson = Schema.decodeUnknownOption(TunnelControlJson);

/** Управляющее сообщение → текст кадра. */
export const encodeTunnelControl = (message: TunnelControl): string =>
  encodeJson(message);

/** Текст кадра → управляющее сообщение; не JSON или не по схеме — `None`. */
export const decodeTunnelControl = (
  text: string,
): Option.Option<TunnelControl> => decodeJson(text);
