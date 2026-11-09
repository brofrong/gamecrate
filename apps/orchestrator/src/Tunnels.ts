// Tunnels: каналы тоннеля стрима (спека 2026-11-09 §4). Relay (`relay.ts`)
// просит канал до Selkies сессии — `open` шлёт агенту её сервера команду
// `OpenTunnel` с новым id тоннеля и ждёт, пока агент откроет WebSocket
// `GET /agent/tunnel/<id>` (маршрут `TunnelRoute`) со своим токеном. Один
// канал — одно соединение api с Selkies (один HTTP-запрос или один
// WebSocket); протокол канала — `@cg/rpc` `tunnel.ts`.
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Schema,
  type Scope,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { AgentHub } from "./AgentHub";
import { bearerToken, WorkerAuth } from "./WorkerAuth";

/** Сколько ждём, пока агент откроет канал после `OpenTunnel`. */
export const TUNNEL_OPEN_TIMEOUT = "10 seconds";

/**
 * Больше открытых каналов (ожидающих и уже работающих) на один сервер не
 * даём: агент с застрявшими каналами не съест память главного. Плеер Selkies
 * держит один WebSocket и грузит десяток файлов — запас большой.
 */
export const MAX_TUNNELS_PER_WORKER = 64;

/**
 * Канал не открылся:
 * - `NotConnected` — агента сервера нет (команду некуда отправить);
 * - `Limit` — у сервера уже `MAX_TUNNELS_PER_WORKER` каналов;
 * - `Timeout` — агент не открыл канал за `TUNNEL_OPEN_TIMEOUT`;
 * - `Closed` — связь с агентом оборвалась, пока ждали, или канал закрылся
 *   сразу после открытия.
 */
export class TunnelError extends Schema.TaggedError<TunnelError>()(
  "TunnelError",
  {
    reason: Schema.Literals(["NotConnected", "Limit", "Timeout", "Closed"]),
  },
) {}

export interface TunnelsShape {
  /**
   * Канал до Selkies сессии `sessionId` на сервере `workerId`: новый id
   * тоннеля (uuid), `OpenTunnel` агенту, ожидание его WebSocket не дольше
   * `TUNNEL_OPEN_TIMEOUT`. Канал живёт в scope вызывающего: закрытие scope
   * закрывает WebSocket агента (код 1000 — scope закрыт успешно, 1001 —
   * прерыванием, 1011 — сбоем). `reader` канала уже взят — его можно
   * запрашивать сколько угодно раз.
   */
  readonly open: (
    workerId: string,
    sessionId: string,
  ) => Effect.Effect<Socket.Socket, TunnelError, Scope.Scope>;
  /** Для маршрута: ожидающий тоннель по id (`undefined` — неизвестный или истёкший). */
  readonly lookup: (tunnelId: string) => Pending | undefined;
  /** Для маршрута: снять ожидающий тоннель; `false` — его уже нет (истёк). */
  readonly take: (tunnelId: string, entry: Pending) => boolean;
}

/** Тоннель, чей канал ещё не пришёл. */
export interface Pending {
  readonly workerId: string;
  readonly sessionId: string;
  readonly channel: Deferred.Deferred<Socket.Socket, TunnelError>;
}

/** Закрыть WebSocket, который никто не будет читать (код 1000). */
const discard = (socket: Socket.Socket) =>
  Effect.scoped(socket.reader).pipe(Effect.ignore);

