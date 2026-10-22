# Вход, регистрация и привязка способов входа — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Человек заводит аккаунт GameCrate через Яндекс, Google, Telegram или почту с одноразовым кодом на странице `/login` («Сборка куба»), привязывает Steam и другие способы входа в профиле `/profile`, а аккаунты с одной подтверждённой почтой склеиваются сами.

**Architecture:** Better Auth 1.7.10 на Effect-сервере `apps/api` расширяется плагинами `emailOTP` (почта + код через SMTP-сервис `Mailer`), встроенным Google, `genericOAuth` для Яндекса (рядом с Pocket ID), собственным плагином Telegram (проверка подписи Login Widget) и включённой привязкой аккаунтов; Steam-вход закрыт хуком, остаётся только привязка через `better-auth-steam`. SPA получает список настроенных провайдеров публичным RPC `auth.providers`, страницу `/login` с canvas-сценой куба и страницу `/profile` со списком способов входа; лендинг и библиотека ведут на `/login` и «Привязать Steam».

**Tech Stack:** Bun 1.4.4, Effect 4, Better Auth 1.7.10 + better-auth-steam 0.2.3, nodemailer 10.2.0 (+ @types/nodemailer 8.0.2), Drizzle 1.0.0-rc.4 / PostgreSQL, React 19.3 + TanStack Router + Tailwind 4 + shadcn, `bun test` + happy-dom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-22-auth-login-and-linking-design.md` (ниже «спека»). Прототип сцены: `docs/brand/prototypes/login-concepts.html`, секция `#secC` и скрипт `// ---------- C: сборка куба ----------`.

## Global Constraints

- Ветка `feat/auth-login-linking` от `main` (уже создана в worktree `/Users/dmitiigorshkov/.t3/worktrees/imt-cloud-gaming/feat-brand-landing`). Параллельно живёт `feat/mvp-3-gamestore` — не трогать `apps/agent`, `apps/orchestrator`, `packages/db/src/schema/{gamestore,sessions}.ts`.
- Версии зависимостей — точные (`bunfig.toml` `exact = true`): `nodemailer` `10.2.0`, `@types/nodemailer` `8.0.2`. Больше новых зависимостей нет (нет `genericOAuthClient`: для Яндекса и Pocket ID на клиенте работает `authClient.signIn.social({ provider })`, как сейчас для `pocket-id`).
- Перед каждым коммитом: `bun check`, `bun lint`, `bun test` в затронутых пакетах (`apps/api`, `apps/web`, `packages/rpc`); `bun fmt` только по изменённым путям (корневой `bun fmt` трогает чужие файлы — откатывать `git checkout --`).
- Тесты `apps/api` требуют `TEST_DATABASE_URL` (локальный Postgres `deploy/compose.dev.yaml`, `bun test --env-file=../../.env`).
- Секреты: тестовые токены/ключи только выдуманные; никакого вывода значений `.env`; письма и коды в проде в лог не пишутся.
- Пользовательские тексты по-русски, «облако», не «контейнер»; Steam нигде не называется способом **входа**.
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Схема Better Auth не меняется; новых таблиц нет. Провайдеры без ключей в окружении не регистрируются и не показываются.
- Все функции и файлы ниже — на TypeScript в стиле репозитория: Effect `Context.Service`, `Schema.TaggedError`, комментарий-шапка файла по-русски.

## Review Focus

Поведение, которое спека подразумевает, а тесты задач закрепляют отдельно (каждая строка добавлена тестом в задачу-владельца):

1. **`?next=//evil.com` или `?next=https://…` на `/login`** → после входа всегда `/library`, не открытый редирект (Task 8, `safeNext`).
2. **Код отправлен, пользователь сменил адрес и ввёл старый код** → «Неверный код», не вход (Task 8: шаг «Изменить» сбрасывает `otp` и возвращает к полю почты; сервер проверяет код для адреса из запроса).
3. **Отвязка Steam у пользователя с единственной привязкой Google** → разрешена (Steam — не вход), а отвязка Google → запрещена с кодом `LAST_LOGIN_METHOD` (Task 4, оба случая).
4. **Telegram: повтор того же подписанного набора полей спустя 6 минут** → 401 `TELEGRAM_EXPIRED` (Task 5).
5. **SMTP недоступен при запросе кода** → ответ сервера с ошибкой, на фронте «Не удалось отправить письмо, попробуй позже», поле не блокируется навсегда (Task 3 серверная часть, Task 8 фронт).

---

### Task 1: Конфигурация провайдеров и SMTP, сервис `Mailer`

**Files:**
- Modify: `apps/api/src/config.ts`
- Create: `apps/api/src/mail/Mailer.ts`, `apps/api/src/mail/templates.ts`
- Modify: `apps/api/package.json` (зависимости `nodemailer`, `@types/nodemailer`)
- Test: `apps/api/test/mailer.test.ts`, `apps/api/test/config.test.ts`
- Modify: `.env.example` (новые переменные с комментариями), все тесты, которые строят `AppConfigValues` литералом (`apps/api/test/{auth,library,session,settings,streamProxy,steamLogin,linking}.test.ts`) — добавить новые поля.

**Interfaces:**
- Produces в `config.ts` (внутри `appConfig`):
  - `smtpUrl: Config.Redacted("SMTP_URL")`, `mailFrom: Config.String("MAIL_FROM")` — обязательные.
  - `google: Config.option(Config.all({ clientId: Config.String("GOOGLE_CLIENT_ID"), clientSecret: Config.Redacted("GOOGLE_CLIENT_SECRET") }))` → `Option<{ clientId: string; clientSecret: Redacted<string> }>`.
  - `yandex` — то же с `YANDEX_CLIENT_ID` / `YANDEX_CLIENT_SECRET`.
  - `telegram: Config.option(Config.all({ botToken: Config.Redacted("TELEGRAM_BOT_TOKEN"), botUsername: Config.String("TELEGRAM_BOT_USERNAME") }))`.
- Produces в `Mailer.ts`:
  - `interface Mail { readonly to: string; readonly subject: string; readonly text: string; readonly html: string }`
  - `class MailError extends Schema.TaggedError<MailError>()("MailError", { reason: Schema.String })`
  - `class Mailer extends Context.Service<Mailer, { readonly send: (mail: Mail) => Effect.Effect<void, MailError> }>()("@cg/api/Mailer")` с `static readonly layer: Layer.Layer<Mailer, MailerConfigError, AppConfig>`.
  - `export const LOG_TRANSPORT = "log://"`; `export const isLogTransportAllowed = (smtpUrl: string, publicUrl: string): boolean` — `true`, если `smtpUrl !== LOG_TRANSPORT` или hostname `publicUrl` ∈ {`localhost`, `127.0.0.1`}.
  - `class MailerConfigError extends Schema.TaggedError<MailerConfigError>()("MailerConfigError", { reason: Schema.String })` — слой падает ею, если `log://` в проде.
  - `export const makeMailer = (options: { smtpUrl: string; from: string; transport?: Transporter }): Mailer["Service"]` — `log://` → `Effect.logInfo("mail", { to, subject, text })`; иначе `nodemailer.createTransport(smtpUrl)` (или переданный `transport` для тестов) и `sendMail({ from, to, subject, text, html })`, ошибка → `MailError`.
