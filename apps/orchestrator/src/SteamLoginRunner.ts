// Вход в Steam по QR (`steam-session`): строки `pending`, заведённые API в
// `steam_logins`, раннер ведёт до итога — показывает QR через строку, по
// подтверждению в приложении Steam привязывает аккаунт к пользователю сайта и
// кладёт полученный вход в SteamLoginSeeds (его приложит следующий старт
// контейнера пользователя). API и оркестратор общаются только через БД.
//
// Токен и имя аккаунта живут только в памяти (`Redacted`); в БД, логи и тексты
// ошибок не попадают. Текст ошибок Steam игроку не показывается — только
// `steamLoginReasons.steamError` (конец без итога до сканирования QR) или
// `.notConfirmed` (конец без итога после сканирования — спека §4). Старые
// завершённые попытки чистит `pruneFinished` (спека §3, `PRUNE_INTERVAL`).
import type { Db } from "@cg/db";
import { type SteamLoginSeed, steamLoginReasons } from "@cg/rpc";
import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Queue,
  Redacted,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { EAuthTokenPlatformType, EResult, LoginSession } from "steam-session";
import { logFailure } from "./SessionRunner";
import * as SteamLoginRepo from "./SteamLoginRepo";
import { SteamLoginSeeds } from "./SteamLoginSeeds";

/** Период подхвата новых попыток и проверки отмены. */
export const STEAM_LOGIN_INTERVAL = "1 second";

/** Не больше стольких попыток одновременно на процесс. */
export const MAX_ACTIVE = 20;

/** Сколько попытка ждёт сканирования и подтверждения (спека: 5 мин). */
export const QR_LOGIN_TIMEOUT = Duration.minutes(5);

/**
 * Сбой Steam (`startWithQR` или опрос). `detail` — только для логов
 * оркестратора: имя EResult или код сетевой ошибки, без текста сообщения;
 * игроку уходит `steamLoginReasons.steamError`.
 */
export class SteamQrError extends Data.TaggedError("SteamQrError")<{
  readonly detail: string;
}> {}

/** События попытки входа по QR. */
export type QrEvent =
  /** Steam обновил код — прежний больше не сканируется. */
  | { readonly _tag: "QrUrl"; readonly url: string }
  /** Код отсканирован, ждём подтверждения в приложении. */
  | { readonly _tag: "Scanned" }
  | {
      readonly _tag: "Authenticated";
      readonly accountName: Redacted.Redacted<string>;
      readonly steamId: string;
      readonly refreshToken: Redacted.Redacted<string>;
    }
  /** `QR_LOGIN_TIMEOUT` истёк без подтверждения. */
  | { readonly _tag: "Timeout" };

/** Одна попытка входа у Steam (порт — тесты идут без сети). */
export interface QrLogin {
  /** Начать попытку: первая ссылка `https://s.team/q/…` для QR. */
  readonly start: Effect.Effect<{ qrUrl: string }, SteamQrError>;
  /** События после `start`; кончаются после итога (`Authenticated`/`Timeout`/ошибки). */
  readonly events: Stream.Stream<QrEvent, SteamQrError>;
  /** Прекратить опрос Steam. */
  readonly cancel: Effect.Effect<void>;
}

export interface SteamQrShape {
  /** Новая попытка; закрытие scope прекращает её опрос. */
  readonly begin: Effect.Effect<QrLogin, SteamQrError, Scope.Scope>;
}

/** Безопасная для логов суть ошибки `steam-session`: без текста сообщения. */
const errorDetail = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const { eresult, code } = error as { eresult?: unknown; code?: unknown };
    if (typeof eresult === "number")
      return `EResult.${EResult[eresult] ?? eresult}`;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "unknown";
};

const toSteamQrError = (error: unknown) =>
  new SteamQrError({ detail: errorDetail(error) });

