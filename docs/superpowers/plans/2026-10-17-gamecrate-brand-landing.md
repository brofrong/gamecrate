# GameCrate: айдентика и лендинг — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сервис называется GameCrate: векторный логотип с анимацией сворачивания в шапке, и главная `/` для невошедшего — лендинг из прототипа (стена обложек, поток частиц с HUD, анимированные три шага, тарифы, ачивки, FAQ-чат) на существующем стеке `apps/web`.

**Architecture:** Всё внутри `apps/web`. Геометрия логотипа, физика стены обложек и расписание демо — чистые функции без DOM (тестируются напрямую), поверх них тонкие React-компоненты. Canvas-секции рисуют через общий хук `useCanvasLoop` (DPR, видимость, `prefers-reduced-motion`). Маршрут `/` остаётся прежним по логике (вошедший → `/library`, ошибка Steam из query), меняется только компонент лендинга.

**Tech Stack:** Bun 1.4.4, React 19.3.1, TanStack Router 1.170.45, Tailwind 4.3.3 + shadcn (new-york/zinc), lucide-react, sonner, `bun test` + happy-dom + Testing Library. Новые зависимости: `@fontsource-variable/inter@5.3.0`, `@fontsource-variable/jetbrains-mono@5.3.0` (deps), `@resvg/resvg-js@2.6.2` (devDependency, только для скрипта ассетов). Никаких библиотек анимации.

**Spec:** `docs/superpowers/specs/2026-10-17-gamecrate-brand-and-landing-design.md`. Источник истины по геометрии и анимации логотипа — `docs/brand/prototypes/logo-morph.html` (функция `buildLogo`); по секциям и поведению лендинга — `docs/brand/prototypes/landing.html`. Тексты берутся из `landing.html` дословно (кроме исправления опечаток).

## Global Constraints

- Версии пинуются точно (без `^`/`~`), как во всём репо; проверки `bun run check`, `bun run lint`, `bun run --cwd apps/web test`, форматирование `bun fmt`.
- Правятся только `apps/web` и документация. `apps/api`, `apps/orchestrator`, `apps/agent`, `packages/*` не трогать (параллельная ветка `feat/mvp-2-sessions`).
- Имя продукта — `GameCrate` (латиницей), слоган `Games in containers`. Интерфейс на русском.
- Бренд-цвета: фон `#05060f`, поверхность `#0a0d1c`, карточка `#0f1326`, линия `rgba(255,255,255,0.08)`, градиент `#3cc2ff → #3a6cff → #5b2fff` (135°), текст `#f3f4ff`, приглушённый `#8b90b8`, второстепенный `#6d729a`, зелёный `#3ddc97`, жёлтый `#ffd166`. Добавляются как новые переменные, токены shadcn не меняются.
- Шрифты self-hosted (`@fontsource-variable/*`), никаких `fonts.googleapis.com` в рантайме.
- Без параллакса/наклона сцены за курсором. Реакция на мышь только локальная (ряд под курсором, частицы рядом с курсором).
- Нет обещаний: слов «бесплатно», «RTX 4090 на каждую сессию» нет; симулированные цифры HUD подписаны «иллюстрация»; тарифы помечены «цены и цифры — предварительные».
- `prefers-reduced-motion: reduce`: стена стоит, логотип переключается скачком, canvas рисует один кадр, демо показывает финальный кадр.
- Бюджет: новый JS ≤ 60 КБ минифицированного кода сверх текущего бандла (проверяется в Task 12 по выводу `bun run build`).
- Обложки Steam: `https://cdn.cloudflare.steamstatic.com/steam/apps/<appId>/library_600x900.jpg`, при ошибке `…/header.jpg`, при второй ошибке плитка остаётся тёмной.

## Review Focus

1. **Обложка не загрузилась (CDN отдал 4xx/ORB)** — плитка тёмная, ряд едет дальше, второй запрос на `header.jpg`, третьего нет. Тест: Task 7 `cover falls back to header.jpg once, then stays dark`.
2. **Пользователь с `prefers-reduced-motion`** — ничего не плывёт: ряды стоят, логотип в шапке переключается без промежуточных кадров, canvas рисует один кадр. Тесты: Task 3 `scroll progress snaps when motion is reduced`, Task 6 `canvas loop draws once when motion is reduced`, Task 7 `rows do not drift when motion is reduced`.
3. **Среда без canvas 2D (`getContext` → `null`, старые браузеры, тесты)** — секции рендерятся, текст и кнопки на месте, ошибок нет. Тест: Task 6 `canvas loop is a no-op without a 2d context`, Task 8 `tech section renders text without canvas`.
4. **Тач-устройство без мыши** — `mousemove` не приходит: ряды просто едут, ничего не «залипает», кнопки hero кликабельны. Тест: Task 7 `without hover every row keeps its base speed`.
5. **Вход через Steam не удался (`/?error=…`) или сервер лёг** — на новом лендинге по-прежнему виден текст ошибки и тост, вошедший по-прежнему уходит в `/library`, при недоступном сервере — `ServerUnreachable`. Тесты: Task 5 `landing shows steam error from query`, `index redirects signed-in user to library`.

---

## Файловая структура

```
apps/web/src/styles.css                              + бренд-переменные, импорт шрифтов, keyframes лендинга
apps/web/src/index.html                              title/meta/фавиконки GameCrate
apps/web/src/assets/brand/{logo-full,logo-full-light,logo-mark,favicon}.svg, apple-touch-icon.png, icon-512.png
apps/web/scripts/brand-assets.ts                     генерация ассетов из геометрии (запуск вручную)
apps/web/src/components/brand/logo-geometry.ts       чистая геометрия: полигоны, матрицы, кадр по p
apps/web/src/components/brand/Logo.tsx               SVG-компонент логотипа (progress, iconOnly, light)
apps/web/src/components/brand/useScrollProgress.ts   прогресс сворачивания по скроллу
apps/web/src/lib/usePrefersReducedMotion.ts
apps/web/src/lib/useCanvasLoop.ts                    canvas + DPR + видимость + reduced motion
apps/web/src/lib/useSteamLogin.ts                    вход через Steam: pending + тост (вынесено из index.tsx)
apps/web/src/lib/coverWallPhysics.ts                 чистая физика рядов стены
apps/web/src/lib/howItWorksTimeline.ts               чистое расписание демо «три шага»
apps/web/src/components/landing/data.ts              appId стены и демо, плюсы, тарифы, ачивки, FAQ, заметки
apps/web/src/components/landing/{LandingNav,Hero,CoverWall,TechFlow,Hud,HowItWorks,Plans,Achievements,FaqChat,FinalCta,LandingFooter,LandingPage}.tsx
apps/web/src/components/landing/SteamButton.tsx      кнопка входа (иконка Steam, pending) — используется в шапке, hero, тарифах, CTA
apps/web/src/routes/index.tsx                        Landing → LandingPage; логика IndexPage без изменений
apps/web/src/components/AppHeader.tsx                знак GC + «GameCrate»
apps/web/test/{branding,logoGeometry,logo,canvasLoop,coverWallPhysics,howItWorksTimeline,landing,landingSections}.test.ts(x)
```

---

### Task 1: Имя, шрифты и бренд-токены

**Files:**
- Modify: `apps/web/package.json` (deps), `apps/web/src/styles.css`, `apps/web/src/index.html`
- Test: `apps/web/test/branding.test.ts`