- Produces в `templates.ts`: `loginCodeMail(code: string): Omit<Mail, "to">` (тема «Код для входа в GameCrate», в тексте код, «действует 10 минут», «если это не ты — просто проигнорируй письмо»), `changeEmailCodeMail(code: string): Omit<Mail, "to">` (тема «Подтверди новую почту в GameCrate»). Без картинок и внешних ссылок.

- [ ] **Step 1: Добавить зависимости**

Run: `cd apps/api && bun add nodemailer@10.2.0 && bun add -d @types/nodemailer@8.0.2`
Expected: в `apps/api/package.json` точные версии, `bun.lock` обновлён.

- [ ] **Step 2: Тесты конфига**

`apps/api/test/config.test.ts` — через `ConfigProvider.fromMap` + `Effect.provide(appConfig, …)`:

```ts
it("optional providers are None when unset", …)      // нет GOOGLE_* → Option.isNone(config.google)
it("google provider is Some when both vars set", …)   // clientId "g-id", Redacted.value(clientSecret) "g-secret"
it("telegram requires both token and username", …)   // только TELEGRAM_BOT_TOKEN → ConfigError (Effect.result → Failure)
it("smtp url and mail from are required", …)         // без SMTP_URL → Failure
```

- [ ] **Step 3: Тесты Mailer**

`apps/api/test/mailer.test.ts`:

```ts
it("log transport writes the letter to the log and never fails", …)
  // makeMailer({ smtpUrl: "log://", from }) .send(...) → Effect succeeds; через Logger.withMinimumLogLevel + Effect.provide(Logger.replace…) собрать строку лога, в ней есть "to" и subject
it("smtp transport passes from/to/subject to nodemailer", …)
  // transport = nodemailer.createTransport({ jsonTransport: true }); обёртка-шпион запоминает аргумент sendMail; expect from === "GameCrate <no-reply@example.com>", to === "ivan@example.com"
it("smtp failure becomes MailError", …)
  // transport.sendMail = () => Promise.reject(new Error("ECONNREFUSED")) → Exit failure с _tag "MailError", reason содержит "ECONNREFUSED"
it("log transport is rejected outside localhost", () => {
  expect(isLogTransportAllowed("log://", "https://game.brofrong.ru")).toBe(false);
  expect(isLogTransportAllowed("log://", "http://localhost:3000")).toBe(true);
  expect(isLogTransportAllowed("smtps://u:p@mail.example:465", "https://game.brofrong.ru")).toBe(true);
});
it("login code mail contains the code and the ttl", () => {
  const mail = loginCodeMail("123456");
  expect(mail.subject).toBe("Код для входа в GameCrate");
  expect(mail.text).toContain("123456"); expect(mail.text).toContain("10 минут"); expect(mail.html).toContain("123456");
});
```

- [ ] **Step 4: Запустить тесты — падают**

Run: `cd apps/api && bun test --env-file=../../.env test/config.test.ts test/mailer.test.ts`
Expected: FAIL (нет модулей/полей).

- [ ] **Step 5: Реализовать `config.ts`, `mail/Mailer.ts`, `mail/templates.ts`**

`Mailer.layer`: читает `AppConfig`, проверяет `isLogTransportAllowed(Redacted.value(smtpUrl), publicUrl)` (иначе `MailerConfigError`), возвращает `makeMailer`. Сам `nodemailer` импортировать как `import nodemailer from "nodemailer"`.

- [ ] **Step 6: Обновить фикстуры `AppConfigValues` в существующих тестах и `.env.example`**

В каждом тесте, где конфиг собирается литералом: `smtpUrl: Redacted.make("log://")`, `mailFrom: "GameCrate <test@example.com>"`, `google: Option.none()`, `yandex: Option.none()`, `telegram: Option.none()`. В `.env.example` — блок «Почта» (`SMTP_URL=log://` с комментарием про прод, `MAIL_FROM=GameCrate <no-reply@brofrong.ru>`) и блок «Провайдеры входа (необязательно)» с шестью переменными пустыми.

- [ ] **Step 7: Проверки**

Run: `cd apps/api && bun check && bun lint && bun test --env-file=../../.env`
Expected: всё зелёное.

- [ ] **Step 8: Commit**

```bash
git add apps/api .env.example bun.lock
git commit -m "feat(api): provider config, SMTP mailer and code templates"
```

---

### Task 2: Контракт RPC — `auth.providers`, расширенный `auth.me`, общие правила способов входа

**Files:**
- Modify: `packages/rpc/src/auth.ts`, `packages/rpc/src/index.ts`
- Create: `packages/rpc/src/loginMethods.ts`
- Test: `packages/rpc/test/loginMethods.test.ts`
- Create: `apps/api/src/auth/providers.ts`
- Modify: `apps/api/src/auth/rpc.ts`, `apps/api/src/auth/auth.ts` (`fromAuth` → новые поля), `apps/api/src/http.ts` (`RpcHandlers` + `PublicAuthRpcHandlers`)
- Test: `apps/api/test/auth.test.ts` (дополнить)
- Modify: `apps/web/src/rpc.ts` (`providersAtom`), фикстуры `CurrentUserShape` в `apps/web/test/landing.test.tsx` и `apps/api/test/*.test.ts` (поля `email`, `emailVerified`).

**Interfaces:**
- `packages/rpc/src/auth.ts`:
  - `CurrentUserShape` + `email: Schema.NullOr(Schema.String)` (null для синтетической), `emailVerified: Schema.Boolean`.
  - `export const AuthProviders = Schema.Struct({ google: Schema.Boolean, yandex: Schema.Boolean, pocketId: Schema.Boolean, telegram: Schema.NullOr(Schema.Struct({ botId: Schema.String, botUsername: Schema.String })) })`, `type AuthProviders`.
  - `export const PublicAuthRpcs = RpcGroup.make(Rpc.make("auth.providers", { success: AuthProviders }))` — без мидлваров.
  - `index.ts`: `AppRpcs = AuthRpcs.merge(PublicAuthRpcs, AdminRpcs, LibraryRpcs, SessionRpcs)`; `export * from "./loginMethods"`.
- `packages/rpc/src/loginMethods.ts`:
  - `export const SYNTHETIC_EMAIL = /^(steam|tg)_\d+@/i; export const isSyntheticEmail = (email: string): boolean`.
  - `export type LoginProviderId = "google" | "yandex" | "pocket-id" | "telegram" | "steam-openid"`; `export const LOGIN_CAPABLE: ReadonlySet<string>` = все, кроме `steam-openid`.
  - `export const canUnlink = (accounts: ReadonlyArray<{ readonly providerId: string }>, providerId: string, user: { readonly email: string | null; readonly emailVerified: boolean }): boolean` — после удаления всех рядов `providerId` остаётся хоть один `LOGIN_CAPABLE` **или** `user.emailVerified && user.email !== null && !isSyntheticEmail(user.email)`.
