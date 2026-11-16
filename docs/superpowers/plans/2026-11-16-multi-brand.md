# Витрины партнёров — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** один сайт на нескольких доменах: по домену выбирается витрина (`gamecrate` / `beeline`) со своим
логотипом, названием, цветами, режимом монетизации и возможностью подменить страницу; аккаунты общие.

**Architecture:** общий пакет `@cg/brands` (данные витрин и выбор по хосту) читают и api, и web. Api по
хосту подставляет витрину в `index.html` (`data-brand`, `<title>`, мета, favicon, доступные OAuth),
Better Auth работает с несколькими хостами (`baseURL.allowedHosts`), письма подписаны витриной. Web
берёт витрину из `data-brand`, цвета — токены CSS с переопределением по `[data-brand]`, названия/логотип/
монетизация/подмены — из реестра витрин web.

**Tech Stack:** Bun 1.4.4 workspaces, Effect 4.0.5 (`effect/http`, `effect/rpc`), Better Auth 1.7.10,
React 19 + TanStack Router, Tailwind 4, `bun test` + happy-dom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-16-multi-brand-design.md`

## Global Constraints

- Витрина по умолчанию — `gamecrate`; неизвестный хост → `gamecrate`. Внешний вид GameCrate не меняется.
- Аккаунт один на все домены; полей `brand` у пользователя/сессии/тарифа нет.
- Домены — только в окружении: `BRAND_HOSTS` (`host=brandId,host=brandId`), `OAUTH_HOSTS_GOOGLE`,
  `OAUTH_HOSTS_YANDEX`, `OAUTH_HOSTS_POCKET_ID`, `OAUTH_HOSTS_TELEGRAM` (хосты через запятую; не задана —
  провайдер включён только на хосте `PUBLIC_URL`).
- Dev без настроек: хост `<brandId>.localhost` → эта витрина.
- Билайн: акцент `#ffc800`, опорный тёмный `#28303f`, градиент `#ffc800` → `#ff9f00`, текст на акцентной
  кнопке тёмный; название «билайн»; шрифт — Inter (Beeline Sans не подключаем до получения файлов).
- Логотип Билайна — временная заглушка (текстовый знак «билайн» на жёлтом), помечена `// TODO(owner):
  официальный SVG`; не рисовать имитацию фирменного логотипа.
- На витрине Билайна нет строки «GameCrate», цен и кнопок покупки.
- Версии зависимостей пинуются точно (без `^`/`~`), новых внешних зависимостей не добавляем.
- Комментарии и тексты — по-русски, как в остальном коде.

## Review Focus

1. Хост с портом и в верхнем регистре (`Play.Beeline.ru:443`, `beeline.localhost:5173`) → та же витрина
   (тест в Task 1).
2. Запрос за ассетом (`/assets/x.js`, `/brands/beeline/favicon.svg`) не подменяется на `index.html`, а
   глубокая ссылка `/app/game/570` на домене Билайна получает билайновский `index.html` (тест в Task 3).
3. Вход по почте на домене Билайна: письмо «Код для входа в билайн», а не GameCrate; запрос без
   заголовка хоста — письмо GameCrate, не ошибка (тест в Task 2).
4. Origin `https://<домен витрины>` проходит проверку `/rpc` и прокси стрима, чужой — 403 (тест в Task 2).
5. Canvas-сцены (логин-куб, TechFlow, сборка куба) на витрине Билайна рисуют жёлтым, а не синим (тест
   в Task 4: цвета берутся из токенов, хардкодов GameCrate в компонентах не осталось).

---

### Task 1: пакет `@cg/brands`

**Files:**
- Create: `packages/brands/package.json` (как `packages/rpc/package.json`: `"name": "@cg/brands"`,
  `module`/`types` = `src/index.ts`, скрипты `check`/`lint`/`test`, без зависимостей),
  `packages/brands/tsconfig.json` (копия `packages/rpc/tsconfig.json`), `packages/brands/src/index.ts`
- Test: `packages/brands/test/brands.test.ts`
- Modify: `apps/api/package.json`, `apps/web/package.json` — `"@cg/brands": "workspace:*"`; `bun install`

