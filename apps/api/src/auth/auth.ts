// Better Auth: вход через Steam (OpenID), Pocket ID (OIDC), Google, Яндекс и код
// на почту; роли пользователей.
import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import { account, type Db, session, user, verification } from "@cg/db";
import { type CurrentUserShape, isSyntheticEmail, type Role } from "@cg/rpc";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins/email-otp";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { steamOpenID } from "better-auth-steam";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { Context, Effect, FiberSet, Layer, Option, Redacted } from "effect";
import type { Headers } from "effect/http/Headers";
import { brandOfRequest } from "../brand/requestBrand";
import {
  AppConfig,
  type AppConfigValues,
  appHosts,
  rpcAllowedOrigins,
} from "../config";
import { syncOnLogin } from "../library/LibraryService";
import { Mailer, type Mail } from "../mail/Mailer";
import { changeEmailCodeMail, loginCodeMail } from "../mail/templates";
import type { ProtonDb } from "../steam/ProtonDb";
import type { SteamApi } from "../steam/SteamApi";
import { authHooks } from "./hooks";
import { telegramProvider } from "./telegram";
import { yandexProvider } from "./yandex";

/** Роль пользователя Pocket ID по claim `groups`. */
export const pocketIdRole = (
  groups: ReadonlyArray<string> | undefined,
  adminGroup: string,
): Role => (groups?.includes(adminGroup) ? "admin" : "player");