/**
 * `steam-session` 1.9.4 (под Bun проверено): `LoginSession(SteamClient,
 * { machineFriendlyName: "GameCrate" })`. Новый URL кода приходит только в
 * отладочном событии `debug` `"poll response"` (`newChallengeUrl`) — как в
 * пробе. Отладочные данные содержат токен: их никогда не логировать.
 */
const begin: SteamQrShape["begin"] = Effect.gen(function* () {
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient, {
    machineFriendlyName: "GameCrate",
  });
  session.loginTimeout = Duration.toMillis(QR_LOGIN_TIMEOUT);
  const queue = yield* Queue.unbounded<QrEvent, SteamQrError | Cause.Done>();
  let lastUrl: string | undefined;

  session.on("debug", (label: unknown, data: unknown) => {
    if (label !== "poll response" || typeof data !== "object" || data === null)
      return;
    const url = (data as { newChallengeUrl?: unknown }).newChallengeUrl;
    if (typeof url !== "string" || url === "" || url === lastUrl) return;
    lastUrl = url;
    Queue.offerUnsafe(queue, { _tag: "QrUrl", url });
  });
  session.on("remoteInteraction", () => {
    Queue.offerUnsafe(queue, { _tag: "Scanned" });
  });
  session.on("authenticated", () => {
    // Исключение из обработчика ушло бы в цикл опроса `steam-session`
    // необработанным отказом — вместо этого проваливаем попытку.
    try {
      Queue.offerUnsafe(queue, {
        _tag: "Authenticated",
        accountName: Redacted.make(session.accountName),
        steamId: session.steamID.getSteamID64(),
        refreshToken: Redacted.make(session.refreshToken),
      });
      Queue.endUnsafe(queue);
    } catch {
      Queue.failCauseUnsafe(
        queue,
        Cause.fail(new SteamQrError({ detail: "badAuthenticatedSession" })),
      );
    }
  });
  session.on("timeout", () => {
    Queue.offerUnsafe(queue, { _tag: "Timeout" });
    Queue.endUnsafe(queue);
  });
  // Обработчик обязателен: без него EventEmitter бросает `error` наружу.
  session.on("error", (error: unknown) => {
    Queue.failCauseUnsafe(queue, Cause.fail(toSteamQrError(error)));
  });

  const cancel = Effect.sync(() => {
    session.cancelLoginAttempt();
  });
  // Пустой обработчик `error` остаётся и после уборки: запоздавшая ошибка
  // опроса не должна стать необработанной.
  yield* Effect.addFinalizer(() =>
    cancel.pipe(
      Effect.tap(() =>
        Effect.sync(() => session.removeAllListeners().on("error", () => {})),
      ),
    ),
  );

  return {
    start: Effect.tryPromise({
      try: () => session.startWithQR(),
      catch: toSteamQrError,
    }).pipe(
      Effect.flatMap(({ qrChallengeUrl }) =>
        qrChallengeUrl === undefined
          ? Effect.fail(new SteamQrError({ detail: "noQrChallengeUrl" }))
          : Effect.succeed({ qrUrl: qrChallengeUrl }),
      ),
    ),
    events: Stream.fromQueue(queue),
    cancel,
  } satisfies QrLogin;
});

export class SteamQr extends Context.Service<SteamQr, SteamQrShape>()(
  "@cg/orchestrator/SteamQr",
) {
  /** Настоящий Steam (`api.steampowered.com`). */
  static readonly live: Layer.Layer<SteamQr> = Layer.succeed(SteamQr, {
    begin,
  });
}

/** События, которые раннер разбирает по порядку (Steam + свои). */
type RunnerEvent =
  | QrEvent
  /** Строку отменил API. */
  | { readonly _tag: "Cancelled" }
  /** Поток Steam кончился без итога. */
  | { readonly _tag: "Ended" };

/** Раз в сколько чистятся старые завершённые попытки (спека §3). */
export const PRUNE_INTERVAL = Duration.hours(24);