**Interfaces — Produces:**
```ts
export type BrandId = "gamecrate" | "beeline";
export const BRAND_IDS: readonly BrandId[];
export const DEFAULT_BRAND: BrandId; // "gamecrate"
export type BrandMeta = {
  readonly id: BrandId;
  readonly name: string;            // "GameCrate" | "билайн" — в тексты и письма
  readonly title: string;           // <title> и og:title
  readonly description: string;     // meta description и og:description
  readonly themeColor: string;      // meta theme-color
  /** Пути favicon/apple-touch-icon в dist; `null` — оставить из шаблона index.html. */
  readonly icons: { readonly favicon: string; readonly appleTouchIcon: string } | null;
};
export const BRANDS: Readonly<Record<BrandId, BrandMeta>>;
export const isBrandId: (value: string) => value is BrandId;
/** `"a.ru=beeline, b.ru=gamecrate"` → Map(host→id); хосты в нижнем регистре; неизвестный id или
 *  строка без `=` — ошибка (Error с текстом пары), пустая строка — пустая Map. */
export const parseBrandHosts: (value: string) => ReadonlyMap<string, BrandId>;
/** Хост без порта, в нижнем регистре; `<id>.localhost` → id; иначе по карте; иначе DEFAULT_BRAND. */
export const brandForHost: (host: string | undefined, hosts: ReadonlyMap<string, BrandId>) => BrandId;
/** Хост без порта и в нижнем регистре (`"Play.X.ru:443"` → `"play.x.ru"`). */
export const normalizeHost: (host: string) => string;
```
Значения: gamecrate — `title: "GameCrate — облачный гейминг"`, description и themeColor `#05060f` из
текущего `apps/web/src/index.html`, `icons: null`. beeline — `name: "билайн"`, `title: "билайн —
облачный гейминг"`, description — тот же текст, themeColor `#28303f`, `icons: { favicon:
"/brands/beeline/favicon.svg", appleTouchIcon: "/brands/beeline/apple-touch-icon.png" }`.

- [ ] **Step 1: Написать падающие тесты** `brands.test.ts`:
  - `parseBrandHosts("Play.Beeline.ru=beeline, beeline.brofrong.ru=beeline")` → Map из двух пар с
    хостами в нижнем регистре; `parseBrandHosts("")` → размер 0; `parseBrandHosts("x.ru=nope")` и
    `parseBrandHosts("x.ru")` бросают.
  - `brandForHost("Play.Beeline.ru:443", map)` → `"beeline"`; `brandForHost("beeline.localhost:5173",
    new Map())` → `"beeline"`; `brandForHost("game.brofrong.ru", map)` → `"gamecrate"`;
    `brandForHost(undefined, map)` → `"gamecrate"`; `brandForHost("evil.localhost", new Map())` →
    `"gamecrate"`.
  - `BRANDS.beeline.name === "билайн"`, `BRANDS.gamecrate.icons === null`.
- [ ] **Step 2:** `bun test` в `packages/brands` → FAIL (модуль не найден).
- [ ] **Step 3:** реализовать `src/index.ts` по интерфейсу выше.
- [ ] **Step 4:** `bun test` → PASS; `bun run check` и `bun run lint` в корне → без ошибок.
- [ ] **Step 5:** commit `feat(brands): пакет витрин — данные и выбор по хосту`.

### Task 2: api на нескольких доменах — конфиг, Origin, Better Auth, письма

**Files:**
- Modify: `apps/api/src/config.ts` (поля `brandHosts`, `oauthHosts`; `rpcAllowedOrigins`),
  `apps/api/src/auth/auth.ts` (`baseURL`, `trustedOrigins`, `advanced.trustedProxyHeaders`,
  `sendVerificationOTP`), `apps/api/src/mail/templates.ts`, `.env.example`, `deploy/compose.main.yaml`
  (переменные `BRAND_HOSTS`, `OAUTH_HOSTS_*` в `cg-api` с `:-`)