const groupsClaim = (groups: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(groups)
    ? groups.filter((g): g is string => typeof g === "string")
    : undefined;

/**
 * Роль, вычисленная из профиля Pocket ID в текущем запросе Better Auth.
 * Пишется в `mapProfileToUser`, читается хуком создания сессии того же запроса
 * (вход) и `after`-хуком `/callback/:id` в `./hooks` (привязка).
 */
export const pocketIdRoleState = defineRequestState<Role | null>(() => null);

export interface MakeAuthOptions {
  /**
   * Дополнительные хуки БД Better Auth. `session.create.before` выполняется
   * после встроенного обновления роли Pocket ID.
   */
  readonly databaseHooks?: BetterAuthOptions["databaseHooks"];
  /**
   * Отправка писем (коды входа и смены почты). По умолчанию отбрасывает
   * письмо ошибкой — `BetterAuth.layer` передаёт настоящую отправку через `Mailer`.
   */
  readonly sendMail?: (mail: Mail) => Promise<void>;
  /**
   * Запуск синхронизации библиотеки после успешной привязки Steam
   * (`authHooks`, `after` на `/steam/callback`). По умолчанию ничего не делает;
   * `BetterAuth.layer` передаёт тот же `startSync`, что и `librarySyncHooks`
   * использует для входа.
   */
  readonly onSteamLinked?: ((userId: string) => void) | undefined;
}

export const makeAuth = (
  config: AppConfigValues,
  options: MakeAuthOptions = {},
) => {
  const db = drizzle(Redacted.value(config.databaseUrl));
  const hooks = options.databaseHooks ?? {};
  const sendMail =
    options.sendMail ??
    (() => Promise.reject(new Error("mailer not configured")));

  return betterAuth({
    // Один Better Auth на все домены витрин: baseURL (redirect_uri OAuth, ссылки, cookie)
    // берётся из хоста запроса, но только из списка PUBLIC_URL + BRAND_HOSTS; чужой хост
    // получает fallback. За прокси хост приходит в x-forwarded-host (trustedProxyHeaders).
    // Схема — всегда схема PUBLIC_URL, не "auto": с "auto" Better Auth 1.7 не ставит
    // `__Secure-` и Secure на cookie (имя сессии на проде сменилось бы — все разлогинены),
    // а redirect_uri без x-forwarded-proto стал бы `http://`.
    baseURL: {
      allowedHosts: [...appHosts(config)],
      fallback: config.publicUrl,
      protocol:
        new URL(config.publicUrl).protocol === "https:" ? "https" : "http",
    },
    trustedOrigins: [...rpcAllowedOrigins(config)],
    advanced: { trustedProxyHeaders: true },
    secret: Redacted.value(config.authSecret),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    user: {
      additionalFields: {
        // input: false — роль нельзя задать через публичные эндпоинты (update-user и т. п.).
        role: {
          type: "string",
          required: false,
          input: false,
          defaultValue: "player",
        },
      },
    },
    account: {
      // Привязка аккаунтов включена: один игрок — один user, даже если он входит
      // то через почту, то через Google/Яндекс/Pocket ID. trustedProviders — эти
      // провайдеры подтверждают почту сами, поэтому неявная склейка по email не
      // требует отдельного подтверждения. Steam не в списке (нет email), шатдаун
      // и хуки входа через Steam — Task 4.
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "yandex", "pocket-id"],
        allowDifferentEmails: true,
        allowUnlinkingAll: true,
      },
    },
    ...(Option.isSome(config.google)
      ? {
          socialProviders: {
            google: {
              clientId: config.google.value.clientId,
              clientSecret: Redacted.value(config.google.value.clientSecret),
            },
          },
        }
      : {}),
    databaseHooks: {
      ...hooks,
      user: {
        ...hooks.user,
        create: {
          ...hooks.user?.create,
          before: async (newUser, context) => {
            // Внешний хук (из слоя) выполняется первым — наш дефолт имени
            // накладывается на его результат, а не подменяет его.
            const result = await hooks.user?.create?.before?.(newUser, context);
            if (result === false) return false;
            const overrideData =
              result && typeof result === "object" && "data" in result
                ? result.data
                : undefined;
            const name = overrideData?.name ?? newUser.name;
            // Код на почту (emailOTP) не спрашивает имя — Better Auth создаёт
            // пользователя с `name: ""`. Провайдеры (Telegram/Steam/OAuth) своё
            // имя уже проставляют, их сюда не заносит.
            if (typeof name === "string" && name.trim().length === 0) {
              const email = overrideData?.email ?? newUser.email;
              const localPart =
                typeof email === "string" ? email.split("@")[0] : undefined;
              if (localPart) {
                return { data: { ...overrideData, name: localPart } };
              }
            }
            return result;
          },
        },
      },
      session: {
        ...hooks.session,
        create: {
          ...hooks.session?.create,
          before: async (newSession, context) => {
            // Вход через Pocket ID: роль пересчитывается при каждом входе.
            // В before, а не after: если обновить роль не удалось, вход не состоится.
            const role = (await hasRequestState())
              ? await pocketIdRoleState.get()
              : null;
            if (role !== null) {
              await db
                .update(user)
                .set({ role })
                .where(eq(user.id, newSession.userId));
            }
            return hooks.session?.create?.before?.(newSession, context);
          },
        },
      },
    },
    hooks: authHooks({
      db,
      adminGroup: config.pocketIdAdminGroup,
      onSteamLinked: options.onSteamLinked,
    }),
    plugins: [
      steamOpenID({ apiKey: Redacted.value(config.steamApiKey) }),
      genericOAuth({
        config: [
          {
            providerId: "pocket-id",
            name: "Pocket ID",
            discoveryUrl: `${config.pocketIdUrl}/.well-known/openid-configuration`,
            clientId: config.pocketIdClientId,
            clientSecret: Redacted.value(config.pocketIdClientSecret),
            scopes: ["openid", "profile", "email", "groups"],
            mapProfileToUser: async (profile) => {
              await pocketIdRoleState.set(
                pocketIdRole(
                  groupsClaim(profile["groups"]),
                  config.pocketIdAdminGroup,
                ),
              );
              return { emailVerified: profile["email_verified"] === true };
            },
          },
          ...(Option.isSome(config.yandex)
            ? [
                yandexProvider(
                  config.yandex.value.clientId,
                  Redacted.value(config.yandex.value.clientSecret),
                ),
              ]
            : []),
          ...(Option.isSome(config.telegram)
            ? [
                telegramProvider(
                  config.telegram.value.clientId,
                  Redacted.value(config.telegram.value.clientSecret),
                ),
              ]
            : []),
        ],
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        changeEmail: { enabled: true, verifyCurrentEmail: false },
        rateLimit: { window: 30, max: 1 },
        sendVerificationOTP: ({ email, otp, type }, ctx) => {
          // Письмо от имени витрины, с которой запросили код.
          const brandName = brandOfRequest(
            ctx?.request?.headers ?? ctx?.headers,
            config,
          ).name;
          return sendMail({
            to: email,
            ...(type === "change-email"
              ? changeEmailCodeMail(otp, brandName)
              : loginCodeMail(otp, brandName)),
          });
        },
      }),
    ],
  });
};