- `apps/api/src/auth/providers.ts`: `export const authProviders = (config: AppConfigValues): AuthProviders` — `telegram.botId` = часть токена до `:`.
- `apps/api/src/auth/rpc.ts`: `export const PublicAuthRpcHandlers = PublicAuthRpcs.toLayer(Effect.gen(…AppConfig… "auth.providers": () => Effect.succeed(authProviders(config))))`.
- `apps/web/src/rpc.ts`: `export const providersAtom = Api.query("auth.providers", undefined)`.

- [ ] **Step 1: Тесты `loginMethods`**

```ts
it("synthetic emails are recognised", () => { expect(isSyntheticEmail("steam_7656@steam.local")).toBe(true); expect(isSyntheticEmail("tg_42@telegram.invalid")).toBe(true); expect(isSyntheticEmail("ivan@gmail.com")).toBe(false); });
it("unlinking google with only steam left is refused", () => expect(canUnlink([{providerId:"google"},{providerId:"steam-openid"}], "google", { email: "tg_1@telegram.invalid", emailVerified: false })).toBe(false));
it("unlinking steam is always allowed", () => expect(canUnlink([{providerId:"google"},{providerId:"steam-openid"}], "steam-openid", { email: "tg_1@telegram.invalid", emailVerified: false })).toBe(true));
it("verified real email counts as a login method", () => expect(canUnlink([{providerId:"google"}], "google", { email: "ivan@gmail.com", emailVerified: true })).toBe(true));
it("unverified email does not count", () => expect(canUnlink([{providerId:"google"}], "google", { email: "ivan@gmail.com", emailVerified: false })).toBe(false));
```

- [ ] **Step 2: Тесты api**

В `apps/api/test/auth.test.ts`: `auth.providers reflects config` — конфиг с `google: Option.some(...)`, `telegram: Option.some({ botToken: Redacted.make("123456:ABC"), botUsername: "gamecrate_bot" })`, `yandex: Option.none()` → `{ google: true, yandex: false, pocketId: true, telegram: { botId: "123456", botUsername: "gamecrate_bot" } }`; RPC доступен **без** сессии (`fakeAuth(null)`). `auth.me returns email fields` — фикстура `player` с `email: "ivan@example.com", emailVerified: true`.

- [ ] **Step 3: Запустить — падают**

Run: `cd packages/rpc && bun test; cd ../../apps/api && bun test --env-file=../../.env test/auth.test.ts`

- [ ] **Step 4: Реализовать**

`fromAuth`: `email: isSyntheticEmail(u.email) ? null : u.email`, `emailVerified: u.emailVerified`. Обновить все фикстуры `CurrentUserShape` (`steamId:` встречается в `apps/api/test/{auth,library,session,settings,streamProxy}.test.ts`, `apps/web/test/landing.test.tsx`).

- [ ] **Step 5: Проверки и коммит**

Run: `bun check && bun lint && bun test` (в `packages/rpc`, `apps/api`, `apps/web`).

```bash
git add packages/rpc apps/api apps/web/src/rpc.ts apps/web/test
git commit -m "feat(rpc,api): public auth.providers, email in auth.me, shared login-method rules"
```

---

### Task 3: Провайдеры и правила склейки в Better Auth (почта с кодом, Google, Яндекс, Pocket ID)

**Files:**
- Modify: `apps/api/src/auth/auth.ts`
- Create: `apps/api/src/auth/yandex.ts`
- Test: `apps/api/test/yandex.test.ts`, `apps/api/test/emailOtp.test.ts`
- Modify: `apps/api/src/main.ts` (`Mailer.layer` в `Services`), `apps/api/test/auth.test.ts` `appDeps` (мок `Mailer`).

**Interfaces:**
- `MakeAuthOptions` + `readonly sendMail?: (mail: Mail) => Promise<void>` (по умолчанию — бросает `Error("mailer not configured")`; слой передаёт настоящий через рантайм).
- `BetterAuth.layer` требует дополнительно `Mailer`; внутри: `const runtime = yield* Effect.runtime<Mailer>()`, `sendMail = (mail) => Runtime.runPromise(runtime)(mailer.send(mail))`.
- `apps/api/src/auth/yandex.ts`:
  - `export const YandexInfo = Schema.Struct({ id: Schema.String, default_email: Schema.optional(Schema.String), display_name: Schema.optional(Schema.String), real_name: Schema.optional(Schema.String), login: Schema.optional(Schema.String), default_avatar_id: Schema.optional(Schema.String), is_avatar_empty: Schema.optional(Schema.Boolean) })`.
  - `export const yandexUserInfo = (info: typeof YandexInfo.Type): { id: string; email: string; emailVerified: true; name: string; image: string | null } | null` — `null` без `default_email`; имя: `display_name ?? real_name ?? login ?? "Игрок Яндекса"`; аватар `https://avatars.yandex.net/get-yapic/${default_avatar_id}/islands-200` если `!is_avatar_empty && default_avatar_id`.
  - `export const yandexProvider = (clientId: string, clientSecret: string): GenericOAuthConfig` — `providerId: "yandex"`, `authorizationUrl: "https://oauth.yandex.ru/authorize"`, `tokenUrl: "https://oauth.yandex.ru/token"`, `scopes: ["login:email", "login:info", "login:avatar"]`, `getUserInfo: fetch("https://login.yandex.ru/info?format=json", Authorization: OAuth <token>)` → `Schema.decodeUnknownSync(YandexInfo)` → `yandexUserInfo`.
- Настройки в `makeAuth`:
  - `account.accountLinking: { enabled: true, trustedProviders: ["google", "yandex", "pocket-id"], allowDifferentEmails: true, allowUnlinkingAll: true }`.
  - `socialProviders: { google: {...} }` только при `Option.isSome(config.google)`; `genericOAuth.config` = Pocket ID + `yandexProvider` при `isSome(config.yandex)`.
  - Pocket ID `mapProfileToUser` возвращает `{ emailVerified: profile["email_verified"] === true }` (и как раньше пишет роль в request state).
  - `emailOTP({ otpLength: 6, expiresIn: 600, allowedAttempts: 3, storeOTP: "hashed", resendStrategy: "rotate", changeEmail: { enabled: true, verifyCurrentEmail: false }, rateLimit: { window: 30, max: 1 }, sendVerificationOTP: ({ email, otp, type }) => sendMail({ to: email, ...(type === "change-email" ? changeEmailCodeMail(otp) : loginCodeMail(otp)) }) })`. Плагин Telegram и хуки — Tasks 4 и 6.

- [ ] **Step 1: Тест маппинга Яндекса**

```ts
it("maps yandex info with avatar", () => expect(yandexUserInfo({ id: "1", default_email: "a@yandex.ru", display_name: "Аня", default_avatar_id: "0/0-0", is_avatar_empty: false })).toEqual({ id: "1", email: "a@yandex.ru", emailVerified: true, name: "Аня", image: "https://avatars.yandex.net/get-yapic/0/0-0/islands-200" }));
it("yandex without email is rejected", () => expect(yandexUserInfo({ id: "1" })).toBeNull());
it("yandex falls back to login for the name and null avatar", …) // login "anya", is_avatar_empty true → name "anya", image null
```