- Create: `apps/api/src/brand/requestBrand.ts`
- Test: `apps/api/test/config.test.ts`, `apps/api/test/emailOtp.test.ts`, `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `parseBrandHosts`, `brandForHost`, `normalizeHost`, `BRANDS`, `BrandId` (Task 1).
- Produces:
```ts
// config.ts, в appConfig
brandHosts: ReadonlyMap<string, BrandId>;          // BRAND_HOSTS, по умолчанию пустая; ошибка парсинга → ConfigError
oauthHosts: {                                       // OAUTH_HOSTS_*, по умолчанию [хост PUBLIC_URL]
  readonly google: ReadonlySet<string>; readonly yandex: ReadonlySet<string>;
  readonly pocketId: ReadonlySet<string>; readonly telegram: ReadonlySet<string>;
};
/** Хост PUBLIC_URL + все хосты BRAND_HOSTS (нормализованные). */
export const appHosts: (config: AppConfigValues) => ReadonlyArray<string>;
// rpcAllowedOrigins: дополнительно `${protocol PUBLIC_URL}//${host}` для каждого хоста BRAND_HOSTS
// requestBrand.ts
/** Хост запроса: `x-forwarded-host` (первое значение), иначе `host`. */
export const requestHost: (headers: Headers) => string | undefined;
export const brandOfRequest: (headers: Headers | undefined, config: AppConfigValues) => BrandMeta;
// templates.ts
export const loginCodeMail: (code: string, brandName: string) => Omit<Mail, "to">;
export const changeEmailCodeMail: (code: string, brandName: string) => Omit<Mail, "to">;
```
- Better Auth: `baseURL: { allowedHosts: [...appHosts(config)], fallback: config.publicUrl, protocol:
  "auto" }`, `advanced: { trustedProxyHeaders: true }` (за прокси хост приходит в `x-forwarded-host`;
  подмена ограничена `allowedHosts`), `trustedOrigins` — все origin из `rpcAllowedOrigins`.
  `sendVerificationOTP(data, ctx)` берёт витрину из `ctx?.request?.headers ?? ctx?.headers`.

- [ ] **Step 1: Падающие тесты.**
  - `config.test.ts`: `BRAND_HOSTS="play.beeline.ru=beeline"` → `config.brandHosts.get("play.beeline.ru")
    === "beeline"`; `BRAND_HOSTS="x=bad"` → ConfigError; `rpcAllowedOrigins` при `PUBLIC_URL=https://game.x.ru`
    содержит `https://game.x.ru` и `https://play.beeline.ru`; без `OAUTH_HOSTS_GOOGLE` →
    `oauthHosts.google` = `{"game.x.ru"}`, с `OAUTH_HOSTS_GOOGLE="a.ru, B.ru"` → `{"a.ru","b.ru"}`.
  - `emailOtp.test.ts`: `baseConfig()` дополняется `brandHosts`; запрос `send-verification-otp` с
    заголовком `host: play.beeline.ru` → `subject === "Код для входа в билайн"`, текст содержит
    `билайн` и не содержит `GameCrate`; с `x-forwarded-host: play.beeline.ru` — то же; без хоста из
    списка → `"Код для входа в GameCrate"`.
  - `auth.test.ts`: вход через Pocket ID (`/api/auth/sign-in/oauth2`) с `host: play.beeline.ru` →
    в возвращённом URL провайдера `redirect_uri` начинается с `https://play.beeline.ru/api/auth/`;
    с `host: evil.ru` → `redirect_uri` от `PUBLIC_URL`.
- [ ] **Step 2:** `bun run --cwd apps/api test config emailOtp auth` → новые тесты FAIL.
- [ ] **Step 3:** реализовать конфиг, `requestBrand.ts`, шаблоны (подставить `brandName` вместо
  «GameCrate»), Better Auth.
- [ ] **Step 4:** весь `bun run --cwd apps/api test` → PASS (существующие тесты `streamProxy`/`auth`
  не сломаны); `bun run check`.
- [ ] **Step 5:** commit `feat(api): несколько доменов витрин — Origin, Better Auth, письма`.

### Task 3: `index.html` по витрине и способы входа по хосту

**Files:**
- Create: `apps/api/src/brand/indexHtml.ts`, `apps/api/src/brand/route.ts`
- Modify: `apps/api/src/http.ts` (маршрут витрины перед `StaticRoute`), `apps/web/build.ts` (копировать
  `apps/web/src/brands/<id>/public/*` → `dist/brands/<id>/`), `apps/web/dev.ts` (отдавать
  `/brands/:id/:file` из `src/brands/<id>/public/`)
