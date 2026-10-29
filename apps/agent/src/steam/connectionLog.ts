// Журнал подключения клиента Steam (`connection_log.txt`, спека §5.4): по нему
// агент узнаёт, вошёл ли клиент. Общий для установщика (вход обязателен —
// иначе установка «Войдите в Steam») и сессии (только предупреждение в лог,
// если посеянный вход не принят).
import { Clock, Duration, Effect } from "effect";
import { STEAM_DIR } from "../Overlay";

/** Журнал подключения клиента Steam (спека §5.4): признак входа/невхода. */
export const CONNECTION_LOG = `${STEAM_DIR}/logs/connection_log.txt`;

/**
 * Строка принятого входа в `connection_log.txt` (проба на brofrong, спека
 * §5.4): `RecvMsgClientLogOnResponse() : [U:1:…] 'OK'` на одной строке
 * (`'OK'` — не `'Failure'`/другой код отказа).
 */
export const STEAM_LOGON_OK = /RecvMsgClientLogOnResponse\(\).*'OK'/;

/**
 * Строка попытки входа в `connection_log.txt` (проба на brofrong,
 * 2026-10-26): клиент зовёт `LogOn()` (нет подключения — «scheduling
 * connection») или уже на стадии `Logging on [U:…]`. До этой строки
 * `steamLoginTimeoutSeconds` не считается — клиент ещё готовит своё UI, а не
 * ждёт ответ сервера (см. `awaitSteamLogon`).
 */
export const STEAM_LOGON_ATTEMPT = /LogOn\(\) called|Logging on \[U:/;

/**
 * С первых строк журнала подключения (клиент пишет его, только закончив
 * bootstrap/самообновление) — сколько ждать, что клиент хотя бы попробует
 * войти (`STEAM_LOGON_ATTEMPT`), прежде чем считать его застрявшим в своём
 * окне входа. На части железа (проба на brofrong, 2026-10-26) UI Steam готов
 * звать `LogOn()` только спустя ~80 с после первых строк журнала — заметно
 * дольше, чем сам `steamLoginTimeoutSeconds` (который отсчитывается от этой
 * попытки, а не от первых строк, см. `awaitSteamLogon`).
 */
export const STEAM_CLIENT_START_TIMEOUT = Duration.minutes(5);

/**
 * Команда `exec`: журнал подключения после `offset` байт (журнал
 * дописывается, а не перезаписывается — старые строки шаблона клиента до
 * этого смещения не считаются).
 */
export const connectionLogTail = (offset: number) => [
  "tail",
  "-c",
  `+${offset + 1}`,
  CONNECTION_LOG,
];

/**
 * Итог ожидания входа: `ok` — вход принят; `noLog` — журнал так и не пошёл
 * (клиент не дошёл до подключения — это не отказ во входе); `notAccepted` —
 * клиент не попытался войти или сервер не ответил `'OK'` вовремя.
 */
export type SteamLogonOutcome = "ok" | "noLog" | "notAccepted";

/**
 * Ждёт признак входа Steam (спека §5.4, уточнено 2026-10-26 по пробе на
 * brofrong). `read` — журнал подключения после смещения на момент старта
 * контейнера. Три фазы:
 * 1. До первых строк журнала — клиент пишет его, только закончив свой
 *    bootstrap/самообновление и начав подключаться; ждём не дольше
 *    `logTimeout` от начала ожидания (иначе `noLog`).
 * 2. От первых строк до строки попытки входа (`STEAM_LOGON_ATTEMPT`) — не
 *    дольше `STEAM_CLIENT_START_TIMEOUT`: на части железа UI Steam готов
 *    звать `LogOn()` только спустя ~80 с после первых строк — дольше, чем
 *    сам `loginTimeout`, который тут ещё не должен тикать.
 * 3. От строки попытки — не дольше `loginTimeout`: это и есть ожидание
 *    ответа сервера на попытку входа.
 * Истечение фазы 2 или 3 — `notAccepted`. `'OK'`, замеченный в любой
 * момент, — `ok` сразу, независимо от фазы. Ошибки `read` — как есть.
 */
export const awaitSteamLogon = <E, R>(options: {
  readonly read: Effect.Effect<string, E, R>;
  readonly poll: Duration.Input;
  readonly logTimeout: Duration.Input;
  readonly loginTimeout: Duration.Input;
}): Effect.Effect<SteamLogonOutcome, E, R> =>
  Effect.gen(function* () {
    const { read, poll } = options;
    const startedAt = yield* Clock.currentTimeMillis;
    let stdout = yield* read;
    while (stdout === "") {
      const now = yield* Clock.currentTimeMillis;
      if (now - startedAt >= Duration.toMillis(options.logTimeout))
        return "noLog" as const;
      yield* Effect.sleep(poll);
      stdout = yield* read;
    }
    const bytesAt = yield* Clock.currentTimeMillis;
    if (STEAM_LOGON_OK.test(stdout)) return "ok" as const;
    while (!STEAM_LOGON_ATTEMPT.test(stdout)) {
      const now = yield* Clock.currentTimeMillis;
      if (now - bytesAt >= Duration.toMillis(STEAM_CLIENT_START_TIMEOUT))
        return "notAccepted" as const;
      yield* Effect.sleep(poll);
      stdout = yield* read;
      if (STEAM_LOGON_OK.test(stdout)) return "ok" as const;
    }
    return yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(poll);
        if (STEAM_LOGON_OK.test(yield* read)) return "ok" as const;
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.loginTimeout,
        orElse: () => Effect.succeed("notAccepted" as const),
      }),
    );
  });