- [ ] **Step 2: Тест входа по коду (реальная БД, как `steamLogin.test.ts`)**

`apps/api/test/emailOtp.test.ts`: `makeAuth(config, { sendMail: async (mail) => { sent.push(mail) } })`.

```ts
it("send-verification-otp mails a 6-digit code and sign-in creates a verified user", …)
  // POST /api/auth/email-otp/send-verification-otp {email:"ivan@example.com", type:"sign-in"} → 200; code = /\b\d{6}\b/ из sent[0].text; subject "Код для входа в GameCrate"
  // POST /api/auth/sign-in/email-otp {email, otp: code} → 200, Set-Cookie better-auth.session_token; в БД user.emailVerified === true
it("second sign-in with the same email reuses the user", …)   // count(user where email) === 1
it("wrong code is rejected and does not create a session", …) // otp "000000" → status 400/401, нет Set-Cookie
it("mailer failure surfaces as an error response", …)         // sendMail rejects → send-verification-otp status >= 400, body.code/ message присутствуют
it("linking options are enabled", () => expect(auth.options.account?.accountLinking).toMatchObject({ enabled: true, allowDifferentEmails: true, allowUnlinkingAll: true, trustedProviders: ["google", "yandex", "pocket-id"] }))
it("google is registered only when configured", …)           // makeAuth без google → auth.options.socialProviders?.google undefined; с google → defined
```

- [ ] **Step 3: Запустить — падают**

Run: `cd apps/api && bun test --env-file=../../.env test/yandex.test.ts test/emailOtp.test.ts`

- [ ] **Step 4: Реализовать `yandex.ts` и изменения `auth.ts`, `main.ts`**

В `main.ts`: `Services = Layer.mergeAll(SteamApi.layer, ProtonDb.layer, Mailer.layer)…`. В `auth.test.ts` `appDeps`: `Layer.mock(Mailer)({})` или `Layer.succeed(Mailer, { send: () => Effect.void })`.

- [ ] **Step 5: Проверки и коммит**

Run: `cd apps/api && bun check && bun lint && bun test --env-file=../../.env`

```bash
git add apps/api
git commit -m "feat(api): email code sign-in, google and yandex providers, account linking on"
```

---

### Task 4: Хуки Better Auth — Steam только привязка, правило последнего способа, роли при привязке/отвязке Pocket ID

**Files:**
- Create: `apps/api/src/auth/hooks.ts`
- Modify: `apps/api/src/auth/auth.ts` (`hooks: authHooks(db, config)`, синхронизация библиотеки после привязки Steam)
- Test: `apps/api/test/linking.test.ts` (переписать), `apps/api/test/steamLogin.test.ts` (переименовать сценарий)

**Interfaces:**
- `apps/api/src/auth/hooks.ts`: `export const authHooks = (deps: { readonly db: Database (drizzle); readonly adminGroup: string; readonly onSteamLinked?: (userId: string) => void }): NonNullable<BetterAuthOptions["hooks"]>` на `createAuthMiddleware` из `better-auth/api`:
  - `before`: `ctx.path === "/steam/login"` → `throw APIError.from("NOT_FOUND", { message: "STEAM_LOGIN_DISABLED", code: "STEAM_LOGIN_DISABLED" })`; `ctx.path === "/unlink-account"` → сессия через `getSessionFromCtx(ctx)` (нет → пропустить, Better Auth сам ответит 401), ряды `account` пользователя из БД, `canUnlink(accounts, ctx.body.providerId, user)` иначе `APIError.from("BAD_REQUEST", { code: "LAST_LOGIN_METHOD", message: "Нельзя отвязать последний способ входа" })`.
  - `after`: `/unlink-account` с успешным ответом: `providerId === "pocket-id"` → `update user set role = "player"`, `providerId === "steam-openid"` → `update user set steam_id = null` (иначе библиотека продолжит синхронизацию); `/callback/pocket-id` (режим привязки — есть сессия и `pocketIdRoleState` установлен) → записать роль; `/steam/callback` с ответом-редиректом на `callbackURL` без `error` при наличии сессии → `onSteamLinked(userId)`.
- `auth.ts`: `librarySyncHooks` остаётся; `BetterAuth.layer` передаёт в `authHooks` тот же `startSync`.

- [ ] **Step 1: Переписать `linking.test.ts`**

Фикстуры: пользователь `u-admin` с сессией (как сейчас) и пользователь `u-mail` (`email: "ivan@example.com"`, `emailVerified: true`) с сессией; ряды `account`: для `u-admin` — `pocket-id`, для `u-mail` — `google` + `steam-openid`. Используется `fakeSteamFetch` и `steamResponseParams` из `steamLogin.test.ts` (вынести в `apps/api/test/steamFixtures.ts`).

```ts
it("steam login endpoint is gone", …)            // POST /api/auth/steam/login → 404, body.code "STEAM_LOGIN_DISABLED"
it("steam link is allowed for a signed-in admin", …) // POST /api/auth/steam/link cookie admin → 200, body.url startsWith steamOpenIdUrl
it("steam link callback sets steamId on the current user", …) // link → callback с ответом Steam → 302 на /profile, user u-admin.steamId === steamId, account row steam-openid userId u-admin
it("steam already linked to another user is refused", …) // второй пользователь привязывает тот же steamId → 302 на errorCallbackURL с error=STEAM_ACCOUNT_ALREADY_LINKED, steamId у второго null
it("unlinking the last login-capable method is refused", …) // u-mail без emailVerified (обновить в БД false) unlink google → 400 code "LAST_LOGIN_METHOD"
it("unlinking steam is allowed even when it is the only other account", …) // u-mail unlink steam-openid → 200, account row удалён, user.steamId === null
it("verified email keeps google unlinkable", …) // emailVerified true → unlink google → 200
it("unlinking pocket id resets role to player", …) // u-admin unlink pocket-id (у него есть verified email) → role "player"
```

- [ ] **Step 2: Запустить — падают**

Run: `cd apps/api && bun test --env-file=../../.env test/linking.test.ts`

- [ ] **Step 3: Реализовать `hooks.ts`, подключить в `makeAuth`**

- [ ] **Step 4: `steamLogin.test.ts`**

Сценарий «callback with a valid Steam response creates a session» более не валиден: заменить на «steam login is disabled» (404) и удалить остальное, фикстуры вынесены в `steamFixtures.ts`.

- [ ] **Step 5: Проверки и коммит**

Run: `cd apps/api && bun check && bun lint && bun test --env-file=../../.env`

```bash
git add apps/api
git commit -m "feat(api): steam is link-only, last-login-method rule, role sync on pocket id link/unlink"
```

---

### Task 5: Плагин Telegram

**Files:**
- Create: `apps/api/src/auth/telegram.ts`
- Modify: `apps/api/src/auth/auth.ts` (регистрация при `Option.isSome(config.telegram)`)
- Test: `apps/api/test/telegram.test.ts`