- Create (заглушки иконок для Task 6 — сразу, чтобы маршрут было что отдавать):
  `apps/web/src/brands/beeline/public/favicon.svg`, `apps/web/src/brands/beeline/public/apple-touch-icon.png`
- Test: `apps/api/test/brandIndex.test.ts`

**Interfaces:**
- Consumes: `BrandMeta`, `brandOfRequest`, `requestHost`, `config.oauthHosts` (Tasks 1–2).
- Produces:
```ts
export type OAuthFlags = { google: boolean; yandex: boolean; pocketId: boolean; telegram: boolean };
/** Флаги провайдеров для хоста: провайдер настроен (как `authProviders`) И хост в `oauthHosts.<p>`. */
export const oauthForHost: (config: AppConfigValues, host: string | undefined) => OAuthFlags;
/** Подставляет витрину в собранный index.html: `<html … data-brand="id" data-oauth="google yandex">`,
 *  `<title>`, meta description/og:title/og:description/theme-color; при `brand.icons` — href у
 *  `rel="icon"` и `rel="apple-touch-icon"`. Значения экранируются для HTML. */
export const renderIndexHtml: (template: string, brand: BrandMeta, oauth: OAuthFlags) => string;
```
  `data-oauth` — список включённых через пробел в порядке `google yandex pocket-id telegram`.
- Маршрут: `GET /` и любой `GET` без расширения файла в последнем сегменте пути, кроме `/api/*`,
  `/rpc`, `/stream/*`, `/healthz` → вариант `index.html` для хоста. Шаблон читается из
  `${webDistDir}/index.html` при первом запросе и кешируется; варианты — по ключу «витрина + флаги».
  Остальное — `StaticRoute` как раньше.
- `auth.providers` (`apps/api/src/auth/providers.ts`) не меняется: фронт фильтрует по `data-oauth`
  (Task 5) — так флаги одинаково работают и до установки RPC-соединения.

- [ ] **Step 1: Падающие тесты** `brandIndex.test.ts` (через `toWebHandler`, временный `WEB_DIST_DIR`
  с `index.html` и `assets/app.js`, как в `streamProxy.test.ts`):
  - `GET /app/game/570` с `host: play.beeline.ru` → 200, тело содержит `data-brand="beeline"`,
    `<title>билайн — облачный гейминг</title>`, `href="/brands/beeline/favicon.svg"`, не содержит
    `GameCrate`.
  - `GET /` с `host: game.x.ru` → `data-brand="gamecrate"`, исходный favicon шаблона на месте.
  - `GET /assets/app.js` с хостом Билайна → тело файла, не HTML.
  - `oauthForHost`: Google настроен, `OAUTH_HOSTS_GOOGLE` не задан → на хосте `PUBLIC_URL` `google:
    true`, на `play.beeline.ru` — `false`; Google не настроен → `false` везде.
  - `renderIndexHtml` экранирует `<`/`"` в title.
- [ ] **Step 2:** `bun run --cwd apps/api test brandIndex` → FAIL.
- [ ] **Step 3:** реализовать `indexHtml.ts`, `route.ts`, подключить в `http.ts`; `build.ts`/`dev.ts`.
- [ ] **Step 4:** тесты api → PASS; `bun run --cwd apps/web build` → в `dist/brands/beeline/` есть
  `favicon.svg`.
- [ ] **Step 5:** commit `feat(api): index.html по витрине домена`.

### Task 4: цвета — токены витрины вместо хардкода GameCrate

**Files:**
- Modify: `apps/web/src/styles.css` (новые токены + блок `[data-brand="beeline"]`), компоненты с
  хардкодом (`grep -rnE "#3cc2ff|#3a6cff|#5b2fff|60, ?194|58, ?108|91, ?47" apps/web/src` —
  ~25 файлов: `components/app/*`, `components/landing/*`, `components/login/CubeScene.tsx`,
  `lib/cubeAssembly.ts`, `components/LoadingScreen.tsx` и др.)
- Create: `apps/web/src/lib/brandColors.ts`
- Test: `apps/web/test/brandColors.test.ts`

