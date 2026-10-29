import { describe, expect, it } from "bun:test";
import { account, Db, type SteamLoginState, steamLogins, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { steamLoginReasons } from "@cg/rpc";
import { and, eq, inArray } from "drizzle-orm";
import {
  type Cause,
  Effect,
  Layer,
  Logger,
  Queue,
  Redacted,
  References,
  type Scope,
  Stream,
} from "effect";
import * as SteamLoginRepo from "../src/SteamLoginRepo";
import {
  type QrEvent,
  SteamLoginRunner,
  SteamQr,
  SteamQrError,
  type SteamQrShape,
} from "../src/SteamLoginRunner";
import { SteamLoginSeeds } from "../src/SteamLoginSeeds";
import { SteamLoginSeedsTest } from "./seedKey";

/** Одна попытка входа у фейкового Steam: события подаёт тест. */
interface FakeLogin {
  readonly events: Queue.Queue<QrEvent, SteamQrError | Cause.Done>;
  cancelled: boolean;
}

/** Фейковый Steam: каждая `begin` — новая запись в `logins`. */
const makeFakeQr = () => {
  const logins: Array<FakeLogin> = [];
  const state: { startError: SteamQrError | null } = { startError: null };
  const qr: SteamQrShape = {
    begin: Effect.gen(function* () {
      const events = yield* Queue.unbounded<
        QrEvent,
        SteamQrError | Cause.Done
      >();
      const login: FakeLogin = { events, cancelled: false };
      logins.push(login);
      const n = logins.length;
      return {
        start:
          state.startError === null
            ? Effect.succeed({ qrUrl: `https://s.team/q/1/${n}` })
            : Effect.fail(state.startError),
        events: Stream.fromQueue(events),
        cancel: Effect.sync(() => {
          login.cancelled = true;
        }),
      };
    }),
  };
  return { qr, logins, state };
};
type FakeQr = ReturnType<typeof makeFakeQr>;

type Env = Db | SteamLoginSeeds | Scope.Scope;

const run = <A, E>(body: (fake: FakeQr) => Effect.Effect<A, E, Env>) => {
  const fake = makeFakeQr();
  return Effect.runPromise(
    Effect.scoped(body(fake)).pipe(
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.provide(SteamLoginSeedsTest.pipe(Layer.provideMerge(DbTest))),
    ),
  );
};

/** Раннер с быстрым интервалом в scope теста; Steam — фейк. */
const startRunner = (fake: FakeQr) =>
  Layer.build(
    SteamLoginRunner.layerWith({ interval: "20 millis" }).pipe(
      Layer.provide(Layer.succeed(SteamQr, fake.qr)),
    ),
  );

/** Ждём условия (реальное время), не дольше ~3 с. */
const waitFor = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  what = "condition",
): Effect.Effect<A, E | string, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < 300; i++) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.fail(`timed out waiting for ${what}`);
  });

const STEAM_ID = "76561198000000001";
const OTHER_STEAM_ID = "76561198000000002";
const TOKEN = "eyJ-SECRET-REFRESH-TOKEN";
const ACCOUNT = "s3cr3t-account-name";

const authenticated = (steamId = STEAM_ID): QrEvent => ({
  _tag: "Authenticated",
  accountName: Redacted.make(ACCOUNT),
  steamId,
  refreshToken: Redacted.make(TOKEN),
});

const seedUser = (id: string, steamId: string | null = null) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.invalid`,
      emailVerified: true,
      steamId,
    });
  });

const insertAttempt = (
  id: string,
  userId: string,
  state: SteamLoginState = "pending",
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(steamLogins).values({
      id,
      userId,
      state,
      qrUrl: state === "pending" ? null : "https://s.team/q/1/old",
    });
  });

const attempt = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select()
      .from(steamLogins)
      .where(eq(steamLogins.id, id));
    if (row === undefined) return yield* Effect.die(`no attempt ${id}`);
    return row;
  });

const waitState = (id: string, state: string) =>
  waitFor(attempt(id), (row) => row.state === state, `${id} → ${state}`);

const steamAccounts = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "steam")));
  });

const userRow = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db.select().from(user).where(eq(user.id, id));
    if (row === undefined) return yield* Effect.die(`no user ${id}`);
    return row;
  });

const loginAt = (fake: FakeQr, index: number) =>
  waitFor(
    Effect.sync(() => fake.logins[index]),
    (login) => login !== undefined,
    `Steam login #${index}`,
  ).pipe(
    Effect.flatMap((login) =>
      login === undefined ? Effect.die("no login") : Effect.succeed(login),
    ),
  );