const make = Effect.gen(function* () {
  const hub = yield* AgentHub;
  /** Ожидающие по id тоннеля: снимаются, как только канал пришёл, истёк или не нужен. */
  const pending = new Map<string, Pending>();
  /** Открытые каналы (ожидающие + работающие) по серверу. */
  const openCount = new Map<string, number>();

  const reserve = (workerId: string) =>
    Effect.sync(() => {
      const count = openCount.get(workerId) ?? 0;
      if (count >= MAX_TUNNELS_PER_WORKER) return false;
      openCount.set(workerId, count + 1);
      return true;
    });

  const release = (workerId: string) =>
    Effect.sync(() => {
      const count = (openCount.get(workerId) ?? 1) - 1;
      if (count <= 0) openCount.delete(workerId);
      else openCount.set(workerId, count);
    });

  // Связь с агентом оборвалась — его ожидающие каналы уже не придут: relay
  // отвечает сразу, а не через `TUNNEL_OPEN_TIMEOUT`.
  const events = yield* hub.subscribe;
  yield* PubSub.take(events).pipe(
    Effect.flatMap((event) =>
      event._tag !== "Disconnected"
        ? Effect.void
        : Effect.forEach(
            [...pending].filter(([, p]) => p.workerId === event.workerId),
            ([tunnelId, p]) => {
              pending.delete(tunnelId);
              return Deferred.fail(
                p.channel,
                new TunnelError({ reason: "Closed" }),
              );
            },
            { discard: true },
          ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const open: TunnelsShape["open"] = (workerId, sessionId) =>
    Effect.gen(function* () {
      const reserved = yield* Effect.acquireRelease(reserve(workerId), (ok) =>
        ok ? release(workerId) : Effect.void,
      );
      if (!reserved) return yield* new TunnelError({ reason: "Limit" });

      const tunnelId = crypto.randomUUID();
      const channel = Deferred.makeUnsafe<Socket.Socket, TunnelError>();
      pending.set(tunnelId, { workerId, sessionId, channel });
      const sent = yield* hub
        .send(workerId, { _tag: "OpenTunnel", tunnelId, sessionId })
        .pipe(
          Effect.onInterrupt(() => Effect.sync(() => pending.delete(tunnelId))),
        );
      if (!sent) {
        pending.delete(tunnelId);
        return yield* new TunnelError({ reason: "NotConnected" });
      }

      // Ожидание прерываемо, остальное — нет: канал, пришедший в последний
      // момент (маршрут уже отдал его в `channel`), либо достаётся нам и
      // привязывается к scope, либо закрывается — висеть ничейным не остаётся.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const waited = yield* restore(
            Deferred.await(channel).pipe(
              Effect.timeoutOption(TUNNEL_OPEN_TIMEOUT),
            ),
          ).pipe(Effect.exit);
          pending.delete(tunnelId);
          const giveUp = (reason: TunnelError["reason"]) =>
            Deferred.fail(channel, new TunnelError({ reason }));

          if (Exit.isFailure(waited)) {
            // Прервали (relay больше не нужен канал) или связь оборвалась.
            if (!(yield* giveUp("Closed")))
              yield* Deferred.await(channel).pipe(
                Effect.flatMap(discard),
                Effect.ignore,
              );
            return yield* Effect.failCause(waited.cause);
          }
          if (Option.isNone(waited.value) && (yield* giveUp("Timeout")))
            return yield* new TunnelError({ reason: "Timeout" });

          const socket = yield* Deferred.await(channel);
          const reader = yield* socket.reader.pipe(
            Effect.mapError(() => new TunnelError({ reason: "Closed" })),
          );
          return Socket.make({
            reader: Effect.succeed(reader),
            writer: socket.writer,
          });
        }),
      );
    });

  /**
   * Канал агента для маршрута `/agent/tunnel/:tunnelId`: ожидающий тоннель
   * снимается (`take`) только после проверки токена, так что чужой или
   * битый токен не трогает ожидание — оно истечёт само.
   */
  const lookup = (tunnelId: string) => pending.get(tunnelId);
  const take = (tunnelId: string, entry: Pending) => {
    if (pending.get(tunnelId) !== entry) return false;
    pending.delete(tunnelId);
    return true;
  };

  return { open, lookup, take } satisfies TunnelsShape;
});

export class Tunnels extends Context.Service<Tunnels, TunnelsShape>()(
  "@cg/orchestrator/Tunnels",
) {
  static readonly layer: Layer.Layer<Tunnels, never, AgentHub> = Layer.effect(
    Tunnels,
    make,
  );
}

const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });
const unauthorized = () =>
  HttpServerResponse.text("Unauthorized", { status: 401 });

/**
 * `GET /agent/tunnel/:tunnelId` — WebSocket канала тоннеля от агента.
 * Порядок проверок: неизвестный или истёкший id тоннеля → 404; токен в
 * `Authorization: Bearer` не действует или принадлежит не тому серверу, у
 * которого ждут этот тоннель, → 401 (ожидание остаётся и истечёт само);
 * не WebSocket → 400. Иначе апгрейд, и канал уходит ожидающему `open`.
 */
export const TunnelRoute = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const auth = yield* WorkerAuth;
    const tunnels = yield* Tunnels;

    yield* router.add(
      "GET",
      "/agent/tunnel/:tunnelId",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const tunnelId = (yield* HttpRouter.params).tunnelId;
        const entry =
          tunnelId === undefined ? undefined : tunnels.lookup(tunnelId);
        if (tunnelId === undefined || entry === undefined) return notFound();

        const token = bearerToken(request.headers.authorization);
        const owner =
          token === undefined
            ? Option.none<string>()
            : yield* auth.workerOfToken(token);
        if (Option.getOrUndefined(owner) !== entry.workerId) {
          yield* Effect.logWarning(
            "Tunnel channel refused: token is not of the tunnel's worker",
            {
              tunnelId,
              workerId: entry.workerId,
              tokenWorkerId: Option.getOrNull(owner),
            },
          );
          return unauthorized();
        }
        if (request.headers.upgrade?.toLowerCase() !== "websocket")
          return HttpServerResponse.text("Expected WebSocket", { status: 400 });
        if (!tunnels.take(tunnelId, entry)) return notFound();

        const socket = yield* request.upgrade.pipe(Effect.option);
        if (Option.isNone(socket)) {
          yield* Deferred.fail(
            entry.channel,
            new TunnelError({ reason: "Closed" }),
          );
          return HttpServerResponse.empty({ status: 400 });
        }
        // Ожидающий `open` уже сдался (тайм-аут или прерван) — канал никому
        // не нужен.
        if (!(yield* Deferred.succeed(entry.channel, socket.value)))
          yield* discard(socket.value);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