**Interfaces:**
- В `packages/rpc/src/auth.ts` (общее для api и web, добавляется в этой задаче): `export const TelegramAuthData = Schema.Struct({ id: Schema.String, first_name: Schema.optional(Schema.String), last_name: Schema.optional(Schema.String), username: Schema.optional(Schema.String), photo_url: Schema.optional(Schema.String), auth_date: Schema.String, hash: Schema.String })`; `id` и `auth_date` Telegram отдаёт числами — на входе эндпоинта приводить `String(value)` до декодирования. `telegram.ts` импортирует схему из `@cg/rpc`.
- `export const telegramDataCheckString = (data: Record<string, string>): string` — все поля кроме `hash`, `key=value`, отсортированы по ключу, через `\n`.
- `export const telegramHash = (data: Record<string, string>, botToken: string): string` — HMAC-SHA256 (hex) с ключом `SHA256(botToken)` (через `crypto.subtle` или `node:crypto`).
- `export const verifyTelegramLogin = (data: TelegramAuthData, botToken: string, now: Date): { readonly _tag: "Ok"; readonly id: string; readonly name: string; readonly image: string | null } | { readonly _tag: "BadSignature" } | { readonly _tag: "Expired" }` — срок 300 с; имя `first_name [last_name]` иначе `@username` иначе `Telegram ${id}`.
- `export const TELEGRAM_EMAIL_DOMAIN = "telegram.invalid"`; `export const telegramPlugin = (options: { botToken: string }): BetterAuthPlugin` с одним эндпоинтом `POST /telegram/callback`, body `{ user: TelegramAuthData, callbackURL?: string, link?: boolean }`:
  - подпись плохая → `APIError UNAUTHORIZED code "TELEGRAM_INVALID_SIGNATURE"`, устарела → `"TELEGRAM_EXPIRED"`;
  - `link: true` требует сессию (`sessionMiddleware`); ряд `account` с `providerId "telegram"` у другого пользователя → `BAD_REQUEST "TELEGRAM_ALREADY_LINKED"`; иначе `createAccount`;
  - иначе вход: найти account → сессия; нет → `createUser({ name, image, email: \`tg_${id}@${TELEGRAM_EMAIL_DOMAIN}\`, emailVerified: false })` + `createAccount` + сессия;
  - сессия создаётся `ctx.context.internalAdapter.createSession` + `setSessionCookie` (как в `better-auth-steam`), ответ `{ redirect: callbackURL ?? "/library" }`.

- [ ] **Step 1: Тесты**

Тестовый токен `"123456:TEST-TOKEN-NOT-REAL"`, подпись считается самим `telegramHash` (фикстура `signed(data)`).

```ts
it("data check string is sorted and excludes hash", () => expect(telegramDataCheckString({ hash: "x", id: "7", auth_date: "1", first_name: "A" })).toBe("auth_date=1\nfirst_name=A\nid=7"));
it("valid signature within 5 minutes is ok", …)           // _tag "Ok", name "Анна Б", image photo_url
it("tampered field fails the signature", …)              // first_name изменён → "BadSignature"
it("auth_date older than 5 minutes is expired", …)       // now = auth_date + 301 c → "Expired"
it("callback signs in a new user with a synthetic email", …) // POST /api/auth/telegram/callback → 200 { redirect: "/library" }, Set-Cookie, user.email "tg_7@telegram.invalid", emailVerified false
it("callback with the same id signs in the same user", …)
it("link attaches telegram to the session user", …)      // cookie u-mail, link:true → account row userId u-mail
it("link of a telegram already owned by another user is refused", …) // 400 TELEGRAM_ALREADY_LINKED
it("bad signature is 401", …)
```

- [ ] **Step 2: Запустить — падают**

Run: `cd apps/api && bun test --env-file=../../.env test/telegram.test.ts`

- [ ] **Step 3: Реализовать `telegram.ts`, зарегистрировать в `makeAuth`**

- [ ] **Step 4: Проверки и коммит**

```bash
git add apps/api packages/rpc
git commit -m "feat(api): telegram login widget plugin (sign-in and link)"
```

---

### Task 6: Клиент авторизации в SPA и словарь ошибок

**Files:**
- Modify: `apps/web/src/auth.ts`
- Create: `apps/web/src/lib/authErrors.ts`, `apps/web/src/lib/safeNext.ts`, `apps/web/src/lib/telegramWidget.ts`
- Test: `apps/web/test/authClient.test.ts`

**Interfaces:**
- `auth.ts` (клиент: `createAuthClient({ plugins: [steamOpenIDClient(), emailOTPClient()] })`, `emailOTPClient` из `better-auth/client/plugins`):
  - `export type SocialProvider = "google" | "yandex" | "pocket-id"`
  - `signInWithProvider(provider: SocialProvider, next: string)` → `authClient.signIn.social({ provider, callbackURL: next, errorCallbackURL: "/login" })`
  - `sendEmailCode(email: string): Promise<{ error: string | null }>` → `authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" })`, ошибка → её `code ?? "UNKNOWN"`.
  - `signInWithEmailCode(email: string, otp: string): Promise<{ error: string | null }>` → `authClient.signIn.emailOtp({ email, otp })`.
  - `linkProvider(provider: SocialProvider)` → `authClient.linkSocial({ provider, callbackURL: "/profile", errorCallbackURL: "/profile" })`.
  - `unlinkProvider(providerId: string, accountId: string): Promise<{ error: string | null }>` → `authClient.unlinkAccount({ providerId, accountId })`.
  - `linkSteam(callbackURL: string)` → `authClient.steam.link({ callbackURL, errorCallbackURL: callbackURL })`.
  - `listLinkedAccounts(): Promise<ReadonlyArray<{ providerId: string; accountId: string }>>` → `authClient.listAccounts()`.
  - `requestEmailChange(newEmail: string)`, `confirmEmailChange(newEmail: string, otp: string)` → `authClient.emailOtp.requestEmailChange / changeEmail` (имена методов клиентского плагина проверить в `better-auth/dist/plugins/email-otp/client.d.mts`).
  - `signInWithTelegram(user: TelegramAuthData, next: string, link = false): Promise<{ error: string | null }>` → `fetch("/api/auth/telegram/callback", { method: "POST", credentials: "include", body })`; при успехе `window.location.assign(redirect)`.
  - `signInWithSteam` и `signInWithPocketId` удалить (Pocket ID теперь через `signInWithProvider("pocket-id", "/admin")`).