**Interfaces — Produces:**
- Токены CSS (`:root` = текущие значения GameCrate): `--brand-accent` (= `--brand-cyan`),
  `--brand-accent-2` (= `--brand-blue`), `--brand-accent-3` (= `--brand-violet`),
  `--brand-glow-rgb` (`60 194 255` — для `rgb(var(--brand-glow-rgb) / a)`), `--brand-on-accent`
  (текст на акцентной кнопке; GameCrate — `#ffffff`), существующий `--brand-gradient` и `--primary`.
  Старые `--brand-cyan/blue/violet` остаются алиасами, чтобы классы Tailwind не переписывать разом.
- `[data-brand="beeline"]`: `--brand-accent: #ffc800`, `--brand-accent-2: #ffb300`,
  `--brand-accent-3: #ff9f00`, `--brand-glow-rgb: 255 200 0`, `--brand-on-accent: #14161c`,
  `--brand-gradient: linear-gradient(135deg, #ffc800 0%, #ff9f00 100%)`, `--brand-bg: #0d0f14`,
  `--brand-surface: #151821`, `--brand-card: #1b1f2a`, `--primary` и `--primary-foreground` под
  жёлтый/тёмный (oklch на выбор исполнителя), `--ring` в тон.
- `brandColors.ts`:
```ts
export type BrandPalette = { accent: string; accent2: string; accent3: string; glowRgb: [number, number, number] };
/** Читает токены из `getComputedStyle(document.documentElement)`; без DOM — палитра GameCrate. */
export const readBrandPalette: () => BrandPalette;
```
  Canvas-код (`cubeAssembly.ts`, `CubeScene.tsx`, `TechFlow.tsx`, `CoverWall.tsx`, `Hud.tsx`)
  получает палитру через `readBrandPalette()` при монтировании, а не константами.
- Анимированный логотип GameCrate (`components/brand/Logo.tsx`, `assets/brand/*.svg`) свои цвета
  сохраняет — это логотип витрины GameCrate (Task 5 показывает его только там).

- [ ] **Step 1: Падающие тесты** `brandColors.test.ts`:
  - статический: обход `apps/web/src` (кроме `components/brand/`, `assets/brand/`, `brands/`,
    `styles.css`) — ни один файл не содержит `#3cc2ff`, `#3a6cff`, `#5b2fff` (без учёта регистра) и
    `rgb`/`rgba` с `60, 194, 255` / `58, 108, 255` / `91, 47, 255`.
  - `readBrandPalette()` при `documentElement.style.setProperty("--brand-accent", "#ffc800")` и
    `--brand-glow-rgb: 255 200 0` → `accent === "#ffc800"`, `glowRgb` `[255, 200, 0]`; без значений —
    `accent === "#3cc2ff"`.
  - `styles.css` содержит блок `[data-brand="beeline"]` с `--brand-accent: #ffc800`.
- [ ] **Step 2:** `bun run --cwd apps/web test brandColors` → FAIL.
- [ ] **Step 3:** токены, замена хардкода, `readBrandPalette`.
- [ ] **Step 4:** весь `bun run --cwd apps/web test` → PASS (снапшотов цвета в старых тестах нет —
  если тест сверяет конкретный hex, перевести на токен); `bun run check`.
- [ ] **Step 5:** commit `feat(web): цвета витрины токенами, палитра Билайна`.

### Task 5: витрина во фронте — реестр, название, логотип, способы входа, подмены

**Files:**
- Create: `apps/web/src/brands/index.ts`, `apps/web/src/brands/gamecrate/index.tsx`,
  `apps/web/src/brands/beeline/index.tsx`, `apps/web/src/brands/beeline/BeelineLogo.tsx`,
  `apps/web/src/components/brand/BrandLogo.tsx`, `apps/web/src/components/brand/BrandSlot.tsx`
- Modify: `apps/web/src/main.tsx` (до рендера: `document.documentElement.dataset.brand ??=
  brandForHost(location.host, new Map())` — dev без подстановки api),
  строки «GameCrate»: `components/AppHeader.tsx`, `components/app/Rail.tsx`,
  `components/landing/{LandingNav,LandingFooter,FaqChat,Achievements}.tsx`, `components/landing/data.ts`
  (тексты с названием), `components/login/LoginPanel.tsx`, `routes/login.tsx`, `lib/authErrors.ts`;
  логотип в `LandingNav`, `Rail`, `AppHeader`, `FaqChat`, `routes/login.tsx` → `BrandLogo`;
  фильтр провайдеров: `routes/login.tsx`, `routes/profile.tsx`