**Interfaces:**
- Produces: CSS-переменные в `:root`: `--brand-bg: #05060f; --brand-surface: #0a0d1c; --brand-card: #0f1326; --brand-line: rgba(255,255,255,0.08); --brand-cyan: #3cc2ff; --brand-blue: #3a6cff; --brand-violet: #5b2fff; --brand-text: #f3f4ff; --brand-muted: #8b90b8; --brand-dim: #6d729a; --brand-ok: #3ddc97; --brand-warn: #ffd166; --brand-gradient: linear-gradient(135deg, #3cc2ff 0%, #3a6cff 50%, #5b2fff 100%); --font-sans: "Inter Variable", system-ui, sans-serif; --font-mono: "JetBrains Mono Variable", ui-monospace, Menlo, monospace`. В `@theme inline`: `--color-brand-bg`, `--color-brand-surface`, `--color-brand-card`, `--color-brand-cyan`, `--color-brand-blue`, `--color-brand-violet`, `--color-brand-text`, `--color-brand-muted`, `--color-brand-dim`, `--color-brand-ok`, `--color-brand-warn`, `--font-sans`, `--font-mono` (классы `bg-brand-bg`, `text-brand-muted`, `font-mono` и т.д.).
- `index.html`: `<title>GameCrate — облачный гейминг</title>`, `<meta name="description" content="Твоя библиотека Steam на облачной видеокарте. В браузере, на ПК или с телефона — без установки и без мощного железа.">`, `<meta name="theme-color" content="#05060f">`, `og:title` = title, `og:description` = description, `og:type` = `website`. Фавиконки подключаются в Task 4.

- [ ] **Step 1: тест**
  ```ts
  // apps/web/test/branding.test.ts
  const html = await Bun.file(new URL("../src/index.html", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  it("index.html is titled GameCrate", () => { expect(html).toContain("<title>GameCrate — облачный гейминг</title>"); expect(html).toContain('name="theme-color" content="#05060f"'); });
  it("styles import self-hosted fonts and brand tokens", () => {
    expect(css).toContain('@import "@fontsource-variable/inter"'); expect(css).toContain('@import "@fontsource-variable/jetbrains-mono"');
    expect(css).toContain("--brand-cyan: #3cc2ff"); expect(css).toContain("--color-brand-cyan: var(--brand-cyan)"); expect(css).not.toContain("googleapis");
  });
  ```
- [ ] **Step 2:** `bun run --cwd apps/web test test/branding.test.ts` — Expected: FAIL (нет title/переменных).
- [ ] **Step 3:** `cd apps/web && bun add @fontsource-variable/inter@5.3.0 @fontsource-variable/jetbrains-mono@5.3.0` (exact по bunfig). В `styles.css` после `@import "tw-animate-css"` — импорты шрифтов, переменные в `:root`, регистрация в `@theme inline`, `body { font-family: var(--font-sans) }`. В `index.html` — title и meta.
- [ ] **Step 4:** тест PASS; `bun run check && bun run lint`; `bun run --cwd apps/web build` — в `dist/` есть `.woff2` файлы Inter.
- [ ] **Step 5:** Commit `feat(web): GameCrate name, self-hosted fonts and brand tokens`.

---

### Task 2: Геометрия логотипа (чистая)

**Files:**
- Create: `apps/web/src/components/brand/logo-geometry.ts`
- Test: `apps/web/test/logoGeometry.test.ts`

**Interfaces:**
- Produces (числа — из `logo-morph.html`, `buildLogo`):
  ```ts
  export type Matrix = readonly [number, number, number, number, number, number];
  export const LEFT_FACE: Matrix = [0.866, 0.5, 0, 1, 13.4, 60];
  export const RIGHT_FACE: Matrix = [0.866, -0.5, 0, 1, 100, 110];
  export const G_POINTS: ReadonlyArray<readonly [number, number]> // [[0,0],[100,0],[100,24],[24,24],[24,76],[76,76],[76,62],[50,62],[50,40],[100,40],[100,100],[0,100]]
  export const C_POINTS // [[0,0],[100,0],[100,24],[24,24],[24,76],[100,76],[100,100],[0,100]]
  export const TOP_RING // [[13.4,60],[100,10],[186.6,60],[166.9,71.4],[100,32.75],[33.1,71.4]]
  export const TOP_ROOF // [[13.4,60],[100,10],[186.6,60],[166.0,70.9],[100,32.8],[34.0,70.9]]
  export const LEFT_BAND = "13.4,60 33.1,71.4 33.1,148.6 100,187.25 100,210 13.4,160";
  export const RIGHT_BAND = "186.6,60 186.6,160 100,210 100,187.25 166.9,148.6 166.9,71.4";
  export const SEAMS = "M100 110L13.4 60M100 110L186.6 60M100 110L100 210";
  export const MARK_WIDTH = 200, BOX_HEIGHT = 220, WORD_X = 232, BASELINE_Y = 146, CAP_HEIGHT = 70, LETTER_GAP = 5, C_WIDTH = 0.86, FONT_SIZE = 96, TAG_FONT_SIZE = 30, TAG_Y = 190;
  export const DEFAULT_METRICS: LogoMetrics = { ameWidth: 166, rateWidth: 188 }; // до измерения шрифта
  export type LogoMetrics = { ameWidth: number; rateWidth: number };
  export const multiply = (a: Matrix, b: Matrix): Matrix; export const translate = (x: number, y: number): Matrix; export const scale = (k: number): Matrix;
  export const lerpMatrix = (a: Matrix, b: Matrix, t: number): Matrix; export const matrixString = (m: Matrix): string; // "matrix(a b c d e f)" с 4 знаками
  export const easeInOut = (p: number): number; // p<0.5 ? 2p² : 1-(-2p+2)²/2
  export const polygonPath = (points: ReadonlyArray<readonly [number, number]>): string; // "M… L… Z", без скруглений
  export const fullWidth = (m: LogoMetrics): number; // WORD_X + CAP + GAP + ame + GAP + CAP*C_WIDTH + GAP + rate + 8
  export type LogoFrame = {
    viewBoxWidth: number; gTransform: string; cTransform: string; gPath: string; cPath: string;
    topPoints: string; topSeamPath: string; bandOpacity: number;
    ame: { x: number; y: number; opacity: number }; rate: { x: number; y: number; opacity: number }; tag: { x: number; y: number; opacity: number };
  };
  export const logoFrame = (progress: number, metrics: LogoMetrics): LogoFrame;
  ```
  Правила `logoFrame` (e = `easeInOut(clamp(progress))`, k = `CAP_HEIGHT/100`): `xG = WORD_X`, `xAme = xG+CAP+GAP`, `xC = xAme+ame+GAP`, `xRate = xC+CAP*C_WIDTH+GAP`; `gTransform = lerp(T(xG, BASELINE_Y−CAP)·S(k), LEFT_FACE·T(2.5,2.5)·S(0.95), e)`; `cTransform = lerp(T(xC, BASELINE_Y−CAP)·[k·C_WIDTH,0,0,k,0,0], RIGHT_FACE·T(2.5,2.5)·S(0.95), e)`; `bandOpacity = 1−clamp((e−0.45)/0.45)`; `topPoints` — повершинная линейная интерполяция `TOP_RING→TOP_ROOF` по `e`, формат `"x,y x,y …"` с 2 знаками; `topSeamPath = "M100 10L<x5> <y5>"` (пятая вершина); `ame/rate`: `x − 60e`, `y = BASELINE_Y`, `opacity = clamp(1−1.6e)`; `tag`: `x = WORD_X − 60e`, `y = TAG_Y`, та же opacity; `viewBoxWidth = MARK_WIDTH + (fullWidth − MARK_WIDTH)(1−e)`.