export type Auth = ReturnType<typeof makeAuth>;

/**
 * Хук входа: после создания сессии запускает фоновую синхронизацию библиотеки
 * (`startSync(userId)`; пользователей без `steamId` она пропускает). Не ждёт её
 * и никогда не роняет вход — даже если запустить синхронизацию не удалось.
 */
export const librarySyncHooks = (
  startSync: (userId: string) => void,
): NonNullable<BetterAuthOptions["databaseHooks"]> => ({
  session: {
    create: {
      after: async (newSession) => {
        try {
          startSync(newSession.userId);
        } catch (cause) {
          Effect.runFork(
            Effect.logError("Failed to start library sync on login", {
              userId: newSession.userId,
              cause: String(cause),
            }),
          );
        }
      },
    },
  },
});

const toWebHeaders = (headers: Headers): globalThis.Headers =>
  new globalThis.Headers(Object.entries(headers));

/** Better Auth для HTTP-роутера и RPC-мидлвара. */
export class BetterAuth extends Context.Service<
  BetterAuth,
  {
    /** Обработчик `/api/auth/*`. */
    readonly handler: (request: Request) => Promise<Response>;
    /** Пользователь сессии по заголовкам запроса (cookie); нет сессии — None. */
    readonly currentUser: (
      headers: Headers,
    ) => Effect.Effect<Option.Option<CurrentUserShape>>;
  }
>()("@cg/api/BetterAuth") {
  /** Оборачивает экземпляр Better Auth в сервис. */
  static readonly fromAuth = (auth: Auth): BetterAuth["Service"] => ({
    handler: (request) => auth.handler(request),
    currentUser: (headers) =>
      Effect.tryPromise(() =>
        auth.api.getSession({ headers: toWebHeaders(headers) }),
      ).pipe(
        Effect.orDie,
        Effect.map((result) =>
          Option.fromNullishOr(result).pipe(
            Option.map(({ user: u }): CurrentUserShape => ({
              id: u.id,
              name: u.name,
              image: u.image ?? null,
              role: u.role === "admin" ? "admin" : "player",
              steamId: u.steamId ?? null,
              email: isSyntheticEmail(u.email) ? null : u.email,
              emailVerified: u.emailVerified,
            })),
          ),
        ),
      ),
  });

  /**
   * Вход через Steam и привязка Steam (`authHooks`, `after` на `/steam/callback`)
   * запускают одну и ту же фоновую синхронизацию библиотеки (`startSync`).
   * Письма (коды входа и смены почты) идут через `Mailer`: `sendMail` прогоняет
   * `mailer.send` через рантайм слоя (`FiberSet.makeRuntimePromise`), чтобы Better
   * Auth мог `await`-ить отправку и получить отказавший `MailError` как rejection.
   */
  static readonly layer: Layer.Layer<
    BetterAuth,
    never,
    AppConfig | Db | SteamApi | ProtonDb | Mailer
  > = Layer.effect(
    BetterAuth,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const mailer = yield* Mailer;
      const runPromise = yield* FiberSet.makeRuntimePromise<Mailer>();
      const sendMail = (mail: Mail) => runPromise(mailer.send(mail));
      // Синхронизации живут в scope слоя (срок работы сервера), а не запроса входа.
      const runFork = yield* FiberSet.makeRuntime<Db | SteamApi | ProtonDb>();
      const startSync = (userId: string) => {
        runFork(syncOnLogin(userId));
      };
      const databaseHooks = librarySyncHooks(startSync);
      return BetterAuth.fromAuth(
        makeAuth(config, {
          databaseHooks,
          sendMail,
          onSteamLinked: startSync,
        }),
      );
    }),
  );
}