- Test: `apps/web/test/brand.test.tsx`

**Interfaces:**
- Consumes: `BrandId`, `BRANDS`, `brandForHost` (Task 1); `data-brand`/`data-oauth` (Task 3).
- Produces:
```ts
// brands/index.ts
export type Monetization =
  | { readonly kind: "own" }                                   // GameCrate: тарифы, цены, «Докупить»
  | { readonly kind: "partner"; readonly title: string; readonly text: string; readonly url: string | null };
export type OverrideKey = "landing" | "loginPanel" | "landingPlans" | "plansPage";
export type WebBrand = BrandMeta & {
  readonly Logo: React.ComponentType<{ height?: number; iconOnly?: boolean; progress?: number; title?: string }>;
  readonly monetization: Monetization;
  readonly overrides: Partial<Record<OverrideKey, React.LazyExoticComponent<React.ComponentType>>>;
};
export const WEB_BRANDS: Readonly<Record<BrandId, WebBrand>>;
/** `data-brand` у <html> → WebBrand; неизвестное значение → gamecrate. */
export const currentBrand: () => WebBrand;
export const useBrand: () => WebBrand;      // currentBrand() через контекст; тесты задают BrandProvider
export const BrandProvider: React.FC<{ brand: WebBrand; children: React.ReactNode }>;
/** Фильтр `AuthProviders` по `data-oauth`; атрибута нет (dev) — без фильтра. */
export const providersForPage: (providers: AuthProviders, dataOauth: string | undefined) => AuthProviders;
// components/brand/BrandSlot.tsx
/** Подмена витрины по ключу (в Suspense), иначе fallback. */
export function BrandSlot(props: { name: OverrideKey; fallback: React.ComponentType }): JSX.Element;
```
- gamecrate: `Logo` = существующий `components/brand/Logo`, `monetization: { kind: "own" }`,
  `overrides: {}`. beeline: `Logo` = `BeelineLogo` (заглушка: скруглённый жёлтый `#ffc800` знак +
  слово «билайн» шрифтом витрины; `iconOnly` — только знак; `progress` игнорирует), `monetization:
  { kind: "partner", title: "Подписка билайн", text: "Подписка оформляется в билайне. Когда она
  активна, все игры доступны без ограничений по тарифу.", url: null }` (текст — черновик, владелец
  поправит), `overrides: {}`.
- Тексты с названием берут `useBrand().name` («Войти в {name}», «аккаунт {name}», футер
  `© 2026 {name}. Steam является торговой маркой Valve Corporation.`; слоган «Games in containers» —
  только у gamecrate). `authErrors.ts`: сообщение «…другому пользователю {name}» — функция от имени.
- Роут `/` рендерит `<BrandSlot name="landing" fallback={LandingPage} />`, панель логина —
  `<BrandSlot name="loginPanel" fallback={LoginPanel} />` (с теми же пропсами — `BrandSlot`
  пробрасывает пропсы; уточнить тип при реализации).

- [ ] **Step 1: Падающие тесты** `brand.test.tsx`:
  - `currentBrand()` при `data-brand="beeline"` → `name === "билайн"`; при `data-brand="nope"` и без
    атрибута → gamecrate.
  - лендинг, `LoginPanel` и оболочка `/app` (как в `landing.test.tsx`, `login.test.tsx`,
    `appShell.test.tsx`) в `BrandProvider` с beeline: `document.body.textContent` не содержит
    `GameCrate`, содержит `билайн`; с gamecrate — как раньше содержит `GameCrate`.
  - `providersForPage({google:true,yandex:true,pocketId:true,telegram:false}, "yandex")` →
    только `yandex: true`; с `undefined` → вход без изменений.
  - `BrandSlot`: витрина с `overrides.landing = lazy(() => Promise.resolve({ default: () => <p>свой</p> }))`
    → после ожидания виден «свой»; без подмены — fallback.