- [ ] **Step 1: тесты**
  ```ts
  it("frame at 0 places letters in the wordmark", () => { const f = logoFrame(0, DEFAULT_METRICS); expect(f.viewBoxWidth).toBe(fullWidth(DEFAULT_METRICS)); expect(f.gTransform).toBe(matrixString(multiply(translate(232, 76), scale(0.7)))); expect(f.bandOpacity).toBe(1); expect(f.ame.opacity).toBe(1); expect(f.topPoints).toBe("13.40,60.00 100.00,10.00 186.60,60.00 166.90,71.40 100.00,32.75 33.10,71.40"); });
  it("frame at 1 places letters on the cube faces", () => { const f = logoFrame(1, DEFAULT_METRICS); expect(f.viewBoxWidth).toBe(200); expect(f.gTransform).toBe(matrixString(multiply(LEFT_FACE, multiply(translate(2.5, 2.5), scale(0.95))))); expect(f.cTransform).toBe(matrixString(multiply(RIGHT_FACE, multiply(translate(2.5, 2.5), scale(0.95))))); expect(f.bandOpacity).toBe(0); expect(f.ame.opacity).toBe(0); expect(f.topSeamPath).toBe("M100 10L100.00 32.80"); });
  it("frame in between is in between", () => { const f = logoFrame(0.5, DEFAULT_METRICS); expect(f.viewBoxWidth).toBeGreaterThan(200); expect(f.viewBoxWidth).toBeLessThan(fullWidth(DEFAULT_METRICS)); expect(f.bandOpacity).toBeGreaterThan(0); expect(f.bandOpacity).toBeLessThan(1); });
  it("polygonPath closes the polygon", () => { expect(polygonPath(C_POINTS)).toBe("M0 0L100 0L100 24L24 24L24 76L100 76L100 100L0 100Z"); });
  it("easeInOut is symmetric", () => { expect(easeInOut(0)).toBe(0); expect(easeInOut(0.5)).toBe(0.5); expect(easeInOut(1)).toBe(1); });
  ```
- [ ] **Step 2:** `bun run --cwd apps/web test test/logoGeometry.test.ts` — FAIL (модуля нет).
- [ ] **Step 3:** Реализовать `logo-geometry.ts` по интерфейсу.
- [ ] **Step 4:** тест PASS; `bun run check && bun run lint`.
- [ ] **Step 5:** Commit `feat(web): logo geometry`.

---

### Task 3: Компонент `Logo` и прогресс по скроллу

**Files:**
- Create: `apps/web/src/components/brand/Logo.tsx`, `apps/web/src/components/brand/useScrollProgress.ts`, `apps/web/src/lib/usePrefersReducedMotion.ts`
- Test: `apps/web/test/logo.test.tsx`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  ```ts
  export type LogoProps = { progress?: number /* 0..1, default 0 */; height?: number /* px, default 36 */; iconOnly?: boolean; light?: boolean; metrics?: LogoMetrics /* пропустить измерение */; className?: string; title?: string /* aria-label, default "GameCrate" */ };
  export function Logo(props: LogoProps): JSX.Element;
  export function usePrefersReducedMotion(): boolean; // matchMedia("(prefers-reduced-motion: reduce)"), подписка на change; без matchMedia → false
  export function useScrollProgress(start = 20, span = 140): number; // target = clamp((scrollY−start)/span); сглаживание p += (target−p)*0.14 в rAF, стоп при |target−p|<0.0005; при reduced motion p = target>0.5 ? 1 : 0 без rAF
  ```
  Разметка `Logo`: `<svg role="img" aria-label viewBox="0 0 {viewBoxWidth} 220" height width={viewBoxWidth*height/220} font-weight="800" style={{color: light ? "#0b0e1f" : "#f3f4ff"}}>` с `<defs>`: градиент знака (userSpaceOnUse 30,20→180,210), градиенты букв (G: `#3cc2ff→#3a6cff`, C: `#3f7aff→#5b2fff`, objectBoundingBox 0,0→1,1), `<mask>` (верх `topPoints`, левая/правая полосы с `bandOpacity`, швы `SEAMS` и `topSeamPath` чёрным, `stroke-width 5`); группа под маской: прямоугольник 200×220 с градиентом, затемнения левой грани `.10` и правой `.26`; `<path>` G и C с `transform`; при `!iconOnly` — `<text class="ame">`, `<text class="rate">`, `<text>` слогана (`font-size 30`, `font-weight 500`, fill `light ? "#5c6089" : "#8b90b8"`) с `font-family: var(--font-sans)`. При `iconOnly` `viewBoxWidth = 200` всегда. Уникальные id `useId()`. Измерение: если `metrics` не передан — после монтирования и после `document.fonts.ready` вызвать `getComputedTextLength()` у `ame`/`rate` (если функции нет или результат 0 — оставить `DEFAULT_METRICS`).

- [ ] **Step 1: тесты**
  ```tsx
  it("logo renders full lockup at progress 0", () => { render(<Logo progress={0} metrics={DEFAULT_METRICS} />); const svg = screen.getByRole("img", { name: "GameCrate" }); expect(svg.getAttribute("viewBox")).toBe(`0 0 ${fullWidth(DEFAULT_METRICS)} 220`); expect(svg.textContent).toContain("ame"); expect(svg.textContent).toContain("Games in containers"); });
  it("logo renders compact mark at progress 1", () => { render(<Logo progress={1} metrics={DEFAULT_METRICS} />); expect(screen.getByRole("img").getAttribute("viewBox")).toBe("0 0 200 220"); });
  it("iconOnly never shows the wordmark", () => { render(<Logo iconOnly />); const svg = screen.getByRole("img"); expect(svg.getAttribute("viewBox")).toBe("0 0 200 220"); expect(svg.textContent).not.toContain("ame"); });
  it("scroll progress snaps when motion is reduced", async () => { window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as never; const { result } = renderHook(() => useScrollProgress()); act(() => { Object.defineProperty(window, "scrollY", { value: 300, configurable: true }); window.dispatchEvent(new Event("scroll")); }); await waitFor(() => expect(result.current).toBe(1)); });
  it("scroll progress eases toward the target", async () => { window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as never; const { result } = renderHook(() => useScrollProgress()); act(() => { Object.defineProperty(window, "scrollY", { value: 90, configurable: true }); window.dispatchEvent(new Event("scroll")); }); await waitFor(() => expect(result.current).toBeCloseTo(0.5, 1)); });
  ```