- `authErrors.ts`: `export const authErrorMessage = (code: string | undefined): string` — словарь: `STEAM_ACCOUNT_ALREADY_LINKED` → «Этот Steam уже привязан к другому аккаунту», `ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER` → «Этот аккаунт уже привязан к другому пользователю GameCrate», `LAST_LOGIN_METHOD` → «Нельзя отвязать последний способ входа», `INVALID_OTP` → «Неверный код», `OTP_EXPIRED` → «Код устарел, отправь новый», `TOO_MANY_ATTEMPTS` → «Слишком много попыток, запроси новый код», `TELEGRAM_INVALID_SIGNATURE`/`TELEGRAM_EXPIRED` → «Telegram не подтвердил вход», `TELEGRAM_ALREADY_LINKED` → «Этот Telegram уже привязан к другому аккаунту», `access_denied`/`OAUTH_*`/прочее → «Провайдер не подтвердил вход, попробуй ещё раз»; `sendEmailCode` сетевые/5xx → `MAIL_FAILED` → «Не удалось отправить письмо, попробуй позже». Коды Better Auth для OTP взять из `better-auth/dist/plugins/email-otp/error-codes` при реализации.
- `safeNext.ts`: `export const safeNext = (value: unknown, fallback = "/library"): string` — строка, начинается с `/`, не с `//`, без `\` → как есть, иначе `fallback`.
- `telegramWidget.ts`: `export const telegramAuth = (botId: string): Promise<TelegramAuthData | null>` — лениво вставляет `<script src="https://telegram.org/js/telegram-widget.js?22">` один раз, затем `window.Telegram.Login.auth({ bot_id: botId, request_access: false }, (data) => resolve(data ?? null))`; тип `window.Telegram` объявлен в этом файле.

- [ ] **Step 1: Тесты**

```ts
describe("safeNext", () => {
  it("keeps relative paths", () => expect(safeNext("/profile?tab=1")).toBe("/profile?tab=1"));
  it("rejects protocol-relative and absolute urls", () => { expect(safeNext("//evil.com")).toBe("/library"); expect(safeNext("https://evil.com")).toBe("/library"); expect(safeNext(undefined)).toBe("/library"); });
});
describe("authErrorMessage", () => {
  it("maps known codes and falls back", () => { expect(authErrorMessage("LAST_LOGIN_METHOD")).toBe("Нельзя отвязать последний способ входа"); expect(authErrorMessage("WHATEVER")).toBe("Провайдер не подтвердил вход, попробуй ещё раз"); });
});
```

- [ ] **Step 2: Запустить — падают; Step 3: реализовать; Step 4: `bun check && bun lint && bun test` в `apps/web`** (тесты, мокавшие `signInWithSteam`, сломаются — починка в Tasks 9–10; здесь временно подправить мок `landing.test.tsx` на новые имена, чтобы сборка типов проходила).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): auth client for code, social, telegram and linking; error dictionary"
```

---

### Task 7: Модель и сцена «Сборка куба»

**Files:**
- Create: `apps/web/src/lib/cubeAssembly.ts`, `apps/web/src/components/login/CubeScene.tsx`
- Test: `apps/web/test/cubeAssembly.test.ts`, `apps/web/test/cubeScene.test.tsx`

**Interfaces:**
- `cubeAssembly.ts` (чистая геометрия, без DOM):
  - `export type Level = 0 | 1 | 2`; `export interface FormState { readonly email: string; readonly codeLength: number; readonly submitted: boolean }`
  - `export const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/`; `export const assemblyLevel = (s: FormState): Level` — `submitted || codeLength >= 6` → 2; `EMAIL_LIKE.test(email)` → 1; иначе 0.
  - `export const HOME_COUNT: Record<Level, number> = { 0: 9, 1: 18, 2: 27 }`.
  - `export interface Cube { readonly i: number; readonly j: number; readonly k: number; readonly fx: number; readonly fy: number; readonly phase: number; readonly color: readonly [number, number, number]; x: number; y: number }`
  - `export const PALETTE: ReadonlyArray<readonly [number, number, number]>` = `[[60,194,255],[58,108,255],[91,47,255],[80,70,230]]`.
  - `export const makeCubes = (random: () => number): Cube[]` — 27 штук, порядок по `i+j+k` (нижний слой первым), `fx ∈ ±260`, `fy ∈ ±210`, `color = PALETTE[(i+j+k)%4]`.
  - `export const homePosition = (c: Cube, cx: number, cy: number, s: number): { x: number; y: number }` — `x = cx + (i − j)·s`, `y = cy + (i + j)·s/2 − k·s`.
  - `export const targetPosition = (c: Cube, index: number, level: Level, cx: number, cy: number, s: number, t: number, drift: boolean): { x: number; y: number; home: boolean }` — `home = index < HOME_COUNT[level]`; дома — `homePosition`; иначе `cx + fx (+ sin(t/900+phase)·14 если drift)`, `cy − 60 + fy (+ cos(t/1100+phase)·14)`.
  - `export const approach = (cur: number, target: number, k = 0.06): number`.
  - `export const PROVIDER_TINT: Record<"yandex" | "google" | "telegram", readonly [number, number, number]>` = `{ yandex: [252,63,29], google: [66,133,244], telegram: [41,169,235] }`.
  - `export const STEP_LABELS = ["учётка", "код", "облако"] as const`; `export const CAPTIONS: Record<Level, string> = { 0: "Твоё облако собирается", 1: "Почти готово…", 2: "Облако собрано. Поехали!" }`.
- `CubeScene.tsx`: `export function CubeScene({ level, tint, lit, className }: { level: Level; tint: keyof typeof PROVIDER_TINT | null; lit: boolean; className?: string })` — `<canvas>` через `useCanvasLoop(ref, draw)`; размер ребра 34 (≥ 900px) / 24; `prefers-reduced-motion` (`usePrefersReducedMotion`) → кубики сразу в целевых позициях, без дрейфа (`drift=false`, `approach` с `k=1`), свечение без пульсации; подписи шагов (`STEP_LABELS`, пройденные с классом `on`), капшен `ASSEMBLING` + `CAPTIONS[level]`. Рисование граней — функция `drawCube(ctx, x, y, s, color, alpha)` по прототипу.

- [ ] **Step 1: Тесты модели**

```ts
it("level follows the form", () => { expect(assemblyLevel({ email: "", codeLength: 0, submitted: false })).toBe(0); expect(assemblyLevel({ email: "ivan@gmail.com", codeLength: 0, submitted: false })).toBe(1); expect(assemblyLevel({ email: "ivan@gmail.com", codeLength: 6, submitted: false })).toBe(2); expect(assemblyLevel({ email: "", codeLength: 0, submitted: true })).toBe(2); });
it("27 cubes sorted bottom layer first", () => { const cubes = makeCubes(() => 0.5); expect(cubes).toHaveLength(27); expect(cubes[0]).toMatchObject({ i: 0, j: 0, k: 0 }); expect(cubes.at(-1)).toMatchObject({ i: 2, j: 2, k: 2 }); });
it("home position is isometric", () => expect(homePosition({ i: 1, j: 0, k: 1 } as Cube, 100, 200, 34)).toEqual({ x: 134, y: 183 }));
it("only HOME_COUNT cubes are home at each level", () => { const cubes = makeCubes(Math.random); for (const level of [0, 1, 2] as const) expect(cubes.filter((c, n) => targetPosition(c, n, level, 0, 0, 34, 0, false).home)).toHaveLength(HOME_COUNT[level]); });
it("approach moves 6% of the way", () => expect(approach(0, 100)).toBe(6));
```

- [ ] **Step 2: Тест сцены** (`cubeScene.test.tsx`, стаб `VisibleObserver` как в `canvasLoop.test.tsx`): рендер `<CubeScene level={1} tint={null} lit={false} />` показывает подписи «учётка», «код», «облако», капшен «Почти готово…», и первые две подписи с классом `on`.