- [ ] **Step 2:** `bun run --cwd apps/web test brand` → FAIL.
- [ ] **Step 3:** реестр, `BrandLogo`, `BrandSlot`, замена строк и логотипов, фильтр провайдеров.
- [ ] **Step 4:** весь `bun run --cwd apps/web test` → PASS (`branding.test.tsx`, `logo.test.tsx`,
  `login.test.tsx` по-прежнему про GameCrate по умолчанию); `bun run check`.
- [ ] **Step 5:** commit `feat(web): витрина по домену — название, логотип, вход, подмены`.

### Task 6: монетизация витрины — подписка партнёра у Билайна

**Files:**
- Create: `apps/web/src/components/app/PartnerPlansPage.tsx`,
  `apps/web/src/components/landing/PartnerSubscription.tsx`
- Modify: `apps/web/src/components/landing/LandingPage.tsx` (секция тарифов: `own` → `Plans`,
  `partner` → `PartnerSubscription`; через `BrandSlot name="landingPlans"`), `apps/web/src/routes/app.tsx`
  (`/app/plans`: `own` → `PlansPage`, `partner` → `PartnerPlansPage`; через `BrandSlot name="plansPage"`),
  `apps/web/src/components/app/PlanPanel.tsx` (у `partner` кнопка «Подписка» вместо «Докупить»),
  `components/landing/LandingNav.tsx` (пункт «Тарифы» → «Подписка» у `partner`),
  `apps/web/src/brands/beeline/public/favicon.svg`/`apple-touch-icon.png` (заглушки из Task 3 — довести
  до знака `BeelineLogo`), `deploy/README.md` (раздел «Новая витрина»), `.env.example`
- Test: `apps/web/test/partnerMonetization.test.tsx`

**Interfaces:**
- Consumes: `useBrand().monetization` (Task 5), `accountPlanAtom` (`apps/web/src/rpc.ts`; тип
  `PlayerPlan` из `@cg/rpc`), `formatMinutes` (`lib/planFormat.ts`).
- Produces: `PartnerPlansPage()` — заголовок `monetization.title`, текст `monetization.text`, ссылка
  «Перейти в билайн», если `url !== null`; блок «Ваш тариф»: имя текущего тарифа и остаток минут из
  `accountPlanAtom` (как `PlanPanel`), без цен и без каталога тарифов/пакетов. `PartnerSubscription()` —
  секция лендинга с тем же текстом и кнопкой входа (`PlayButton`), без цен.

- [ ] **Step 1: Падающие тесты** `partnerMonetization.test.tsx`:
  - лендинг с beeline: нет текста `₽`, есть `monetization.title`; с gamecrate — секция тарифов с `₽`
    (как сейчас).
  - `/app/plans` с beeline и `accountPlanAtom` = тариф «Базовый», безлимит: видно «Базовый», нет `₽`,
    нет кнопок покупки; с gamecrate — `PlansPage` как сейчас.
  - `PlanPanel` с beeline: кнопка «Подписка» ведёт на `/app/plans`; с gamecrate — «Докупить».
- [ ] **Step 2:** `bun run --cwd apps/web test partnerMonetization` → FAIL.
- [ ] **Step 3:** реализовать страницы и переключение; README «Новая витрина»: папка
  `apps/web/src/brands/<id>/` + запись в `@cg/brands` и `WEB_BRANDS`, строка в `BRAND_HOSTS`, DNS/TLS
  и маршрут прокси на `cg-api`, домен в `OAUTH_HOSTS_*` после прописи callback
  `https://<домен>/api/auth/callback/<provider>` (`/api/auth/oauth2/callback/<id>` для generic OAuth).
- [ ] **Step 4:** `bun run test` в корне → все пакеты PASS (известный флейк `SteamQrLogin` — перезапуск);
  `bun run check`, `bun run lint`, `bun run --cwd apps/web build`.
- [ ] **Step 5: Проверка глазами.** `bun run dev`, открыть `http://beeline.localhost:5173/`, `/login`,
  `/app`, `/app/plans` и `http://localhost:5173/` — скриншоты в отчёт задачи: жёлтый акцент, тёмный текст
  на жёлтых кнопках, нет «GameCrate» на билайне, GameCrate выглядит как до изменений.
- [ ] **Step 6:** commit `feat(web): подписка партнёра вместо тарифов на витрине Билайна`.