- [ ] **Step 2:** `bun run --cwd apps/web test test/logo.test.tsx` — FAIL.
- [ ] **Step 3:** Реализовать `usePrefersReducedMotion`, `useScrollProgress`, `Logo`.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`.
- [ ] **Step 5:** Commit `feat(web): Logo component with scroll morph`.

---

### Task 4: Статические ассеты, фавиконки, шапка приложения

**Files:**
- Create: `apps/web/scripts/brand-assets.ts`, `apps/web/src/assets/brand/{logo-full.svg,logo-full-light.svg,logo-mark.svg,favicon.svg,apple-touch-icon.png,icon-512.png}`
- Modify: `apps/web/package.json` (devDependency `@resvg/resvg-js@2.6.2`, script `"brand-assets": "bun scripts/brand-assets.ts"`, `lint` добавить `scripts`), `apps/web/src/index.html`, `apps/web/src/components/AppHeader.tsx`
- Test: `apps/web/test/branding.test.ts` (дополнить)

**Interfaces:**
- Consumes: `Logo`, `DEFAULT_METRICS` (Task 2–3).
- Produces: скрипт рендерит `renderToStaticMarkup(<Logo … metrics={DEFAULT_METRICS} />)` (из `react-dom/server`), добавляет `xmlns="http://www.w3.org/2000/svg"`, пишет: `logo-full.svg` (`progress 0, height 220`), `logo-full-light.svg` (`light`), `logo-mark.svg` (`progress 1, iconOnly`), `favicon.svg` (`progress 0, iconOnly`); PNG через `Resvg(svgMark).render().asPng()` — `apple-touch-icon.png` 180×180 (из `logo-mark.svg` на фоне `#05060f`, отступ 12%), `icon-512.png` 512×512 так же. `index.html`: `<link rel="icon" type="image/svg+xml" href="./assets/brand/favicon.svg">`, `<link rel="apple-touch-icon" href="./assets/brand/apple-touch-icon.png">`. `AppHeader`: вместо `Gamepad2` + «Облачный гейминг» — `<Logo iconOnly height={28} />` + `<span class="hidden sm:inline">GameCrate</span>`.

- [ ] **Step 1: тесты (в `branding.test.ts`)**
  ```ts
  it("brand assets exist and are svg", async () => { for (const f of ["logo-full.svg","logo-full-light.svg","logo-mark.svg","favicon.svg"]) { const text = await Bun.file(new URL(`../src/assets/brand/${f}`, import.meta.url)).text(); expect(text.startsWith("<svg")).toBe(true); expect(text).toContain('xmlns="http://www.w3.org/2000/svg"'); } expect(await Bun.file(new URL("../src/assets/brand/apple-touch-icon.png", import.meta.url)).exists()).toBe(true); });
  it("index.html links the favicon", () => { expect(html).toContain('href="./assets/brand/favicon.svg"'); expect(html).toContain('rel="apple-touch-icon"'); });
  it("app header shows GameCrate", async () => { render(<RouterProvider router={testRouter(<AppHeader user={undefined} />)} />); expect(await screen.findByText("GameCrate")).toBeTruthy(); expect(screen.getByRole("img", { name: "GameCrate" })).toBeTruthy(); });
  ```
  `testRouter(element)` — хелпер в `apps/web/test/router.tsx` (создать в этой задаче): `const root = createRootRoute({ component: () => element }); return createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });` (`createRootRoute`, `createRouter`, `createMemoryHistory`, `RouterProvider` из `@tanstack/react-router`). `AppHeader` рендерит `Link`, поэтому без роутера не монтируется.
