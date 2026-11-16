# Витрина билайна: логотип и тарифы — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** фирменный шар билайна вместо заглушки и карточки подписок со старого сайта на витрине билайна.

**Architecture:** логотип — React-SVG из `beeline-ball.svg` старого сайта (`apps/web/src/brands/beeline`).
Подписки — статические данные `monetization.plans` в реестре бренда, общий компонент карточек
рендерится в `PartnerSubscription` (лендинг) и `PartnerPlansPage` (`/app/plans`).

**Tech Stack:** React 19, Tailwind, bun test + Testing Library, `@resvg/resvg-js` (PNG-иконка).

**Spec:** `docs/superpowers/specs/2026-11-16-beeline-logo-tariffs-design.md`

## Global Constraints

- Тексты подписок — дословно: «Стандартная подписка», «75 ₽», «стоимость подключения, 1 час»,
  «получай часы ежедневно», «бонусные часы за активное использование»; «Недельная подписка»,
  «299 ₽», «стоимость подключения, 7 часов», «получай часы каждую неделю».
- Кнопка «Подключить» на карточке — только если `monetization.url !== null` (у билайна сейчас `null`).
- У GameCrate (`monetization.kind === "own"`) ничего не меняется.
- Шар — пути и цвета из `/tmp/bpc/assets/beeline-ball.svg` (`#FFC800`, `#1B242C`, радиальный блик),
  без слова рядом.
- Пакеты часов и конфигурации старого сайта не переносим.

## Review Focus

- Несколько логотипов на одной странице (шапка, футер, FAQ): id градиента уникален у каждого
  экземпляра (`useId`), иначе блик пропадает/путается — тест в Task 1.
- `plans: []` у партнёра — ни карточек, ни пустой сетки — тест в Task 2.
- `url` задан — «Подключить» в каждой карточке ведёт на `url`, `target="_blank"` — тест в Task 2.
- Узкий экран (360 px): карточки в одну колонку, без горизонтального скролла — сетка
  `grid-cols-1 sm:grid-cols-2`, проверка глазами после выкатки.
- `/app/plans` без ответа сервера: карточки видны, «Ваш тариф» — скелетон/ошибка как раньше.

---

### Task 1: Логотип билайна

**Files:**
- Modify: `apps/web/src/brands/beeline/BeelineLogo.tsx` (заменить целиком)
- Modify: `apps/web/src/brands/beeline/public/favicon.svg`, `apps/web/src/brands/beeline/public/apple-touch-icon.png`
- Test: `apps/web/test/brand.test.tsx`

**Interfaces:** пропсы не меняются (`height?`, `iconOnly?`, `progress?`, `title?`) — их задаёт `WebBrand["Logo"]`.

- [ ] **Step 1: Тест** в `describe("название и логотип витрины")`:
  `it("логотип билайна: шар, квадрат, свой id градиента у каждого экземпляра")` — рендер двух
  `<BrandLogo height={36} />` под `WEB_BRANDS.beeline`; у каждого `svg` `width === height === "36"`,
  `viewBox === "0 0 44 44"`, есть `path[fill="#FFC800"]`; id двух `radialGradient` различаются, и
  `fill="url(#…)"` каждого svg ссылается на свой id. Существующие тесты логотипа билайна остаются.
- [ ] **Step 2:** `cd apps/web && bun test test/brand.test.tsx` — новый тест падает.
- [ ] **Step 3:** `BeelineLogo` — `<svg role="img" aria-label={title} width={height} height={height} viewBox="0 0 44 44">`
  с путями шара; id градиента из `useId()` без символов вне `[A-Za-z0-9_-]`; `iconOnly`/`progress`
  на вид не влияют (шар один). Комментарий-TODO заглушки убрать; в шапке файла — откуда знак.
  `favicon.svg` — тот же шар (статический id). `apple-touch-icon.png` — 180×180: шар с отступом 12 %
  на белом фоне, одноразово через `@resvg/resvg-js` (скрипт не коммитим).
- [ ] **Step 4:** тесты файла зелёные. Если тест оболочки `/app` опирался на текст «билайн» из
  `<text>` заглушки — добавить в svg `<title>{title}</title>`, а не менять ожидание.
- [ ] **Step 5: Commit** `feat(beeline): фирменный шар билайна вместо заглушки логотипа`.

### Task 2: Карточки подписок

**Files:**
- Modify: `apps/web/src/brands/index.ts` (тип), `apps/web/src/brands/beeline/index.tsx` (данные)
- Create: `apps/web/src/components/brand/PartnerPlanCards.tsx`
- Modify: `apps/web/src/components/landing/PartnerSubscription.tsx`, `apps/web/src/components/app/PartnerPlansPage.tsx`
- Test: `apps/web/test/partnerMonetization.test.tsx`

**Interfaces:**
- `export type PartnerPlan = { readonly name: string; readonly price: string; readonly priceNote: string; readonly perks: readonly string[] }` в `brands/index.ts`; partner-ветка `Monetization` получает `readonly plans: readonly PartnerPlan[]`.
- `export function PartnerPlanCards({ plans, url }: { plans: readonly PartnerPlan[]; url: string | null })` — `null` при пустом `plans`; иначе `<ul>` сеткой `grid-cols-1 sm:grid-cols-2`, в карточке `<h3>{name}</h3>`, цена, `priceNote`, список плюсов, при `url` — `<a href={url} target="_blank" rel="noreferrer">Подключить</a>`.

- [ ] **Step 1: Тесты.** Обновить «билайн: подписка вместо тарифов — без ₽» → «билайн: подписка и
  карточки со старого сайта»: заголовки `h3` «Стандартная подписка» и «Недельная подписка», тексты
  «75 ₽», «299 ₽», «стоимость подключения, 1 час», «получай часы ежедневно», «бонусные часы за активное
  использование», «получай часы каждую неделю»; ссылки «Подключить» нет. На `/app/plans` для билайна
  — те же карточки, «Базовый»/«без лимита» как раньше, «Про» и «Пакеты часов» нет, кнопок нет
  (снять проверку «без ₽», оставить остальные). Новые: с `url: "https://example.test/sub"` — две
  ссылки «Подключить» с этим `href`; с `plans: []` — нет `h3` «Стандартная подписка» и нет `list`
  в секции подписки. GameCrate-тесты не трогать.
- [ ] **Step 2:** `cd apps/web && bun test test/partnerMonetization.test.tsx` — новые падают.
- [ ] **Step 3:** тип, данные билайна (Global Constraints), компонент; в `PartnerSubscription` —
  между `SectionHead` и строкой кнопок; в `PartnerPlansPage` — после текста/ссылки, перед «Ваш тариф».
  Комментарии в шапках обоих файлов («Цен нет») поправить.
- [ ] **Step 4:** `cd apps/web && bun test && bun run check` — зелёные.
- [ ] **Step 5: Commit** `feat(beeline): карточки подписок со старого сайта на витрине`.
