// Better Auth: вход через Steam (OpenID) и Pocket ID (OIDC), роли пользователей.
import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import { account, type Db, session, user, verification } from "@cg/db";
import type { CurrentUserShape, Role } from "@cg/rpc";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { steamOpenID } from "better-auth-steam";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { Context, Effect, FiberSet, Layer, Option, Redacted } from "effect";
import type { Headers } from "effect/http/Headers";
import { AppConfig, type AppConfigValues } from "../config";
import { syncOnLogin } from "../library/LibraryService";
import type { ProtonDb } from "../steam/ProtonDb";
import type { SteamApi } from "../steam/SteamApi";

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
 * Пишется в `mapProfileToUser`, читается хуком создания сессии того же запроса.
 */
const pocketIdRoleState = defineRequestState<Role | null>(() => null);

export interface MakeAuthOptions {
  /**
   * Дополнительные хуки БД Better Auth. `session.create.before` выполняется
   * после встроенного обновления роли Pocket ID.
   */
  readonly databaseHooks?: BetterAuthOptions["databaseHooks"];
}

export const makeAuth = (
  config: AppConfigValues,
  options: MakeAuthOptions = {},
) => {
  const db = drizzle(Redacted.value(config.databaseUrl));
  const hooks = options.databaseHooks ?? {};

  return betterAuth({
    baseURL: config.publicUrl,
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
      // Привязка аккаунтов запрещена: Steam — для игроков, Pocket ID — для админов.
      // Иначе Steam-вход в общий с админом user давал бы роль admin, а исключённый
      // из группы админ сохранял бы её, входя через Steam. Отключает /steam/link
      // (better-auth-steam), /link-social и неявную привязку по email.
      accountLinking: { enabled: false },
    },
    databaseHooks: {
      ...hooks,
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
              return {};
            },
          },
        ],
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
            })),
          ),
        ),
      ),
  });

  /** Вход через Steam запускает фоновую синхронизацию библиотеки (`librarySyncHooks`). */
  static readonly layer: Layer.Layer<
    BetterAuth,
    never,
    AppConfig | Db | SteamApi | ProtonDb
  > = Layer.effect(
    BetterAuth,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      // Синхронизации живут в scope слоя (срок работы сервера), а не запроса входа.
      const runFork = yield* FiberSet.makeRuntime<Db | SteamApi | ProtonDb>();
      const databaseHooks = librarySyncHooks((userId) => {
        runFork(syncOnLogin(userId));
      });
      return BetterAuth.fromAuth(makeAuth(config, { databaseHooks }));
    }),
  );
}