- [ ] **Step 2:** тест FAIL.
- [ ] **Step 3:** `bun add -d @resvg/resvg-js@2.6.2`; написать скрипт; `bun run brand-assets`; подключить фавиконки; заменить шапку.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`; `bun run --cwd apps/web build` — в выводе есть `favicon.svg` и `apple-touch-icon.png` (Bun копирует ассеты из `<link href>`); если не копирует — импортировать пути в `main.tsx` через `import favicon from "./assets/brand/favicon.svg"` и ставить `<link>` из кода.
- [ ] **Step 5:** Commit `feat(web): brand assets, favicon and GameCrate header`.

---

### Task 5: Вход через Steam, шапка лендинга, каркас страницы и маршрут

**Files:**
- Create: `apps/web/src/lib/useSteamLogin.ts`, `apps/web/src/components/landing/SteamButton.tsx`, `LandingNav.tsx`, `LandingPage.tsx`, `FinalCta.tsx`, `LandingFooter.tsx`, `data.ts`
- Modify: `apps/web/src/routes/index.tsx` (`Landing` → `LandingPage`, `SteamIcon` переезжает в `SteamButton`)
- Test: `apps/web/test/landing.test.tsx`

**Interfaces:**
- Consumes: `Logo`, `useScrollProgress` (Task 3), `signInWithSteam` из `@/auth`.
- Produces:
  ```ts
  export const steamLoginFailed = "Не удалось войти через Steam. Попробуйте ещё раз.";
  export function useSteamLogin(): { login: () => void; pending: boolean }; // как в текущем Landing: pending на время запроса, при ошибке toast.error(steamLoginFailed), pending=false
  export function SteamButton({ variant, children }: { variant: "primary" | "ghost"; children?: ReactNode }): JSX.Element; // кнопка shadcn; при pending — LoaderCircle animate-spin и disabled; primary = бренд-градиент; ghost = полупрозрачная с иконкой Steam; текст по умолчанию «Играть» для primary, «Войти через Steam» для ghost
  export function LandingNav(): JSX.Element; // fixed; класс "solid" (фон rgba(5,6,15,0.7) + backdrop-blur + border-b) при scrollY>40; <Logo progress={useScrollProgress()} height={32} />; якоря #tech «Технология», #how «Как работает», #plans «Тарифы», #ach «Ачивки», #faq «FAQ» (скрыты < 860px: класс `hidden min-[860px]:flex`); справа <SteamButton variant="ghost" />
  export function LandingPage({ error }: { error: boolean }): JSX.Element; // <LandingNav/> + секции по порядку; пока секций нет — hero-заглушка с h1 «Любая игра. Где угодно. Прямо сейчас.», текст ошибки при error, <SteamButton variant="primary" />
  export function FinalCta(): JSX.Element; // «Твои игры ждут.», «Войди через Steam и выбери, во что сегодня.», SteamButton primary «Играть»
  export function LandingFooter(): JSX.Element; // <Logo iconOnly height={22}/> «GameCrate · Games in containers», «© 2026 GameCrate. Steam является торговой маркой Valve Corporation.»
  ```
  `data.ts` в этой задаче: `export const platforms = ["Браузер", "Windows · macOS", "Android · iOS"]`.
  `index.tsx`: `IndexPage` не меняется, кроме `return <LandingPage error={error !== undefined} />`.

- [ ] **Step 1: тесты**
  ```tsx
  // apps/web/test/landing.test.tsx
  const signIn = mock(async () => ({ error: undefined }));
  mock.module("../src/auth", () => ({ signInWithSteam: signIn, signOut: async () => {}, signInWithPocketId: async () => {} }));
  it("landing renders headline, nav anchors and footer", () => { render(<LandingPage error={false} />); expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Любая игра. Где угодно. Прямо сейчас."); for (const [href, name] of [["#tech","Технология"],["#how","Как работает"],["#plans","Тарифы"],["#ach","Ачивки"],["#faq","FAQ"]]) expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href); expect(screen.getByText(/торговой маркой Valve/)).toBeTruthy(); });
  it("play button starts steam login and shows pending", async () => { render(<LandingPage error={false} />); const play = screen.getAllByRole("button", { name: "Играть" })[0]; fireEvent.click(play); expect(signIn).toHaveBeenCalledTimes(1); expect((play as HTMLButtonElement).disabled).toBe(true); });
  it("landing shows steam error from query", () => { render(<LandingPage error />); expect(screen.getAllByText(steamLoginFailed).length).toBeGreaterThan(0); });
  it("index redirects signed-in user to library", () => { expect(indexView(AsyncResult.success(user), false)).toBe("library"); expect(indexView(AsyncResult.failure(new Unauthorized()), false)).toBe("landing"); expect(indexView(AsyncResult.failure(new Error("boom")), false)).toBe("unreachable"); expect(indexView(AsyncResult.initial(), true)).toBe("unreachable"); expect(indexView(AsyncResult.initial(), false)).toBe("loading"); });
  ```
  Для последнего теста из `index.tsx` экспортируется чистая функция `indexView(me: AsyncResult<CurrentUserShape, unknown>, stalled: boolean): "library" | "landing" | "unreachable" | "loading"` — та же логика, что сейчас в `IndexPage` (`Success` → library; `resultErrorTag(me) === "Unauthorized"` → landing; другая ошибка или `stalled` → unreachable; иначе loading), и `IndexPage` переключается по её результату. `Unauthorized` — ошибка из `@cg/rpc`, которую `resultErrorTag` распознаёт по `_tag`; `user` — любой объект формы `CurrentUserShape`; `AsyncResult` — из `effect/reactivity`.
- [ ] **Step 2:** тесты FAIL.
- [ ] **Step 3:** Реализовать файлы; в `index.tsx` вынести выбор экрана в `indexView` и использовать в `IndexPage`.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`; `bun run --cwd apps/web dev` и открыть `/` — шапка, заглушка hero, вход через Steam ведёт на steamcommunity.com.
- [ ] **Step 5:** Commit `feat(web): landing shell, nav and steam login`.

---

### Task 6: Хук canvas-цикла

**Files:**
- Create: `apps/web/src/lib/useCanvasLoop.ts`
- Test: `apps/web/test/canvasLoop.test.tsx`

**Interfaces:**
- Consumes: `usePrefersReducedMotion` (Task 3).
- Produces:
  ```ts
  export type CanvasSize = { width: number; height: number }; // CSS px
  export type DrawFrame = (ctx: CanvasRenderingContext2D, size: CanvasSize, time: number) => void;
  export function useCanvasLoop(canvasRef: RefObject<HTMLCanvasElement | null>, draw: DrawFrame): void;
  ```
  Поведение: размер canvas = bbox родителя × `devicePixelRatio`, `ctx.setTransform(dpr,0,0,dpr,0,0)`, пересчёт на `resize`; `IntersectionObserver(threshold 0.05)` на родителе — рисуем только пока виден (если `IntersectionObserver` нет — считаем видимым); `getContext("2d")` вернул `null` — ничего не делаем; при reduced motion — один кадр после размера и после каждого `resize`, без rAF; при размонтировании — `cancelAnimationFrame`, отписки. `draw` берётся из ref, чтобы не перезапускать цикл при каждом рендере.

- [ ] **Step 1: тесты**
  ```tsx
  function Probe({ draw }: { draw: DrawFrame }) { const ref = useRef<HTMLCanvasElement>(null); useCanvasLoop(ref, draw); return <div style={{ width: 300, height: 100 }}><canvas ref={ref} /></div>; }
  it("canvas loop is a no-op without a 2d context", () => { HTMLCanvasElement.prototype.getContext = () => null as never; const draw = mock(() => {}); render(<Probe draw={draw} />); expect(draw).not.toHaveBeenCalled(); });
  it("canvas loop draws once when motion is reduced", async () => { window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as never; HTMLCanvasElement.prototype.getContext = () => fakeCtx as never; const draw = mock(() => {}); render(<Probe draw={draw} />); await waitFor(() => expect(draw).toHaveBeenCalledTimes(1)); await new Promise(r => setTimeout(r, 50)); expect(draw).toHaveBeenCalledTimes(1); });
  it("canvas loop keeps drawing when motion is allowed", async () => { window.matchMedia = () => ({ matches: false, … }); const draw = mock(() => {}); render(<Probe draw={draw} />); await waitFor(() => expect(draw.mock.calls.length).toBeGreaterThan(2)); });
  ```
  `fakeCtx` — объект с no-op методами `setTransform`, `clearRect` (`{ setTransform() {}, clearRect() {} }`); при отсутствии `IntersectionObserver` в happy-dom хук считает canvas видимым.
- [ ] **Step 2:** тест FAIL.
- [ ] **Step 3:** Реализовать хук.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`.
- [ ] **Step 5:** Commit `feat(web): useCanvasLoop`.

---

### Task 7: Стена обложек и hero

**Files:**
- Create: `apps/web/src/lib/coverWallPhysics.ts`, `apps/web/src/components/landing/CoverWall.tsx`, `apps/web/src/components/landing/Hero.tsx`
- Modify: `apps/web/src/components/landing/data.ts` (`heroAppIds`, `perks`), `LandingPage.tsx` (заглушка → `Hero`), `apps/web/src/styles.css` (keyframes не нужны; класс стены — Tailwind arbitrary `[transform:perspective(1400px)_rotateX(18deg)_rotateZ(-8deg)_scale(1.08)]`)
- Test: `apps/web/test/coverWallPhysics.test.ts`, `apps/web/test/landingSections.test.tsx`

**Interfaces:**
- Consumes: `usePrefersReducedMotion`, `SteamButton`, `platforms`.
- Produces:
  ```ts
  // coverWallPhysics.ts
  export type RowMotion = { x: number; v: number; base: number };
  export const BRAKE_RATE = 3.5, RESUME_RATE = 1.2; // 1/с
  export const rowBaseSpeed = (i: number): number => (i % 2 ? 1 : -1) * (26 + 5 * i); // px/с
  export const initialRows = (count: number): RowMotion[];
  export const stepRows = (rows: ReadonlyArray<RowMotion>, held: number | null, dt: number, halfWidth: (i: number) => number): RowMotion[];
  // v += (target − v) · min(1, dt·k), target = held===i ? 0 : base, k = held===i ? BRAKE_RATE : RESUME_RATE; x += v·dt; x заворачивается в (−half, 0]
  // data.ts
  export const heroAppIds: ReadonlyArray<number> = [1091500,1245620,1145350,1086940,413150,367520,1030300,570,730,105600,427520,374320,620,292030,504230,220,646570,294100,632470,753640,526870,892970,548430,2379780,271590,1174180,814380,1172470,1623730,553850,1966720,2358720,2246340,2767030,3164500,1771300,2001120,1903340,3017860,3241660];
  export const coverUrl = (appId: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
  export const headerUrl = (appId: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
  export const perks: ReadonlyArray<{ icon: LucideIcon; title: string; text: string }> // 6 штук: «До 4K · 60 FPS» / «Картинка как на топовом ПК», «Старт за секунды» / «Без скачивания и патчей», «Прогресс в Steam Cloud» / «Сейвы живут в твоём аккаунте», «Вся библиотека» / «Не каталог, а твои игры», «Любой ввод» / «Геймпад, клава и мышь», «С любого экрана» / «Начал на ПК, продолжил с телефона»
  // CoverWall.tsx
  export function CoverWall({ rows = 5, perRow = 12 }: { rows?: number; perRow?: number }): JSX.Element;
  // Hero.tsx
  export function Hero({ error }: { error: boolean }): JSX.Element;
  ```
  `CoverWall`: ряд `i` содержит `perRow` обложек `heroAppIds[(i*7 + j*3) % length]`, продублированных для петли; `<img loading="lazy" decoding="async" alt="">`, `onLoad` → класс видимости (`opacity-100`), `onError` → один раз сменить `src` на `headerUrl`, второй раз — оставить тёмную плитку (`data-failed`). Ряды `data-row={i}`; `transform: translateX(x)` из rAF-цикла `stepRows` (dt ограничен 0.05 с); ряд под курсором — `document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-row]")` по `mousemove` на секции, `mouseleave` → `null`; удерживаемый ряд получает класс `hold` (обложки `-translate-y-1`, обводка `ring-1 ring-brand-cyan/35`, тень). Цикл идёт только пока секция видна (`IntersectionObserver`); при reduced motion цикл не стартует. Затемнение (`pointer-events-none`): радиальный градиент слева + вертикальный. Слой текста hero — `pointer-events-none`, кнопки — `pointer-events-auto`.
  `Hero`: `<header id="top">` с `CoverWall`, затемнением, чипами платформ, `h1` «Любая игра.<br/>Где <span class="g">угодно</span>.<br/>Прямо сейчас.» (`clamp(42px, 6.6vw, 86px)`), лид «Твоя библиотека Steam на облачной видеокарте. В браузере, на ПК или с телефона — без установки и без мощного железа.», при `error` — текст `steamLoginFailed`, `<SteamButton variant="primary">Играть</SteamButton>`, сетка плюсов (6 → 3 при < 1000px → 2 при < 600px).

- [ ] **Step 1: тесты**
  ```ts
  // coverWallPhysics.test.ts
  it("held row brakes toward zero, others keep base speed", () => { const rows = initialRows(5); const next = stepRows(rows, 2, 0.1, () => 1000); expect(Math.abs(next[2].v)).toBeLessThan(Math.abs(rows[2].v)); expect(next[0].v).toBe(rows[0].base); });
  it("released row resumes toward base speed", () => { const rows = initialRows(3).map((r, i) => (i === 1 ? { ...r, v: 0 } : r)); const next = stepRows(rows, null, 0.1, () => 1000); expect(Math.abs(next[1].v)).toBeGreaterThan(0); expect(Math.abs(next[1].v)).toBeLessThan(Math.abs(next[1].base)); });
  it("position wraps within half width", () => { const rows = [{ x: -999, v: -50, base: -50 }]; expect(stepRows(rows, null, 0.05, () => 1000)[0].x).toBeGreaterThan(-1000); const fwd = [{ x: -1, v: 50, base: 50 }]; expect(stepRows(fwd, null, 0.05, () => 1000)[0].x).toBeLessThanOrEqual(0); });
  it("without hover every row keeps its base speed", () => { const rows = initialRows(5); const next = stepRows(rows, null, 0.5, () => 1000); next.forEach((r, i) => expect(r.v).toBe(rowBaseSpeed(i))); });
  // landingSections.test.tsx
  it("cover falls back to header.jpg once, then stays dark", () => { render(<CoverWall rows={1} perRow={1} />); const img = document.querySelector("img")!; fireEvent.error(img); expect(img.getAttribute("src")).toBe(headerUrl(heroAppIds[0])); fireEvent.error(img); expect(img.getAttribute("src")).toBe(headerUrl(heroAppIds[0])); expect(img.closest("[data-failed]")).toBeTruthy(); });
  it("rows do not drift when motion is reduced", async () => { window.matchMedia = () => ({ matches: true, … }); render(<CoverWall rows={2} perRow={2} />); await new Promise(r => setTimeout(r, 60)); document.querySelectorAll<HTMLElement>("[data-row]").forEach(row => expect(row.style.transform).toBe("")); });
  it("hero renders platforms, perks and play button", () => { render(<Hero error={false} />); for (const p of platforms) expect(screen.getByText(p)).toBeTruthy(); expect(screen.getByText("До 4K · 60 FPS")).toBeTruthy(); expect(screen.getByRole("button", { name: "Играть" })).toBeTruthy(); expect(document.body.textContent).not.toMatch(/бесплатно|4090/); });
  ```
- [ ] **Step 2:** тесты FAIL.
- [ ] **Step 3:** Реализовать физику, `CoverWall`, `Hero`, данные; подключить в `LandingPage`.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`; в dev-сервере: ряды едут, ряд под курсором останавливается и подсвечивается, при уходе курсора разгоняется.
- [ ] **Step 5:** Commit `feat(web): hero with drifting cover wall`.

---

### Task 8: Секция «Технология»: поток частиц и HUD

**Files:**
- Create: `apps/web/src/components/landing/TechFlow.tsx`, `apps/web/src/components/landing/Hud.tsx`
- Modify: `data.ts` (`techNotes`), `LandingPage.tsx`
- Test: `apps/web/test/landingSections.test.tsx` (дополнить)

**Interfaces:**
- Consumes: `useCanvasLoop` (Task 6).
- Produces:
  ```ts
  export function TechFlow(): JSX.Element; // <section id="tech">: заголовок «GPU там. Игра здесь.» («Игра здесь.» градиентом), лид из прототипа, canvas-сцена высотой 560 (460 при < 860px) без рамки, подписи «Дата-центр / контейнеры с играми на серверах с GPU» и «Твоё устройство / здесь будет живое видео стрима», подпись справа внизу «частицы тянутся к курсору», <Hud/> слева сверху, под canvas три заметки techNotes
  export function Hud(): JSX.Element; // 4 строки FPS / FRAMETIME / LATENCY / BITRATE: моноширинный ключ, значение, mini-canvas 110×22 (ряд из 60 точек, линия + заливка 13% цвета); цвета: FPS #3ddc97, FRAMETIME и LATENCY #3cc2ff, BITRATE #ffd166; обновление раз в 120 мс: fps = 58 + round(rand·2.4), frametime = 1000/fps ± 0.5 («16.6 ms»), latency = 12 + rand·4 (+ до 6 при курсоре рядом с центром — через проп `cursorBoost?: number`), bitrate = 34 + rand·7 («38 Mbps»); под HUD подпись «иллюстрация» (text-brand-dim, 11px)
  export const techNotes: ReadonlyArray<{ title: string; text: string }> // «Контейнер на игру», «Видео вместо игры», «Сервера рядом» с текстами из прототипа
  ```
  Сцена (`drawTechFlow(ctx, size, t, cursor)` внутри `TechFlow.tsx`, курсор — ref `{x,y,inside}` из `mousemove`/`mouseleave` на секции): точки `A = (0.22W, 0.56H)` (0.2W при W<760), `B = (0.72W, 0.56H)`, контрольная `(A+B)/2, Ay−120`; луч шириной 110 `rgba(60,120,255,0.06)`; 600 частиц `{p, off∈[−60,60], sp∈[0.0016,0.0038], col из палитры [[60,194,255],[58,108,255],[91,47,255],[140,90,255],[40,160,240]], sz∈[1.5,4], dx, dy}` — позиция на кривой + нормальное смещение `off·sin(πu)`, притяжение к курсору в радиусе 220 (`f=(1−d/220)·0.9`, `dx += ddx/d·f·3`, затухание 0.93, при `p>1` сброс `dx=dy=0`), вспышка `near = max(0, 1−d/120)` → ярче и крупнее; слева 3×3 стопки изометрических кубиков (сторона 24, 16 при узком; высота стопки `1+((i*3+j)%3)`, цвета по кругу из палитры, пульс `0.75+0.25·sin(t/600+i+j+k)`) и голубое свечение; справа ноутбук `300×188` (`180×112` узкий) с «игрой» (hsl-градиент `t/50`, 7 плывущих квадратиков) и оверлеем `60 FPS · 14 ms`, подставка, рядом телефон; подписи позиционируются по `A`/`B` через state.

- [ ] **Step 1: тесты**
  ```tsx
  it("tech section renders text without canvas", () => { HTMLCanvasElement.prototype.getContext = () => null as never; render(<TechFlow />); expect(screen.getByRole("heading", { name: /GPU там/ })).toBeTruthy(); expect(screen.getByText("иллюстрация")).toBeTruthy(); for (const k of ["FPS","FRAMETIME","LATENCY","BITRATE"]) expect(screen.getByText(k)).toBeTruthy(); for (const n of techNotes) expect(screen.getByText(n.title)).toBeTruthy(); });
  it("hud updates values over time", async () => { render(<Hud />); const first = screen.getByText(/Mbps/).textContent; await waitFor(() => expect(screen.getByText(/Mbps/).textContent).not.toBe(first), { timeout: 1500 }); });
  ```
  (во втором тесте `Hud` рисует sparkline только при наличии контекста — без него только обновляет текст.)
- [ ] **Step 2:** тесты FAIL.
- [ ] **Step 3:** Реализовать `Hud`, `TechFlow`, `techNotes`; подключить в `LandingPage` после `Hero`.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`; в dev: частицы тянутся к курсору, кривая не двигается, HUD-графики растут.
- [ ] **Step 5:** Commit `feat(web): tech section with particle flow and HUD`.

---

### Task 9: «Как это работает» — расписание и анимированное демо

**Files:**
- Create: `apps/web/src/lib/howItWorksTimeline.ts`, `apps/web/src/components/landing/HowItWorks.tsx`
- Modify: `data.ts` (`steps`, `demoAppIds`), `LandingPage.tsx`, `styles.css` (keyframes `gc-scan` — линия сканирования 0→92% top за 1.6 с ease-in-out infinite alternate; `gc-fill` — width 0→100%; `gc-ripple` — scale 1→7, opacity 1→0 за 0.7 с; `gc-game` — background-position 0%→100%→0% за 6 с)
- Test: `apps/web/test/howItWorksTimeline.test.ts`, `landingSections.test.tsx` (дополнить)

**Interfaces:**
- Consumes: `usePrefersReducedMotion`, `coverUrl`.
- Produces:
  ```ts
  export type DemoPhase = 0 | 1 | 2;
  export const PHASE_DURATION_MS: Readonly<Record<DemoPhase, number>> = { 0: 4200, 1: 4600, 2: 5000 };
  export type DemoCue = "linked" | "cursor-tile" | "tile-hot" | "cursor-play" | "click" | "tile-cool" | "boot-gpu" | "boot-stream" | "playing";
  export const PHASE_CUES: Readonly<Record<DemoPhase, ReadonlyArray<{ at: number; cue: DemoCue }>>> = { 0: [{ at: 2600, cue: "linked" }], 1: [{ at: 300, cue: "cursor-tile" }, { at: 1300, cue: "tile-hot" }, { at: 1900, cue: "cursor-play" }, { at: 2800, cue: "click" }, { at: 3100, cue: "tile-cool" }], 2: [{ at: 900, cue: "boot-gpu" }, { at: 1500, cue: "boot-stream" }, { at: 2000, cue: "playing" }] };
  export const nextPhase = (p: DemoPhase): DemoPhase; // 0→1→2→0
  export const steps: ReadonlyArray<{ title: string; text: string }> // «Привяжи Steam» / «Один раз отсканируй QR в приложении Steam. Пароль нам не нужен.», «Выбери игру» / «Вся твоя библиотека с отметкой «запустится / проверь».», «Нажми Играть» / «Контейнер поднимается, стрим стартует. Дальше — как на своём ПК.»
  export const demoAppIds = [1245620,1086940,1091500,1030300,2767030,553850,2358720,413150,892970,2379780,1903340,105600];
  export function HowItWorks(): JSX.Element; // <section id="how">, заголовок «От входа до игры за три клика»
  ```
  Компонент: состояние `{ phase, cues: Set<DemoCue>, run }`; при входе секции в экран (IntersectionObserver 0.3) стартует `phase 0`; на каждую фазу ставятся `setTimeout` по `PHASE_CUES` и один на `PHASE_DURATION_MS` → `nextPhase`; клик по шагу → эта фаза с нуля (старые таймеры очищаются, `run++`). Слева шаги (`data-active` на текущем, прогресс-полоса с `animation: gc-fill <duration>ms linear forwards`). Справа сцена 480px: фаза 0 — карточка «Войти через Steam» с QR (сетка 15×15, детерминированный ЛКГ `seed = (seed*16807) % 2147483647`, клетка тёмная если `(seed & 3) !== 0 && (seed >> 4 & 1)`, угловые маркеры 4×4), линия сканирования (скрыта при `linked`), текст «Открой Steam на телефоне → Steam Guard → отсканируй.», при `linked` — «✓ Привязано: dga · 212 игр»; фаза 1 — «Библиотека · 212 игр · 180 запускаются», сетка 6×2 из `demoAppIds` (плашка «ПРОВЕРЬ» жёлтая у `i % 5 === 3`, иначе «ОК» зелёная), нарисованный курсор (SVG-стрелка, `transition: left/top .9s cubic-bezier(.4,0,.2,1)`) едет к плитке 5 (`cursor-tile`), плитка увеличивается и показывает «Играть» (`tile-hot`), курсор к кнопке (`cursor-play`), клик с рябью (`click`), плитка возвращается (`tile-cool`); фаза 2 — экран 16:9: «Поднимаем контейнер…» → `boot-gpu` «Выделяем GPU…» → `boot-stream` «Запускаем стрим…» с прогрессом, `playing` — градиентная «игра» с оверлеем «● 60 FPS · 14 ms» и подписью «здесь будет живое видео стрима». При reduced motion: стартовая фаза 2 с cues `{playing}` без таймеров; клик по шагу показывает финальный кадр фазы (0: `linked`; 1: `tile-hot`; 2: `playing`).

- [ ] **Step 1: тесты**
  ```ts
  // howItWorksTimeline.test.ts
  it("cues are ordered and inside their phase", () => { for (const p of [0,1,2] as const) { const cues = PHASE_CUES[p]; cues.forEach((c, i) => { expect(c.at).toBeLessThan(PHASE_DURATION_MS[p]); if (i) expect(c.at).toBeGreaterThan(cues[i-1].at); }); } });
  it("phases cycle", () => { expect(nextPhase(0)).toBe(1); expect(nextPhase(1)).toBe(2); expect(nextPhase(2)).toBe(0); });
  // landingSections.test.tsx
  it("how it works lists three steps and jumps on click", () => { render(<HowItWorks />); for (const s of steps) expect(screen.getByRole("heading", { name: s.title })).toBeTruthy(); fireEvent.click(screen.getByRole("heading", { name: "Нажми Играть" })); expect(screen.getByText(/Поднимаем контейнер|здесь будет живое видео стрима/)).toBeTruthy(); });
  it("reduced motion shows the final frame", () => { window.matchMedia = () => ({ matches: true, … }); render(<HowItWorks />); expect(screen.getByText("здесь будет живое видео стрима")).toBeTruthy(); });
  ```
- [ ] **Step 2:** тесты FAIL.
- [ ] **Step 3:** Реализовать расписание, компонент, keyframes; подключить в `LandingPage` после `TechFlow`.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`; в dev: демо крутится по кругу, клик по шагу перематывает.
- [ ] **Step 5:** Commit `feat(web): animated how-it-works demo`.

---

### Task 10: Тарифы и ачивки

**Files:**
- Create: `apps/web/src/components/landing/Plans.tsx`, `apps/web/src/components/landing/Achievements.tsx`
- Modify: `data.ts` (`plans`, `PLANS_ARE_PLACEHOLDERS`, `achievements`), `LandingPage.tsx`
- Test: `landingSections.test.tsx` (дополнить)

**Interfaces:**
- Consumes: `SteamButton`.
- Produces:
  ```ts
  export const PLANS_ARE_PLACEHOLDERS = true; // плашка «цены и цифры — предварительные» показывается, пока true
  export type Plan = { name: string; who: string; hours: number; priceRub: number; perHourRub: number; features: ReadonlyArray<{ text: string; included: boolean; gpu?: string; strong?: boolean }>; popular?: boolean };
  export const plans: ReadonlyArray<Plan> // Старт 10 ч 490 ₽ (49 ₽/ч): 1080p·60 FPS ✓, Общая очередь на сервер ✓, Стандартное железо RTX 3060 ✓, Без очереди ✗, 4K и 120 FPS ✗; Про 40 ч 1 490 ₽ (37) popular: 1440p·60 FPS, Без очереди — сервер всегда есть (strong), Быстрое железо RTX 4070, Сессия до 8 часов, 4K и 120 FPS ✗; Ультра 120 ч 3 490 ₽ (29): 4K·120 FPS (strong), Без очереди + приоритет, Топовое железо RTX 4090, Сессия без лимита, Ранний доступ к новым фичам
  export const achievements: ReadonlyArray<{ emoji: string; title: string; text: string; season?: string }> // 🚀 Первый запуск / Запустил первую игру в облаке; 🏃 Марафонец / 5 часов подряд, не выходя; 🦉 Ночная смена / Играл после трёх ночи; 🔥 Феникс / Вернулся в сессию после обрыва связи; 📚 Коллекционер / Запустил 25 разных игр; 💯 Сотня / 100 часов на платформе; 💘 Настоящая любовь / 14 февраля провёл с нами, season «Сезонная · февраль»; 🎃 Тыквенный час / Хоррор-марафон на Хэллоуин, season «Сезонная · октябрь»
  export function Plans(): JSX.Element; // <section id="plans">, «Платишь за часы игры», лид из прототипа, три карточки (popular подсвечена, бейдж «ПОПУЛЯРНЫЙ»), часы крупно + «часов / мес», «1 490 ₽ · 37 ₽ за час», списки (✓ зелёный, – серый), кнопка «Выбрать» = <SteamButton variant={popular ? "primary" : "ghost"}>Выбрать</SteamButton>; колонки 3 → 1 при < 900px
  export function Achievements(): JSX.Element; // <section id="ach">, «Играй и собирай», сетка 4 → 2 при < 960px; иконка — эмодзи в шестиугольнике (clip-path polygon(50% 0, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)) с бренд-градиентом; сезонные — серые (grayscale, opacity .6) с подписью season жёлтым капсом
  ```
  Числа и цены форматируются с неразрывным тонким пробелом как в прототипе («1 490 ₽»).

- [ ] **Step 1: тесты**
  ```tsx
  it("plans show three tiers with placeholder badge", () => { render(<Plans />); expect(screen.getByText("цены и цифры — предварительные")).toBeTruthy(); for (const p of plans) expect(screen.getByRole("heading", { name: p.name })).toBeTruthy(); expect(screen.getByText("ПОПУЛЯРНЫЙ")).toBeTruthy(); expect(screen.getAllByRole("button", { name: "Выбрать" }).length).toBe(3); });
  it("achievements render eight cards, two seasonal locked", () => { render(<Achievements />); for (const a of achievements) expect(screen.getByText(a.title)).toBeTruthy(); expect(screen.getAllByText(/Сезонная/).length).toBe(2); });
  ```
- [ ] **Step 2:** тесты FAIL.
- [ ] **Step 3:** Реализовать; подключить в `LandingPage` после `HowItWorks`.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`.
- [ ] **Step 5:** Commit `feat(web): plans and achievements sections`.

---

### Task 11: FAQ-чат, финальный призыв, футер в сборе

**Files:**
- Create: `apps/web/src/components/landing/FaqChat.tsx`
- Modify: `data.ts` (`faq`), `LandingPage.tsx` (полный порядок секций)
- Test: `landingSections.test.tsx`, `landing.test.tsx` (дополнить)

**Interfaces:**
- Produces:
  ```ts
  export const faq: ReadonlyArray<{ q: string; a: string }> // 5 пар из прототипа: «А лагать не будет?», «Какие игры пойдут?», «Сейвы пропадут?», «Надо что-то ставить?», «А если интернет оборвётся?» с ответами дословно
  export function FaqChat(): JSX.Element; // <section id="faq">, «Обычно спрашивают»; сообщения: вопрос — пузырь справа с аватаром «Ты», ответ — пузырь слева с аватаром <Logo iconOnly height={20}/>; появление по IntersectionObserver (threshold 0.4): класс show, ответ с задержкой 250 мс; без IntersectionObserver или при reduced motion — всё видно сразу
  ```
  `LandingPage` итоговый порядок: `LandingNav`, `Hero`, `TechFlow`, `HowItWorks`, `Plans`, `Achievements`, `FaqChat`, `FinalCta`, `LandingFooter`; обёртка `bg-brand-bg text-brand-text font-sans overflow-x-hidden`.

- [ ] **Step 1: тесты**
  ```tsx
  it("faq renders all pairs", () => { render(<FaqChat />); for (const { q, a } of faq) { expect(screen.getByText(q)).toBeTruthy(); expect(screen.getByText(a)).toBeTruthy(); } });
  it("landing has every section anchor", () => { render(<LandingPage error={false} />); for (const id of ["tech","how","plans","ach","faq"]) expect(document.getElementById(id)).toBeTruthy(); });
  ```
- [ ] **Step 2:** тесты FAIL.
- [ ] **Step 3:** Реализовать `FaqChat`; собрать `LandingPage`.
- [ ] **Step 4:** тесты PASS; `bun run check && bun run lint`.
- [ ] **Step 5:** Commit `feat(web): faq chat and full landing page`.

---

### Task 12: Сборка, бюджет, мобильная проверка, документация

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-gamecrate-brand-and-landing-design.md` (статус → «реализовано», отклонения если есть), `apps/web/src/components/landing/*` (только правки по результатам проверки)

- [ ] **Step 1:** `bun run build` — записать размер JS-чанков; сравнить с `main` (`git stash`-ом не пользоваться: собрать `main` в отдельном worktree или взять размер из `apps/web/.turbo/turbo-build.log` на `main`). Разница ≤ 60 КБ минифицированного JS; если больше — сократить частицы/дублирование кода, пока не уложится.
- [ ] **Step 2:** `bun run --cwd apps/web dev`, открыть `/` на ширинах 1400, 1024, 768, 390: шапка (якоря скрыты < 860), hero (плюсы 6/3/2), поток (460px при < 860), демо под шагами при < 960, тарифы в колонку при < 900, ачивки 2 колонки при < 960. Нет горизонтального скролла. Проверить с эмуляцией `prefers-reduced-motion` в DevTools: ничего не плывёт.
- [ ] **Step 3:** Полный прогон: `bun run check && bun run lint && bun run --cwd apps/web test && bun fmt`; `git status` чистый после `fmt` (или закоммитить форматирование).
- [ ] **Step 4:** Обновить статус в спеке; `git log --oneline main..HEAD` — все коммиты на месте.
- [ ] **Step 5:** Commit `docs(brand): mark landing spec as implemented`.