/** Завершённые попытки старше этого возраста чистка удаляет (спека §3: 30 дней — решение исполнителя). */
export const PRUNE_RETENTION = Duration.days(30);

export interface SteamLoginRunnerOptions {
  /** Период подхвата и проверки отмены (по умолчанию `STEAM_LOGIN_INTERVAL`). */
  readonly interval?: Duration.Input;
  /** Период чистки старых попыток (по умолчанию `PRUNE_INTERVAL`; тесты — короче). */
  readonly pruneInterval?: Duration.Input;
}

const make = (options: SteamLoginRunnerOptions) =>
  Effect.gen(function* () {
    const interval = options.interval ?? STEAM_LOGIN_INTERVAL;
    const qr = yield* SteamQr;
    const seeds = yield* SteamLoginSeeds;
    const scope = yield* Scope.Scope;
    /** Попытки, которые ведёт этот процесс (до `setWaiting` они ещё `pending`). */
    const active = new Set<string>();

    const stale = yield* SteamLoginRepo.failStale();
    if (stale.length > 0)
      yield* Effect.logWarning("Interrupted Steam logins failed on start", {
        attempts: stale,
      });

    /** Чистка старых завершённых попыток: `before = now − PRUNE_RETENTION`. */
    const prune = Effect.gen(function* () {
      const before = new Date(
        Date.now() - Duration.toMillis(PRUNE_RETENTION),
      );
      const removed = yield* SteamLoginRepo.pruneFinished(before);
      if (removed > 0)
        yield* Effect.logInfo("Pruned old Steam logins", { removed });
    }).pipe(logFailure("Pruning old Steam logins failed"));

    yield* prune;
    yield* prune.pipe(
      Effect.repeat(Schedule.spaced(options.pruneInterval ?? PRUNE_INTERVAL)),
      Effect.forkIn(scope),
    );

    /** Подтверждённый вход: привязка, затем вход — в память для следующего старта. */
    const authenticated = (
      attempt: SteamLoginRepo.PendingAttempt,
      event: Extract<QrEvent, { _tag: "Authenticated" }>,
    ) =>
      Effect.gen(function* () {
        const result = yield* SteamLoginRepo.linkSteam(
          attempt.userId,
          event.steamId,
        );
        if (result !== "linked") {
          yield* SteamLoginRepo.finish(
            attempt.id,
            "failed",
            steamLoginReasons[result],
          );
          yield* Effect.logInfo("Steam login not linked", {
            steamId: event.steamId,
            result,
          });
          return;
        }
        const seed: SteamLoginSeed = {
          accountName: event.accountName,
          steamId: event.steamId,
          refreshToken: event.refreshToken,
        };
        yield* seeds.put(attempt.userId, seed);
        yield* SteamLoginRepo.finish(attempt.id, "done", null);
        yield* Effect.logInfo("Steam login linked", { steamId: event.steamId });
      });

    /**
     * Одна попытка: QR → `waiting`, затем события Steam вперемешку с проверкой
     * отмены раз в `interval` — по одному, так что отмена не обрывает привязку
     * на середине транзакции.
     *
     * `scanned` — отсканировал ли игрок код в этой попытке (событие
     * `Scanned`): если да, то конец без итога (`Ended`/`SteamQrError`) значит
     * «не подтвердил в приложении» (`notConfirmed`), а не «Steam не ответил»
     * (`steamError`) — спека §4.
     */
    const runAttempt = (attempt: SteamLoginRepo.PendingAttempt) => {
      let scanned = false;

      const endReason = () =>
        scanned ? steamLoginReasons.notConfirmed : steamLoginReasons.steamError;

      /** Обработать событие; `false` — попытка закончена. */
      const handle = (login: QrLogin, event: RunnerEvent) => {
        switch (event._tag) {
          case "QrUrl":
            return SteamLoginRepo.setQrUrl(attempt.id, event.url).pipe(
              Effect.as(true),
            );
          case "Scanned":
            return SteamLoginRepo.setScanned(attempt.id).pipe(
              Effect.tap(() => Effect.sync(() => (scanned = true))),
              Effect.as(true),
            );
          case "Authenticated":
            return authenticated(attempt, event).pipe(Effect.as(false));
          case "Timeout":
            return SteamLoginRepo.finish(attempt.id, "expired", null).pipe(
              Effect.as(false),
            );
          case "Ended":
            return SteamLoginRepo.finish(
              attempt.id,
              "failed",
              endReason(),
            ).pipe(
              Effect.tap(() =>
                Effect.logWarning("Steam login ended without a result"),
              ),
              Effect.as(false),
            );
          case "Cancelled":
            return login.cancel.pipe(
              Effect.tap(() => Effect.logInfo("Steam login cancelled")),
              Effect.as(false),
            );
        }
      };

      return Effect.gen(function* () {
        const login = yield* qr.begin;
        const { qrUrl } = yield* login.start;
        if (!(yield* SteamLoginRepo.setWaiting(attempt.id, qrUrl))) {
          yield* login.cancel;
          yield* Effect.logInfo("Steam login cancelled before QR");
          return;
        }
        const cancelled = Stream.tick(interval).pipe(
          Stream.drop(1),
          Stream.mapEffect(() => SteamLoginRepo.isCancelled(attempt.id)),
          Stream.filter((isCancelled) => isCancelled),
          Stream.map((): RunnerEvent => ({ _tag: "Cancelled" })),
        );
        const steam = Stream.concat(
          login.events as Stream.Stream<RunnerEvent, SteamQrError>,
          Stream.succeed<RunnerEvent>({ _tag: "Ended" }),
        );
        yield* Stream.merge(steam, cancelled).pipe(
          Stream.runForEachWhile((event) => handle(login, event)),
        );
      }).pipe(
        Effect.scoped,
        Effect.catchTag("SteamQrError", (error) =>
          SteamLoginRepo.finish(attempt.id, "failed", endReason()).pipe(
            Effect.tap(() =>
              Effect.logWarning("Steam login failed", { detail: error.detail }),
            ),
          ),
        ),
        // Прочие сбои (БД): попытку всё равно закрываем, чтобы сайт не ждал.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logError(
                "Steam login attempt crashed",
                Cause.pretty(cause),
              ).pipe(
                Effect.andThen(
                  SteamLoginRepo.finish(attempt.id, "failed", endReason()),
                ),
              ),
        ),
        logFailure("Closing a Steam login attempt failed"),
        Effect.ensuring(Effect.sync(() => active.delete(attempt.id))),
        Effect.annotateLogs({ attemptId: attempt.id, userId: attempt.userId }),
      );
    };

    /** Подхватить новые `pending`-попытки, не больше `MAX_ACTIVE` всего. */
    const pickUp = Effect.gen(function* () {
      const fresh = yield* SteamLoginRepo.pending(MAX_ACTIVE - active.size, [
        ...active,
      ]);
      for (const attempt of fresh) {
        active.add(attempt.id);
        yield* Effect.forkIn(runAttempt(attempt), scope);
      }
    }).pipe(logFailure("Picking up Steam logins failed"));

    yield* pickUp.pipe(
      Effect.repeat(Schedule.spaced(interval)),
      Effect.forkIn(scope),
    );
  });

export class SteamLoginRunner {
  /** Раннер с параметрами (тесты — короткий `interval`). */
  static readonly layerWith = (
    options: SteamLoginRunnerOptions,
  ): Layer.Layer<never, never, Db | SteamLoginSeeds | SteamQr> =>
    Layer.effectDiscard(make(options).pipe(Effect.orDie));

  /**
   * При старте — `failStale`, затем раз в `STEAM_LOGIN_INTERVAL` подхват
   * `pending`-попыток; на каждую — свой fiber в scope слоя.
   */
  static readonly layer = SteamLoginRunner.layerWith({});
}