describe("SteamLoginRunner", () => {
  it("attempt goes waiting → scanned → done and links Steam", () =>
    run((fake) =>
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seedUser("u1");
        // Раннер стартует первым: `failStale` провалил бы уже заведённую строку.
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        const waiting = yield* waitState("a1", "waiting");
        expect(waiting.qrUrl).toBe("https://s.team/q/1/1");
        const login = yield* loginAt(fake, 0);

        yield* Queue.offer(login.events, {
          _tag: "QrUrl",
          url: "https://s.team/q/1/fresh",
        });
        yield* waitFor(
          attempt("a1"),
          (row) => row.qrUrl === "https://s.team/q/1/fresh",
          "fresh QR",
        );

        yield* Queue.offer(login.events, { _tag: "Scanned" });
        yield* waitState("a1", "scanned");

        yield* Queue.offer(login.events, authenticated());
        const done = yield* waitState("a1", "done");
        expect(done.error).toBeNull();

        expect((yield* userRow("u1")).steamId).toBe(STEAM_ID);
        const accounts = yield* steamAccounts("u1");
        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.accountId).toBe(STEAM_ID);
        // Токен в строку account не пишется — он только в памяти (seeds).
        expect(accounts[0]?.refreshToken).toBeNull();

        const seed = yield* seeds.get("u1");
        expect(seed?.steamId).toBe(STEAM_ID);
        expect(seed && Redacted.value(seed.refreshToken)).toBe(TOKEN);
        expect(seed && Redacted.value(seed.accountName)).toBe(ACCOUNT);
        // Строка попытки не несёт ни токена, ни имени аккаунта.
        expect(JSON.stringify(done)).not.toContain(TOKEN);
        expect(JSON.stringify(done)).not.toContain(ACCOUNT);
      }),
    ));

  it("same Steam already linked to the user is done without a second account row", () =>
    run((fake) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const seeds = yield* SteamLoginSeeds;
        yield* seedUser("u1", STEAM_ID);
        const now = new Date();
        yield* db.insert(account).values({
          id: "acc-1",
          accountId: STEAM_ID,
          providerId: "steam",
          userId: "u1",
          createdAt: now,
          updatedAt: now,
        });
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.offer(login.events, authenticated());
        yield* waitState("a1", "done");

        const accounts = yield* steamAccounts("u1");
        expect(accounts.map((row) => row.id)).toEqual(["acc-1"]);
        expect((yield* userRow("u1")).steamId).toBe(STEAM_ID);
        expect((yield* seeds.get("u1"))?.steamId).toBe(STEAM_ID);
      }),
    ));

  it("another Steam linked to the user fails with otherSteamLinked", () =>
    run((fake) =>
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seedUser("u1", OTHER_STEAM_ID);
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.offer(login.events, authenticated(STEAM_ID));
        const failed = yield* waitState("a1", "failed");

        expect(failed.error).toBe(steamLoginReasons.otherSteamLinked);
        expect((yield* userRow("u1")).steamId).toBe(OTHER_STEAM_ID);
        expect(yield* steamAccounts("u1")).toHaveLength(0);
        expect(yield* seeds.get("u1")).toBeNull();
      }),
    ));

  it("Steam linked to another user fails with steamTaken", () =>
    run((fake) =>
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seedUser("u1");
        yield* seedUser("u2", STEAM_ID);
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.offer(login.events, authenticated(STEAM_ID));
        const failed = yield* waitState("a1", "failed");

        expect(failed.error).toBe(steamLoginReasons.steamTaken);
        expect((yield* userRow("u1")).steamId).toBeNull();
        expect((yield* userRow("u2")).steamId).toBe(STEAM_ID);
        expect(yield* steamAccounts("u1")).toHaveLength(0);
        expect(yield* seeds.get("u1")).toBeNull();
        expect(yield* seeds.get("u2")).toBeNull();
      }),
    ));

  it("timeout expires the attempt", () =>
    run((fake) =>
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.offer(login.events, { _tag: "Timeout" });
        const expired = yield* waitState("a1", "expired");
        expect(expired.error).toBeNull();
        expect(yield* steamAccounts("u1")).toHaveLength(0);
      }),
    ));

  it("Steam error fails with steamError and no Steam text", () =>
    run((fake) =>
      Effect.gen(function* () {
        const steamText = "RateLimitExceeded: raw Steam text";
        yield* seedUser("u1");
        yield* seedUser("u2");
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        // Ошибка во время опроса.
        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.fail(
          login.events,
          new SteamQrError({ detail: steamText }),
        );
        const failed = yield* waitState("a1", "failed");
        expect(failed.error).toBe(steamLoginReasons.steamError);
        expect(JSON.stringify(failed)).not.toContain("RateLimit");

        // Ошибка уже на `startWithQR` — QR так и не появился.
        fake.state.startError = new SteamQrError({ detail: steamText });
        yield* insertAttempt("a2", "u2");
        const failedStart = yield* waitState("a2", "failed");
        expect(failedStart.error).toBe(steamLoginReasons.steamError);
        expect(failedStart.qrUrl).toBeNull();
        expect(JSON.stringify(failedStart)).not.toContain("RateLimit");
      }),
    ));

  it("Ended before Scanned keeps steamError", () =>
    run((fake) =>
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        // Поток Steam кончается без Authenticated/Timeout и без ошибки —
        // QR так и не был отсканирован.
        yield* Queue.end(login.events);
        const failed = yield* waitState("a1", "failed");
        expect(failed.error).toBe(steamLoginReasons.steamError);
      }),
    ));

  it("Ended after Scanned fails with notConfirmed", () =>
    run((fake) =>
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.offer(login.events, { _tag: "Scanned" });
        yield* waitState("a1", "scanned");
        // Отсканировали, но вход не подтвердили в приложении — поток Steam
        // кончается без итога.
        yield* Queue.end(login.events);
        const failed = yield* waitState("a1", "failed");
        expect(failed.error).toBe(steamLoginReasons.notConfirmed);
      }),
    ));

  it("SteamQrError before Scanned keeps steamError", () =>
    run((fake) =>
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.fail(
          login.events,
          new SteamQrError({ detail: "unknown" }),
        );
        const failed = yield* waitState("a1", "failed");
        expect(failed.error).toBe(steamLoginReasons.steamError);
      }),
    ));

  it("SteamQrError after Scanned fails with notConfirmed", () =>
    run((fake) =>
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.offer(login.events, { _tag: "Scanned" });
        yield* waitState("a1", "scanned");
        yield* Queue.fail(
          login.events,
          new SteamQrError({ detail: "unknown" }),
        );
        const failed = yield* waitState("a1", "failed");
        expect(failed.error).toBe(steamLoginReasons.notConfirmed);
      }),
    ));

  it("pruneFinished removes only old finished attempts", () =>
    run(() =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedUser("u1");
        yield* seedUser("u2");
        yield* seedUser("u3");
        yield* insertAttempt("old-done", "u1", "done");
        yield* insertAttempt("old-waiting", "u2", "waiting");
        yield* insertAttempt("fresh-failed", "u3", "failed");

        // `$onUpdate` ставит `updated_at` на момент записи — состаряем строки
        // напрямую, как если бы итог случился давно.
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        yield* db
          .update(steamLogins)
          .set({ updatedAt: old })
          .where(inArray(steamLogins.id, ["old-done", "old-waiting"]));

        const before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const removed = yield* SteamLoginRepo.pruneFinished(before);
        expect(removed).toBe(1);

        const remaining = yield* db
          .select({ id: steamLogins.id })
          .from(steamLogins);
        expect(remaining.map((row) => row.id).sort()).toEqual([
          "fresh-failed",
          "old-waiting",
        ]);
      }),
    ));

  it("cancelled attempt stops the Steam login", () =>
    run((fake) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const seeds = yield* SteamLoginSeeds;
        yield* seedUser("u1");
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        // Как `steamLogin.start` в API: новая попытка вытесняет старую.
        yield* db
          .update(steamLogins)
          .set({ state: "cancelled" })
          .where(eq(steamLogins.id, "a1"));
        yield* waitFor(
          Effect.sync(() => login.cancelled),
          (cancelled) => cancelled,
          "cancel",
        );

        // Событие, пришедшее уже после отмены, ничего не пишет.
        yield* Queue.offer(login.events, authenticated());
        yield* Effect.sleep("100 millis");
        const row = yield* attempt("a1");
        expect(row.state).toBe("cancelled");
        expect(row.error).toBeNull();
        expect(yield* steamAccounts("u1")).toHaveLength(0);
        expect(yield* seeds.get("u1")).toBeNull();
        expect(fake.logins).toHaveLength(1);
      }),
    ));

  it("stale attempts fail with interrupted on start", () =>
    run((fake) =>
      Effect.gen(function* () {
        for (const id of ["u1", "u2", "u3", "u4"]) yield* seedUser(id);
        yield* insertAttempt("a1", "u1", "pending");
        yield* insertAttempt("a2", "u2", "waiting");
        yield* insertAttempt("a3", "u3", "scanned");
        yield* insertAttempt("a4", "u4", "done");
        yield* startRunner(fake);

        for (const id of ["a1", "a2", "a3"]) {
          const row = yield* attempt(id);
          expect(row.state).toBe("failed");
          expect(row.error).toBe(steamLoginReasons.interrupted);
        }
        expect((yield* attempt("a4")).state).toBe("done");
        // Проваленные при старте попытки Steam не начинают.
        yield* Effect.sleep("100 millis");
        expect(fake.logins).toHaveLength(0);
      }),
    ));

  it("runner logs never contain the token", () => {
    const lines: Array<string> = [];
    const capture = Logger.make((options) => {
      lines.push(Logger.formatJson.log(options));
    });
    return run((fake) =>
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* seedUser("u2", OTHER_STEAM_ID);
        yield* startRunner(fake);
        yield* insertAttempt("a1", "u1");

        yield* waitState("a1", "waiting");
        const login = yield* loginAt(fake, 0);
        yield* Queue.offer(login.events, { _tag: "Scanned" });
        yield* Queue.offer(login.events, authenticated());
        yield* waitState("a1", "done");

        // Неудачная привязка тоже логируется без секретов.
        yield* insertAttempt("a2", "u2");
        yield* waitState("a2", "waiting");
        const second = yield* loginAt(fake, 1);
        yield* Queue.offer(second.events, authenticated());
        yield* waitState("a2", "failed");
      }).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    ).then(() => {
      const text = lines.join("\n");
      // Логи есть (иначе проверка ниже ничего не доказывает).
      expect(text).toContain("Steam login linked");
      expect(text).toContain("Steam login not linked");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(ACCOUNT);
    });
  });
});