- [ ] **Step 3: Запустить — падают; Step 4: реализовать; Step 5: `bun check && bun lint && bun test`**

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): cube assembly model and canvas scene for the login page"
```

---

### Task 8: Страница `/login`

**Files:**
- Create: `apps/web/src/components/login/LoginPanel.tsx`, `apps/web/src/components/login/ProviderButtons.tsx`, `apps/web/src/routes/login.tsx`
- Modify: `apps/web/src/main.tsx` (маршрут)
- Test: `apps/web/test/login.test.tsx`

**Interfaces:**
- `ProviderButtons.tsx`: `export function ProviderButtons({ providers, onProvider, onHover, pending }: { providers: AuthProviders; onProvider: (p: "yandex" | "google" | "telegram") => void; onHover: (p: "yandex" | "google" | "telegram" | null) => void; pending: boolean })` — рендерит только `providers.google/yandex/telegram`; тексты «Войти через Яндекс», «Войти через Google», «Войти через Telegram».
- `LoginPanel.tsx`: `export type PanelStep = { kind: "email"; email: string } | { kind: "code"; email: string; otp: string; resendAt: number }`; `export function LoginPanel({ providers, next, onLevel, onTint, onLit }: { providers: AuthProviders | undefined; next: string; onLevel: (l: Level) => void; onTint: (t: keyof typeof PROVIDER_TINT | null) => void; onLit: () => void })` — скелетон, пока `providers === undefined`; поле почты + «Получить код»; шаг кода: «Код отправлен на …», «Изменить», поле `inputMode="numeric" maxLength=6 autoComplete="one-time-code"`, автоподтверждение при 6 цифрах, «Войти», «Отправить ещё раз» (disabled до `resendAt`, таймер `Date.now()`-based, 30 с); ошибки через `authErrorMessage`; успешный `signInWithEmailCode` → `onLit()` и сразу `window.location.assign(next)` (полная навигация, как в `signOut`, из-за RPC-сокета); ссылка «Вход для команды» (`signInWithProvider("pocket-id", "/admin")`) только при `providers.pocketId`; подпись «Входя, ты создаёшь аккаунт GameCrate, если его ещё нет». Telegram: `telegramAuth(providers.telegram.botId)` → `signInWithTelegram(data, next)`.
- `routes/login.tsx`: `validateSearch: { next?: string; error?: string }`; если `meAtom` успешен → `<Navigate to={safeNext(next)} />` (через `window.location.assign`, т. к. сокет); `error` → тост + строка над панелью `authErrorMessage(error)`; компоновка: `<main class="min-h-dvh grid lg:grid-cols-[55fr_45fr]">` — слева `CubeScene` + `Logo` (ссылка на `/`), справа `LoginPanel`; на мобильном панель сверху, сцена 240px.

- [ ] **Step 1: Тесты** (`mock.module("../src/auth", …)` с `sendEmailCode`, `signInWithEmailCode`, `signInWithProvider`, `signInWithTelegram`; `mock.module("../src/lib/telegramWidget", …)`)

```ts
it("renders only configured providers", …)        // providers { google: true, yandex: false, telegram: null, pocketId: true } → кнопка Google есть, Яндекс/Telegram нет, ссылка «Вход для команды» есть
it("skeleton while providers are loading", …)     // providers undefined → role="status" с aria-label "Загрузка способов входа", кнопок нет
it("email step sends a code and shows the code step", …) // ввод "ivan@gmail.com", клик «Получить код» → sendEmailCode вызван с адресом; текст /Код отправлен на ivan@gmail.com/; «Отправить ещё раз» disabled
it("six digits auto-submit", …)                   // ввод "123456" → signInWithEmailCode("ivan@gmail.com","123456") один раз
it("change email resets the code", …)             // клик «Изменить» → снова поле почты; повторный путь с другим адресом → signInWithEmailCode вызывается с новым адресом
it("shows mail failure and keeps the field enabled", …) // sendEmailCode → { error: "MAIL_FAILED" } → текст «Не удалось отправить письмо, попробуй позже», поле почты не disabled
it("provider hover tints and click lights the cube", …) // наведение на Google → onTint("google"); клик → signInWithProvider("google", "/library")
it("level reports to the scene", …)               // onLevel(1) после адреса, onLevel(2) после 6 цифр
it("login route rejects unsafe next", () => expect(safeNext("//evil.com")).toBe("/library")) // в route: next из search проходит через safeNext перед передачей в LoginPanel — тест на экспортированный helper `loginNext(search)`
```

- [ ] **Step 2: Запустить — падают; Step 3: реализовать; Step 4: `bun check && bun lint && bun test`**

- [ ] **Step 5: Ручная проверка**

Run: `bun dev` (api + web), открыть `http://localhost:5173/login` с `SMTP_URL=log://`; запросить код, взять его из лога api, войти; проверить `prefers-reduced-motion` в DevTools и ширину 390px.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): /login page — cube scene, providers, email code"
```

---

### Task 9: Страница `/profile` и ссылка из шапки

**Files:**
- Create: `apps/web/src/routes/profile.tsx`, `apps/web/src/components/profile/LoginMethods.tsx`, `apps/web/src/components/profile/EmailSection.tsx`
- Modify: `apps/web/src/components/AppHeader.tsx` (аватар/имя → `<Link to="/profile">`), `apps/web/src/main.tsx`
- Test: `apps/web/test/profile.test.tsx`

**Interfaces:**
- `LoginMethods.tsx`: `export interface LinkedAccount { readonly providerId: string; readonly accountId: string }`; `export const METHOD_LABELS: Record<LoginProviderId, string>` = Яндекс / Google / Telegram / Pocket ID / Steam; `export function LoginMethods({ user, accounts, providers, onLink, onUnlink, busy }: { user: CurrentUserShape; accounts: ReadonlyArray<LinkedAccount>; providers: AuthProviders; onLink: (p: LoginProviderId) => void; onUnlink: (a: LinkedAccount) => void; busy: string | null })` — строки для провайдеров, настроенных на сервере (Steam и Pocket ID всегда); статус «привязан»/«не привязан»; для Steam — `SteamID ${user.steamId}`; кнопка «Отвязать» disabled с `title="Это единственный способ входа"` когда `!canUnlink(accounts, providerId, user)`.
- `EmailSection.tsx`: `export function EmailSection({ user, onChanged }: { user: CurrentUserShape; onChanged: () => void })` — показывает `user.email` или «Почта не добавлена»; кнопка «Добавить почту»/«Сменить почту» → поле нового адреса → `requestEmailChange` → поле кода → `confirmEmailChange` → `onChanged()` (refresh `meAtom`).
- `routes/profile.tsx`: под `AppHeader`; `meAtom` Unauthorized → `<Navigate to="/login" search={{ next: "/profile" }} />`; `accounts` через `listLinkedAccounts()` в `useEffect` + состояние; `?error=` → тост `authErrorMessage`; `onLink`: `steam-openid` → `linkSteam("/profile")`, `telegram` → `telegramAuth(botId)` → `signInWithTelegram(data, "/profile", true)`, иначе `linkProvider(p)`; `onUnlink` → `unlinkProvider` → перезагрузить список, при `steam-openid` также refresh `meAtom`.

- [ ] **Step 1: Тесты** (моки `../src/auth`, `../src/lib/telegramWidget`)

```ts
it("lists methods with statuses", …)              // accounts [google, steam-openid], providers all on → «Google — привязан», «Steam — привязан · SteamID 7656», «Яндекс — не привязан», «Telegram — не привязан»
it("hides providers not configured on the server", …) // providers.yandex false → строки «Яндекс» нет
it("last login method cannot be unlinked", …)     // user email null, accounts [google, steam-openid] → кнопка «Отвязать» у Google disabled, у Steam enabled
it("unlink calls the client and reloads", …)      // клик «Отвязать» Steam → unlinkProvider("steam-openid","7656")
it("link steam uses steam.link with /profile", …) // клик «Привязать» Steam → linkSteam("/profile")
it("email section adds an address with a code", …) // «Добавить почту» → адрес → requestEmailChange(addr) → код 6 цифр → confirmEmailChange(addr, code) → onChanged
it("header links the avatar to /profile", …)      // render AppHeader в testRouter → link с href "/profile"
```

- [ ] **Step 2: Запустить — падают; Step 3: реализовать; Step 4: `bun check && bun lint && bun test`**

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): /profile with login methods, email change and header link"
```

---

### Task 10: Лендинг и библиотека ведут на `/login` и «Привязать Steam»

**Files:**
- Modify: `apps/web/src/components/landing/SteamButton.tsx` → переименовать в `PlayButton.tsx`; `Hero.tsx`, `LandingNav.tsx`, `Plans.tsx`, `FinalCta.tsx`, `LandingPage.tsx`, `HowItWorks.tsx`, `data.ts`
- Delete: `apps/web/src/lib/useSteamLogin.ts`
- Modify: `apps/web/src/routes/index.tsx` (убрать `error` search и проп), `apps/web/src/routes/library.tsx`
- Test: `apps/web/test/landing.test.tsx`, `apps/web/test/landingSections.test.tsx`, `apps/web/test/libraryRoute.test.tsx` (новый, маленький)
- Modify: `docs/superpowers/specs/2026-10-17-gamecrate-brand-and-landing-design.md` — строка отклонения «2026-10-22: вход через Steam с лендинга заменён ссылкой на `/login`; Steam — привязка».

**Interfaces:**
- `PlayButton.tsx`: `export function PlayButton({ variant, children, className }: { variant: "primary" | "ghost"; children?: React.ReactNode; className?: string })` — `<Button asChild …><Link to="/login">…</Link></Button>`; по умолчанию текст `primary` → «Играть», `ghost` → «Войти»; иконки Steam нет.
- Копирайт: `FinalCta` «Войди и выбери, во что сегодня.»; `HowItWorks` заголовок шага «Привяжи Steam» (вместо «Войти через Steam»); `Hero` подзаголовок без изменений; `LandingPage({})` без `error`.
- `library.tsx`: ветка `user.steamId === null` → заголовок «Подключи Steam, чтобы увидеть свою библиотеку», текст «Мы не просим пароль: Steam сам подтвердит, что аккаунт твой», кнопка «Привязать Steam» → `linkSteam("/library")`; `?error=` → тост `authErrorMessage`.

- [ ] **Step 1: Тесты**

`landing.test.tsx`: заменить «play button starts steam login» на `play buttons link to /login` (все `getAllByRole("link", { name: /Играть|Войти|Выбрать/ })` имеют `href="/login"`); удалить тест ошибки из query; добавить `it("landing never calls steam a login method", () => expect(document.body.textContent).not.toContain("Войти через Steam"))`. Рендер через `testRouter` (нужен `Link`).
`libraryRoute.test.tsx`: экспортировать из `library.tsx` компонент `ConnectSteam({ onLink })` и проверить текст и вызов `onLink`.

- [ ] **Step 2: Запустить — падают; Step 3: реализовать; Step 4: `bun check && bun lint && bun test`; `bun run build` — размер бандла в отчёт**

- [ ] **Step 5: Commit**

```bash
git add apps/web docs/superpowers/specs/2026-10-17-gamecrate-brand-and-landing-design.md
git commit -m "feat(web): landing and library point to /login and Steam linking"
```

---

### Task 11: Деплой и документация

**Files:**
- Modify: `deploy/compose.yaml` (`cg-api`: `SMTP_URL: ${SMTP_URL:?SMTP_URL is required}`, `MAIL_FROM: ${MAIL_FROM:?MAIL_FROM is required}`, `GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}`, … все шесть провайдерских с пустым дефолтом)
- Modify: `deploy/README.md` — шаг 1: новые переменные; шаг 2: callback-адреса Google `https://game.brofrong.ru/api/auth/callback/google`, Яндекс `https://game.brofrong.ru/api/auth/callback/yandex`, BotFather `/setdomain game.brofrong.ru`; новый шаг «Перед первым деплоем входа: удалить старых Steam-пользователей» с SQL из спеки §3.5 (`docker compose exec cg-postgres psql -U cg -d cloud_gaming -c "<SQL>"`); примечание про `SMTP_URL=log://` только для dev.
- Modify: `docs/superpowers/specs/2026-10-22-auth-login-and-linking-design.md` — статус «реализовано <дата>, ветка, план», отклонения если были.
- Проверка: пустая переменная из `${VAR:-}` должна читаться `Config.option` как «не задано» — в `config.ts` трактовать пустую строку как отсутствие (`Config.String(...).pipe(Config.map(trim))` + фильтр) — добавить тест в `config.test.ts`: `it("empty provider vars count as unset", …)`.

- [ ] **Step 1: Тест пустых переменных → падает → реализовать в `config.ts`**
- [ ] **Step 2: Обновить compose, README, статус спеки**
- [ ] **Step 3: Полная проверка**

Run: из корня `bun check && bun lint && bun test`; `cd apps/web && bun run build`.

- [ ] **Step 4: Commit**

```bash
git add deploy docs apps/api
git commit -m "docs(deploy): auth providers, SMTP and one-time Steam user cleanup"
```

---

### Task 12: Финальная проверка ветки

- [ ] **Step 1:** `git log --oneline main..HEAD` — ~11 коммитов; `git diff --stat main..HEAD` не трогает `apps/agent`, `apps/orchestrator`, `packages/db/src/schema/{gamestore,sessions}.ts`.
- [ ] **Step 2:** `bun check && bun lint && bun test` зелёные из корня; `grep -rn "Войти через Steam" apps/web/src` — пусто.
- [ ] **Step 3:** Ручной прогон с `SMTP_URL=log://`: `/` → «Играть» → `/login` → код → `/library` с плашкой → «Привязать Steam» (нужен реальный Steam) → профиль: Steam привязан, «Отвязать» у единственного способа disabled.
- [ ] **Step 4:** Отчёт владельцу: что заведено, что нет (ключи провайдеров), пункт про `.env` прода и чистку старых пользователей; затем `superpowers:finishing-a-development-branch`.
