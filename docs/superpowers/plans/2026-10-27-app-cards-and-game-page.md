# Единая карточка, страница игры и доработка `/app` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Одна карточка игры на все секции `/app` с кликом на новую страницу игры `/app/game/<appId>` (описание, скриншоты, трейлер, совместимость, достижения, сессии из Steam и своей базы), закреплённые полоска и правая колонка без «Установок», секции по 24 плитки с «Показать ещё».

**Architecture:** Фронт: `GameTile` переписывается под вариант C (всё на обложке, плитка — `Link` на страницу игры), `GameSection` получает `limit`, `RecentRow` удаляется, `Rail`/`AppShell` закрепляются. Сервер: новый клиент `SteamStoreApi` (Steam Store appdetails) и расширение `SteamApi` (схема достижений и достижения игрока), кэш в новых таблицах `game_details`/`game_achievements` со сроком 7 суток, один новый RPC `library.game`. Страница игры — набор панелей в `components/app/game/`, рисует всё, что знает, даже когда Steam Store молчит.

**Tech Stack:** Bun 1.4 monorepo, Effect 4 (RPC, HttpClient, Schema), Drizzle 1.0 rc + Postgres, React 19, TanStack Router 1.170 (code-based routes), Tailwind 4, lucide-react, `hls.js` (новая зависимость `apps/web`), Bun test + happy-dom (`apps/web`), Bun test на настоящей БД `TEST_DATABASE_URL` (`apps/api`).

**Spec:** `docs/superpowers/specs/2026-10-27-app-cards-and-game-page-design.md`

## Global Constraints

- Тексты интерфейса на русском; слово «облако», никогда «контейнер»; Steam ни в одном тексте не называется способом войти в GameCrate.
- Копия кнопок/статусов ровно по спеке: «Играть», «Установить», «Вернуться в игру», «не установлена», «качается», «готова», «В облаке», «нет в библиотеке», «нужен вход в Steam».
- Тесты `apps/web` запускаются из `apps/web` (`cd apps/web && bun test <file>`), не из корня (корневой `bun test` не читает `bunfig.toml` с happy-dom). Тесты `apps/api` — из `apps/api` (`bun test <file>`), нужна поднятая dev-БД (OrbStack) и `TEST_DATABASE_URL` в `.env`.
- Не запускать корневой `bun fmt`; форматировать только изменённые файлы (`bunx prettier --write <files>`).
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Миграции генерируются `cd packages/db && bunx drizzle-kit generate --name <имя>` (папка `migrations/<timestamp>_<имя>/migration.sql` + `snapshot.json`), применяются `runMigrations` при старте и в тестах — руками SQL не писать.
- Схемы RPC меняются только добавлением; `LibraryEntry`, `RecentEntry`, `TrendingEntry` не трогаем.
- Внешние запросы (Steam Store, Steam Web API) — таймаут 5 с, никогда не роняют RPC: при ошибке отдаём то, что есть.
- Никаких новых зависимостей, кроме `hls.js`; санитайзер описания — свой allowlist на `DOMParser`.

## Review Focus

- Игра, которой нет в Steam Store (инструмент, удалённая): `appdetails` отвечает `{"<id>": {"success": false}}` — страница должна показать шапку и «Steam не дал описание этой игры», а кэш не должен дёргать Steam при каждом открытии (Task 7, тест «found: false кэшируется»).
- Ответ Steam Store не JSON или с неожиданной формой (HTML-страница 403/429 при лимите): `SteamStoreApi` отдаёт `null`, а не падает (Task 6, тест «non-JSON body → null»).
- Клик по кнопке «Играть» внутри плитки-ссылки не должен открывать страницу игры (Task 3, тест «кнопка не всплывает»).
- `appId` в адресе не число (`/app/game/abc`) или число, которого нет ни в `games`, ни в библиотеке: редирект на `/app` / экран «Этой игры нет в твоей библиотеке» вместо пустого экрана (Task 10, тест маршрута; Task 8, тест `GameNotFound`).
- Пользователь без привязанного Steam открывает страницу игры из «В тренде»: достижения `Unlinked`, панели достижений нет, падений нет (Task 8, тест «unlinked user»).

---

### Task 1: Полоска без «Установок», закреплённые полоска и правая колонка

**Files:**
- Modify: `apps/web/src/components/app/Rail.tsx`
- Modify: `apps/web/src/components/app/AppShell.tsx`
- Modify: `apps/web/src/routes/app.tsx:33-37` (убрать `installing`)
- Test: `apps/web/test/appShell.test.tsx`

**Interfaces:**
- Produces: `Rail()` без пропсов; `AppShell({ user, children, aside?, sticky? })` без `installing`.

- [ ] **Step 1: Обновить тесты `Rail` в `appShell.test.tsx`**

Удалить тест «shows an installs indicator when something is installing» и все `installing={...}`. Заменить тест на ссылку «Установки» на:

```tsx
it("has no «Установки» link", async () => {
  render(<RouterProvider router={testRouter(<Rail />)} />);
  await screen.findByRole("link", { name: "Поиск" });
  expect(screen.queryByRole("link", { name: "Установки" })).toBeNull();
});
```

Добавить тест класса закрепления:

```tsx
it("is fixed-height and sticky on desktop", async () => {
  render(<RouterProvider router={testRouter(<Rail />)} />);
  const nav = await screen.findByRole("navigation", { name: "Разделы" });
  expect(nav.className).toContain("sticky");
  expect(nav.className).toContain("h-[calc(100dvh-3rem)]");
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/appShell.test.tsx`
Expected: FAIL — `Установки` ещё есть, класса `h-[calc(100dvh-3rem)]` нет.

- [ ] **Step 3: Реализовать**

`Rail.tsx`: убрать пропс `installing`, ссылку «Установки», импорт `Download`; классы `nav`: `sticky top-6 flex h-[calc(100dvh-3rem)] w-[84px] flex-col items-center gap-2 rounded-[40px] bg-[#13161d] py-5`. Обновить комментарий в шапке файла.

`AppShell.tsx`: убрать пропс `installing` и его JSDoc; контейнер aside получает `md:sticky md:top-6 md:max-h-[calc(100dvh-3rem)] md:overflow-y-auto` вдобавок к текущим классам (на планшете `md:col-start-2` колонка под сеткой — там `sticky` безвреден, т.к. элемент в потоке после контента; если в ручной проверке на 1024 px колонка ведёт себя странно, ограничить закрепление `xl:`). Обновить комментарий в шапке (убрать упоминание подсветки «Установок»).

`routes/app.tsx`: `<AppShell user={me.value}>`; убрать `activeSessionAtom`-зависимость из `AppLayout`, если она больше не нужна (`active`/`session` использовались только для `installing`).

- [ ] **Step 4: Прогнать тесты и typecheck**

Run: `cd apps/web && bun test test/appShell.test.tsx test/myGamesPage.test.tsx && bun run check`
Expected: PASS, typecheck чистый.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/Rail.tsx apps/web/src/components/app/AppShell.tsx apps/web/src/routes/app.tsx apps/web/test/appShell.test.tsx
git commit -m "feat(web): полоска /app без «Установок», полоска и правая колонка закреплены"
```

---

### Task 2: `tileValue` и `formatHoursShort` — чистая логика правого значения плитки

**Files:**
- Modify: `apps/web/src/lib/formatTime.ts`
- Create: `apps/web/src/lib/tileValue.ts`
- Test: `apps/web/test/formatTime.test.ts`, Create `apps/web/test/tileValue.test.ts`

**Interfaces:**
- Produces:
  - `formatHoursShort(min: number): string` — «41 ч», «38 мин», `""` при `min <= 0`.
  - `type TileTone = "muted" | "ok" | "warn"`
  - `type TileValue = { readonly text: string; readonly tone: TileTone; readonly percent: number | null }` — `percent` не null только у `Installing` с известным процентом (для полосы прогресса).
  - `tileValue(game: { cloud: CloudStatus; playtimeMinutes?: number }, dimmed: boolean): TileValue`.

- [ ] **Step 1: Тесты**

В `formatTime.test.ts`:

```ts
describe("formatHoursShort", () => {
  it("часы", () => expect(formatHoursShort(2460)).toBe("41 ч"));
  it("минуты, если меньше часа", () => expect(formatHoursShort(38)).toBe("38 мин"));
  it("пусто при нуле", () => expect(formatHoursShort(0)).toBe(""));
});
```

Новый `tileValue.test.ts` (таблица спеки §3.3):

```ts
const ready = { _tag: "Ready" } as const;
const missing = { _tag: "Missing" } as const;
it("установлена, играл → часы, muted", () =>
  expect(tileValue({ cloud: ready, playtimeMinutes: 2460 }, false)).toEqual({ text: "41 ч", tone: "muted", percent: null }));
it("установлена, не играл → готова, ok", () =>
  expect(tileValue({ cloud: ready, playtimeMinutes: 0 }, false)).toEqual({ text: "готова", tone: "ok", percent: null }));
it("качается с процентом → 42 %, warn, percent", () =>
  expect(tileValue({ cloud: { _tag: "Installing", percent: 42 } }, false)).toEqual({ text: "42 %", tone: "warn", percent: 42 }));
it("качается без процента → качается, warn", () =>
  expect(tileValue({ cloud: { _tag: "Installing", percent: null } }, false)).toEqual({ text: "качается", tone: "warn", percent: null }));
it("не установлена", () =>
  expect(tileValue({ cloud: missing, playtimeMinutes: 900 }, false)).toEqual({ text: "не установлена", tone: "muted", percent: null }));
it("dimmed перекрывает статус", () =>
  expect(tileValue({ cloud: ready, playtimeMinutes: 900 }, true)).toEqual({ text: "нужен вход в Steam", tone: "muted", percent: null }));
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/formatTime.test.ts test/tileValue.test.ts`
Expected: FAIL — функции не существуют.

- [ ] **Step 3: Реализовать `formatHoursShort` в `formatTime.ts` и `tileValue` в `lib/tileValue.ts`**

- [ ] **Step 4: Прогнать**

Run: `cd apps/web && bun test test/formatTime.test.ts test/tileValue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/formatTime.ts apps/web/src/lib/tileValue.ts apps/web/test/formatTime.test.ts apps/web/test/tileValue.test.ts
git commit -m "feat(web): tileValue и formatHoursShort — значение справа на плитке игры"
```

---

### Task 3: `GameTile` вариант C — ссылка на страницу игры, всё на обложке

**Files:**
- Modify: `apps/web/src/components/app/GameTile.tsx`
- Test: `apps/web/test/gameTile.test.tsx`

**Interfaces:**
- Consumes: `tileValue`, `formatHoursShort` (Task 2); `CardAction` (`lib/cardAction.ts`); `GameCover`.
- Produces: `GameTile({ game: TileGame, action: CardAction, dimmed?: boolean, caption?: string })` — `caption` (если задан) заменяет текст справа (tone `muted`, без полосы); плитка — `<Link to="/app/game/$appId" params={{ appId: String(game.appId) }} aria-label={`Игра: ${game.name}`}>` вокруг `<article>`. `cloudLabel` удаляется (экспорт убрать, тесты на него — заменить на `tileValue` из Task 2).

- [ ] **Step 1: Переписать `gameTile.test.tsx`**

Удалить `describe("cloudLabel")`. Обернуть рендеры в `RouterProvider` с `testRouter(...)` из `../test/router` (как в `appShell.test.tsx`), потому что плитка теперь `Link`. Тесты:

```tsx
it("is a link to the game page named after the game", async () => {
  render(<RouterProvider router={testRouter(<GameTile game={game()} action={playAction} />)} />);
  const link = await screen.findByRole("link", { name: "Игра: Portal 2" });
  expect(link.getAttribute("href")).toBe("/app/game/620");
});

it("shows hours on the cover for an installed played game and no «ГОТОВА» pill", async () => {
  render(... game({ cloud: ready, playtimeMinutes: 2460 }) ...);
  await screen.findByText("41 ч");
  expect(screen.queryByText("ГОТОВА")).toBeNull();
  expect(screen.queryByText(/готова/)).toBeNull();
});

it("labels the button «Установить» for a missing game and «Играть» for a ready one", ...)
  // missing + playAction → findByRole("button", { name: "Установить: Portal 2" })
  // ready + playAction → findByRole("button", { name: "Играть: Portal 2" })
  // installing(42) + playAction → «Установить: Portal 2», и есть элемент data-testid="install-bar" со style width 42%

it("button click does not navigate the link", async () => {
  const onPlay = mock(() => {});
  render(... action={{ ...playAction, onPlay }} ...);
  fireEvent.click(await screen.findByRole("button", { name: "Играть: Portal 2" }));
  expect(onPlay).toHaveBeenCalledTimes(1);
  // роутер остался на "/": у тестового роутера history.location.pathname === "/"
});

it("caption replaces the status value", ...)  // caption="12 играют" → текст «12 играют», нет «41 ч»
it("resume action shows «Вернуться в игру»", ...)
it("blocked action renders no button", ...)
it("proton tag stays, pending hidden", ...)  // переносится из старого файла
```

Проверка «не навигировал»: сохранить `const router = testRouter(...)`, после клика `expect(router.state.location.pathname).toBe("/")`.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/gameTile.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Реализовать `GameTile`**

Структура: `Link` (класс `group block focus-visible:outline ...`) → `article` → обложка `relative aspect-[460/215] overflow-hidden rounded-[14px] bg-[#1a1d26]` с `GameCover`, `ProtonTag` (как сейчас), нижний градиент `absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2.5 pt-6 pb-2 flex items-end justify-between gap-2` с `h3` (название, `truncate text-[13px] font-semibold`) и `span` значения (`text-xs`, цвет по `tone`: muted `#8a90a8`, ok `#3ddc97`, warn `#ffd166`); полоса `data-testid="install-bar"` `absolute inset-x-0 bottom-0 h-[3px] bg-[#ffd166]` с `style={{ width: `${percent}%` }}` когда `percent !== null`; кнопка по центру обложки (`absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100`), `onClick={(e) => { e.preventDefault(); e.stopPropagation(); action.onPlay(); }}`. Текст кнопки: `game.cloud._tag === "Ready" ? "Играть" : "Установить"`, иконка `Play`/`Download`; `aria-label` соответственно «Играть: имя»/«Установить: имя». `resume`/`blocked` как раньше. Под обложкой ничего нет. Обновить комментарий в шапке файла (ссылка на спеку §3.3 нового документа).

- [ ] **Step 4: Прогнать**

Run: `cd apps/web && bun test test/gameTile.test.tsx && bun run check`
Expected: PASS; typecheck укажет на `cloudLabel`-импорты — их нет, кроме теста.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/GameTile.tsx apps/web/test/gameTile.test.tsx
git commit -m "feat(web): карточка игры — всё на обложке, клик открывает страницу игры"
```

---

### Task 4: `GameSection` с «Показать ещё», плотная сетка

**Files:**
- Modify: `apps/web/src/components/app/GameSection.tsx`
- Test: `apps/web/test/gameTile.test.tsx` (там живут тесты `GameSection`)

**Interfaces:**
- Produces: `GameSection({ title, count, limit?: number, scroll?: boolean, action?: React.ReactNode, children })` — `action` рендерится в `h2` после линии (ссылка «все сессии →» в Task 5); `children` — массив элементов; при `limit` показываются первые `limit`, под сеткой кнопка «Показать ещё N · осталось M» (N = `min(limit, остаток)`), каждый клик добавляет `limit`. `scroll` — горизонтальная прокрутка на телефоне (для «Запускал недавно»): `flex gap-3 overflow-x-auto sm:grid` с `min-w-[220px]` у детей через `[&>*]:min-w-[220px] sm:[&>*]:min-w-0`. Экспорт `export const SECTION_PAGE = 24`.

- [ ] **Step 1: Тесты**

```tsx
it("shows the first `limit` children and a «Показать ещё» button", () => {
  render(<GameSection title="Нужна установка" count={60} limit={24}>{Array.from({length: 60}, (_, i) => <div key={i} data-testid="tile" />)}</GameSection>);
  expect(screen.getAllByTestId("tile")).toHaveLength(24);
  fireEvent.click(screen.getByRole("button", { name: "Показать ещё 24 · осталось 36" }));
  expect(screen.getAllByTestId("tile")).toHaveLength(48);
  fireEvent.click(screen.getByRole("button", { name: "Показать ещё 12 · осталось 12" }));
  expect(screen.getAllByTestId("tile")).toHaveLength(60);
  expect(screen.queryByRole("button", { name: /Показать ещё/ })).toBeNull();
});
it("renders no button when children fit", ...)  // 10 детей, limit 24 → нет кнопки
it("grid has five columns from 1440px", () => { ...; expect(grid.className).toContain("min-[1440px]:grid-cols-5"); });
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/gameTile.test.tsx`

- [ ] **Step 3: Реализовать**

`useState(limit ?? Infinity)` для показанного числа; `React.Children.toArray(children).slice(0, shown)`. Сетка: `grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 min-[1440px]:grid-cols-5`. Кнопка — `Button variant="outline"` по центру под сеткой. Сброс состояния при смене фильтров — ответственность родителя через `key` (Task 5).

- [ ] **Step 4: Прогнать**

Run: `cd apps/web && bun test test/gameTile.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/GameSection.tsx apps/web/test/gameTile.test.tsx
git commit -m "feat(web): секции /app по 24 плитки с «Показать ещё», сетка до 5 колонок"
```

---

### Task 5: «Мои игры» и «В тренде» на новой плитке, `RecentRow` удалён

**Files:**
- Modify: `apps/web/src/components/app/MyGamesPage.tsx:318-340`
- Modify: `apps/web/src/components/app/TrendingPage.tsx:25-30`
- Delete: `apps/web/src/components/app/RecentRow.tsx`, `apps/web/test/recentRow.test.tsx`
- Test: `apps/web/test/myGamesPage.test.tsx`, `apps/web/test/appPages.test.tsx`

**Interfaces:**
- Consumes: `GameTile` (Task 3), `GameSection` + `SECTION_PAGE` (Task 4), `formatRelativeDate`, `formatMinutes`.
- Produces: функция `recentCaption(entry: RecentEntry, now: Date): string` → `` `${formatRelativeDate(entry.lastPlayedAt, now)} · ${formatMinutes(entry.lastDurationMinutes)}` `` в `apps/web/src/lib/tileValue.ts`.

- [ ] **Step 1: Тесты**

В `myGamesPage.test.tsx` добавить/изменить:

```tsx
it("renders «Запускал недавно» as regular tiles with date · duration caption", async () => {
  // recentAtom: одна RecentEntry { appId: 620, lastPlayedAt: вчера ISO, lastDurationMinutes: 80 }
  await screen.findByText("Запускал недавно");
  await screen.findByText("вчера · 1 ч 20 м");
  expect(screen.getByRole("link", { name: "Игра: Portal 2" })).toBeTruthy();
});
it("caps a section at 24 tiles and offers «Показать ещё»", async () => {
  // libraryAtom: 30 Missing-игр
  expect((await screen.findAllByRole("link", { name: /^Игра: / })).length).toBe(24);
  await screen.findByRole("button", { name: "Показать ещё 6 · осталось 6" });
});
```

Существующие проверки на тексты старой карточки («готова · …», «нужна установка · …», «ГОТОВА») заменить на новые значения («41 ч», «не установлена»). В `appPages.test.tsx` проверка подписей «N играют»/«N игроков» остаётся — они теперь идут через `caption`; текст «нет в твоей библиотеке Steam» заменить на «нет в библиотеке».

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/myGamesPage.test.tsx test/appPages.test.tsx`

- [ ] **Step 3: Реализовать**

`MyGamesPage`: вместо `<RecentRow>` — `<GameSection title="Запускал недавно" count={recent.length} scroll>` с заголовком-ссылкой «все сессии →» (добавить в `GameSection` опциональный проп `action?: React.ReactNode`, рендерится после линии в `h2`) и `GameTile caption={recentCaption(entry, now)}` для каждой записи; секции фильтров — `<GameSection key={`${group.section}:${toSearchKey}`} limit={SECTION_PAGE} …>`, где `toSearchKey = JSON.stringify(toSearch(filters))`, чтобы смена фильтров сбрасывала раскрытие. `TrendingPage`: `caption` для `!inLibrary` → `"нет в библиотеке"`. Удалить `RecentRow.tsx` и его тест, обновить комментарий в `MyGamesPage` (шапка).

- [ ] **Step 4: Прогнать всё web**

Run: `cd apps/web && bun test && bun run check && bun run lint`
Expected: PASS, чисто.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/app apps/web/src/lib/tileValue.ts apps/web/test
git commit -m "feat(web): «Мои игры» и «В тренде» на единой плитке, RecentRow удалён"
```

---

### Task 6: `SteamStoreApi` — клиент Steam Store appdetails

**Files:**
- Create: `apps/api/src/steam/SteamStoreApi.ts`
- Test: `apps/api/test/steamStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StoreDetails = {
    readonly shortDescription: string; readonly aboutTheGame: string;
    readonly developers: ReadonlyArray<string>; readonly publishers: ReadonlyArray<string>;
    readonly genres: ReadonlyArray<string>; readonly releaseDate: string | null;
    readonly metacriticScore: number | null; readonly metacriticUrl: string | null;
    readonly controllerSupport: "full" | "partial" | null; readonly linux: boolean;
    readonly achievementsTotal: number;
    readonly screenshots: ReadonlyArray<{ thumb: string; full: string }>;
    readonly movies: ReadonlyArray<{ name: string; thumbnail: string; hls: string; highlight: boolean }>;
  };
  export type StoreLookup = { _tag: "Found"; details: StoreDetails } | { _tag: "NotFound" } | { _tag: "Unavailable" };
  export class SteamStoreApi extends Context.Service<SteamStoreApi, { readonly fetchDetails: (appId: number) => Effect.Effect<StoreLookup> }>()("@cg/api/SteamStoreApi") { static readonly layer: Layer.Layer<SteamStoreApi, never, HttpClient.HttpClient> }
  ```
  URL: `https://store.steampowered.com/api/appdetails?appids=<id>&l=russian`. Схема ответа декодируется мягко: все поля `Schema.optional`; `movies[].hls_h264` отсутствует → фильм пропускается. Таймаут 5 с → `Unavailable`. Не-JSON/не-2xx/ошибка сети → `Unavailable`. `success: false` → `NotFound`. Никогда не падает (по образцу `ProtonDb`).

- [ ] **Step 1: Тесты** (`fakeHttpClient` скопировать из `protondb.test.ts`)

```ts
it("maps a full appdetails response", ...)   // body из фикстуры с полями как у Steam (short_description, about_the_game, developers, publishers, genres[{description}], release_date{date}, metacritic{score,url}, controller_support:"full", platforms{linux:true}, achievements{total:54}, screenshots[{path_thumbnail,path_full}], movies[{name,thumbnail,hls_h264,highlight}]) → Found с ожидаемыми полями
it("success:false → NotFound", ...)
it("network error → Unavailable", ...)
it("non-JSON body → Unavailable", ...)  // Response("<html>", {status: 429})
it("movie without hls_h264 is dropped, fields missing → defaults", ...) // only name present → Found с пустыми массивами, null-ами, achievementsTotal 0
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/api && bun test test/steamStore.test.ts`

- [ ] **Step 3: Реализовать `SteamStoreApi.ts`**

- [ ] **Step 4: Прогнать**

Run: `cd apps/api && bun test test/steamStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/steam/SteamStoreApi.ts apps/api/test/steamStore.test.ts
git commit -m "feat(api): клиент Steam Store appdetails"
```

---

### Task 7: Достижения в `SteamApi` и таблицы кэша

**Files:**
- Modify: `apps/api/src/steam/SteamApi.ts`
- Modify: `packages/db/src/schema/library.ts` (две новые таблицы)
- Create: `packages/db/migrations/<ts>_game_details/` (через drizzle-kit)
- Test: `apps/api/test/steam.test.ts`

**Interfaces:**
- Produces в `SteamApi`:
  ```ts
  readonly getAchievementSchema: (appId: number) => Effect.Effect<ReadonlyArray<{ apiName: string; name: string; description: string; icon: string; iconGray: string; hidden: boolean }> | null>  // null — нет данных/ошибка
  readonly getPlayerAchievements: (steamId: string, appId: number) => Effect.Effect<{ _tag: "Private" } | { _tag: "None" } | { _tag: "Ready"; unlocked: ReadonlyArray<{ apiName: string; unlockedAt: string }> }>
  ```
  URL схемы: `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=&appid=&l=russian` (ответ `game.availableGameStats.achievements[]` с `name, displayName, description?, icon, icongray, hidden`); игрок: `ISteamUserStats/GetPlayerAchievements/v1/?key=&steamid=&appid=&l=russian` (`playerstats.success`, `playerstats.error` «Profile is not public» → `Private`; `success:false` иначе или нет `achievements` → `None`; `achievements[].achieved === 1` → unlocked, `unlocktime` секунды → ISO). Таймаут 5 с, любые ошибки → `null` / `None`.
- Produces в схеме БД (`library.ts`):
  - `gameDetails` = `game_details`: `appId` integer PK → `games.appId` cascade; `fetchedAt` timestamptz notNull; `found` boolean notNull; `shortDescription`, `aboutTheGame` text; `developers`, `publishers`, `genres` text[] (`text("…").array()`); `releaseDate` text; `metacriticScore` integer; `metacriticUrl` text; `controllerSupport` text; `linux` boolean notNull default false; `achievementsTotal` integer notNull default 0; `screenshots` jsonb `$type<Array<{thumb:string; full:string}>>()`; `movies` jsonb `$type<…>`; `achievementsFetchedAt` timestamptz (null — схему ещё не брали).
  - `gameAchievements` = `game_achievements`: `appId` integer → `games.appId` cascade, `apiName` text, PK (`appId`,`apiName`); `name`, `description` text notNull; `icon`, `iconGray` text notNull; `hidden` boolean notNull default false.

- [ ] **Step 1: Тесты `SteamApi` (в `steam.test.ts`, тем же `fakeHttpClient`/`fakeConfig`)**

```ts
describe("getAchievementSchema", () => {
  it("maps achievements", ...)        // 1 запись → apiName "ACH_1", name из displayName, hidden false
  it("missing availableGameStats → null", ...)
  it("network error → null", ...)
});
describe("getPlayerAchievements", () => {
  it("private profile → Private", ...)  // {playerstats:{success:false,error:"Profile is not public"}}
  it("game without stats → None", ...)  // {playerstats:{success:false,error:"Requested app has no stats"}}
  it("unlocked list with ISO time", ...) // achieved 1, unlocktime 1700000000 → "2023-11-14T22:13:20.000Z"
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/api && bun test test/steam.test.ts`

- [ ] **Step 3: Реализовать методы в `SteamApi.ts`, добавить таблицы в `library.ts`, сгенерировать миграцию**

Run: `cd packages/db && bunx drizzle-kit generate --name game_details`
Expected: новая папка в `migrations/` с `CREATE TABLE "game_details"` и `"game_achievements"`. Проверить, что `migration.sql` не содержит ничего, кроме этих таблиц (иначе схема разошлась с миграциями — остановиться и сообщить).

- [ ] **Step 4: Прогнать**

Run: `cd apps/api && bun test test/steam.test.ts && cd ../../packages/db && bun test`
Expected: PASS (тесты `packages/db` применяют миграции к тестовой БД).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/steam/SteamApi.ts apps/api/test/steam.test.ts packages/db/src/schema/library.ts packages/db/migrations
git commit -m "feat(api,db): достижения Steam в SteamApi, таблицы game_details и game_achievements"
```

---

### Task 8: `library.game` — RPC страницы игры с кэшем 7 суток

**Files:**
- Modify: `packages/rpc/src/library.ts` (схемы + RPC + ошибка)
- Create: `apps/api/src/library/GameDetailsRepo.ts`, `apps/api/src/library/GameService.ts`
- Modify: `apps/api/src/library/RecentRepo.ts` (экспортировать `sessionDurationMinutes`)
- Modify: `apps/api/src/library/rpc.ts`
- Modify: `apps/api/src/main.ts:20` (рядом с `ProtonDb.layer` добавить `SteamStoreApi.layer`)
- Test: `apps/api/test/game.test.ts`

**Interfaces:**
- Consumes: `SteamStoreApi` (Task 6), `SteamApi.getAchievementSchema/getPlayerAchievements`, `gameDetails`, `gameAchievements` (Task 7), `CloudRepo.cloudStatuses`, `coverUrl`.
- Produces в `@cg/rpc`:
  ```ts
  export const GameDetails = Schema.Struct({ shortDescription, aboutTheGame: Schema.String, developers, publishers, genres: Schema.Array(Schema.String), releaseDate: Schema.NullOr(Schema.String), metacriticScore: Schema.NullOr(Schema.Int), metacriticUrl: Schema.NullOr(Schema.String), controllerSupport: Schema.NullOr(Schema.Literals(["full","partial"])), linux: Schema.Boolean, achievementsTotal: Schema.Int, screenshots: Schema.Array(Schema.Struct({ thumb, full })), movies: Schema.Array(Schema.Struct({ name, thumbnail, hls, highlight: Schema.Boolean })) });
  export const GameAchievements = Schema.Union([ TaggedStruct("None"), TaggedStruct("Private"), TaggedStruct("Unlinked"), TaggedStruct("Ready", { total: Int, unlocked: Array({ apiName, name, description, icon, unlockedAt }), locked: Array({ apiName, name, description, iconGray, hidden }) }) ]);
  export const GameSessionEntry = Schema.Struct({ id, startedAt: Schema.String, minutes: Schema.Int });
  export const GameView = Schema.Struct({ appId, name, coverUrl, cloud: CloudStatus, protonTier: ProtonTier, inLibrary: Schema.Boolean, playtimeMinutes: Int, sizeBytes: NullOr(Int), lastSession: NullOr(GameSessionEntry), sessions: Array(GameSessionEntry), details: NullOr(GameDetails), achievements: GameAchievements });
  export class GameNotFound extends Schema.TaggedError<GameNotFound>()("GameNotFound", { appId: Schema.Int }) {}
  Rpc.make("library.game", { payload: { appId: Schema.Int }, success: GameView, error: GameNotFound })
  ```
- Produces на сервере: `gameView(userId: string, steamId: string | null, appId: number, now: Date): Effect.Effect<GameView, GameNotFound, Db | SteamStoreApi | SteamApi>`; `GameDetailsRepo.getFresh(appId, now)`, `GameDetailsRepo.upsert(appId, lookup, now)`, `GameDetailsRepo.listAchievements(appId)`, `GameDetailsRepo.replaceAchievements(appId, rows, now)`. Константа `export const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000`.

Логика `gameView`:
1. `games` по `appId`; нет строки → `GameNotFound`. `inLibrary` = есть `user_games` строка; `playtimeMinutes` оттуда или 0.
2. Параллельно (`Effect.all` с `concurrency: "unbounded"`): статус облака + `sizeBytes` из `gamestore_apps`; сессии пользователя по игре (не `failed`, по `created_at` desc, до 10) с минутами через `sessionDurationMinutes` из `RecentRepo` (закрытые сегменты); детали (кэш свежий → из БД; иначе `SteamStoreApi.fetchDetails`: `Found`/`NotFound` → `upsert` и отдать; `Unavailable` → старая запись или `null`); достижения (`steamId === null` → `Unlinked`; `achievementsTotal === 0` после деталей → `None`; схема из кэша, если `achievementsFetchedAt` свежий, иначе `getAchievementSchema` → `replaceAchievements`; `getPlayerAchievements` → `Private`/`None`/`Ready`, сопоставление по `apiName`; `unlocked` по `unlockedAt` desc).
3. `lastSession` = первая из `sessions` или `null`. `found: false` в кэше → `details: null`, Steam не вызывается до истечения TTL.

- [ ] **Step 1: Тесты `game.test.ts`** (по образцу `recent.test.ts`: `DbTest`, `RpcTest.makeClient(LibraryRpcs)`, фейковые `SteamStoreApi`/`SteamApi` со счётчиками вызовов; пользователь со `steamId: "7656119"` и без)

```ts
it("fresh cache: Steam Store not called, details from DB", ...)       // insert game_details fetchedAt=now-1h; storeCalls === 0
it("stale cache: Steam Store called and row overwritten", ...)        // fetchedAt=now-8d; storeCalls === 1; details.shortDescription новое
it("Steam Store unavailable: stale details are returned", ...)        // fetchedAt=now-8d, fake → Unavailable; details — старые
it("success:false is cached: details null, no repeat call", ...)      // fake → NotFound дважды подряд: storeCalls === 1, details null оба раза
it("achievements Ready: unlocked/locked split, sorted by unlock desc", ...)
it("achievements Private for closed profile", ...)
it("Unlinked when user has no steamId; still returns details", ...)
it("sessions: last 10 non-failed with minutes from closed segments, lastSession first", ...)
it("GameNotFound for unknown appId", ...)                              // expect error _tag "GameNotFound"
it("inLibrary false for a game not owned: playtime 0", ...)
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/api && bun test test/game.test.ts`
Expected: FAIL — `library.game` не существует.

- [ ] **Step 3: Реализовать схемы в `@cg/rpc`, `GameDetailsRepo`, `GameService.gameView`, хендлер в `rpc.ts`, провайд `SteamStoreApi.layer` в сборке слоёв (там же, где `ProtonDb.layer`/`SteamApi.layer`); обновить `env` в существующих тестах `library.test.ts`/`recent.test.ts`/`trending.test.ts`/`cloud.test.ts`, если тип окружения хендлеров теперь требует `SteamStoreApi` (заглушка `Effect.die("not used")`)**

- [ ] **Step 4: Прогнать весь api**

Run: `cd apps/api && bun test && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rpc/src/library.ts apps/api/src apps/api/test
git commit -m "feat(api): library.game — страница игры с кэшем Steam Store и достижениями"
```

---

### Task 9: Атом и каркас страницы игры: шапка, совместимость, факты, сессии

**Files:**
- Modify: `apps/web/src/rpc.ts` (`gameAtom`)
- Create: `apps/web/src/components/app/game/GamePage.tsx`, `GameHero.tsx`, `CompatPanel.tsx`, `FactsPanel.tsx`, `SessionsPanel.tsx`
- Create: `apps/web/src/lib/gameHero.ts` (`heroUrl(appId)`, `storeUrl(appId)`)
- Test: `apps/web/test/gamePage.test.tsx`

**Interfaces:**
- Consumes: `GameView` (Task 8), `cardAction`/`usePlaySession`, `tierLabel`, `formatRelativeDate`, `formatMinutes`, `formatHoursShort`.
- Produces: `gameAtom = Atom.family((appId: number) => Api.query("library.game", { appId }, { reactivityKeys: libraryKeys }))`; `GamePage({ appId }: { appId: number })` — читает `gameAtom(appId)`, состояния: загрузка → скелет; ошибка `GameNotFound` → экран «Этой игры нет в твоей библиотеке» + `Button` «К моим играм» (`Link to="/app"`); иначе `GameHero` + две колонки. `GameHero({ game: GameView; action: CardAction })`. Панели принимают `game: GameView`.

Тексты шапки (чипы): `В облаке` (Ready), `качается · N %` / `качается` (Installing), `не установлена` (Missing); `ProtonDB: <tier>` если не pending; `<formatHoursShort> сыграно` если `playtimeMinutes > 0`; `последний запуск: <formatRelativeDate>, <formatMinutes>` если `lastSession`. Кнопка — как в `GameTile` (`Играть`/`Установить`/`Вернуться в игру`; при `inLibrary === false` кнопки нет). Картинка `heroUrl(appId)` = `https://cdn.cloudflare.steamstatic.com/steam/apps/<id>/library_hero.jpg`, `onError` → `header.jpg` с `blur-sm scale-110`. Ссылка «← Мои игры» (`Link to="/app"`).

`CompatPanel` строки: `ProtonDB` → `tierLabel[tier]` (нет при pending); `В облаке` → `установлена, <ГБ>` (`sizeBytes / 2**30` с одним знаком) / `качается` / `не установлена`; `Геймпад` → `полная поддержка`/`частичная` (нет строки при null); `Linux` → `есть нативная версия` (только при `linux`). Панель не рендерится, если нет ни одной строки.

`FactsPanel`: `Разработчик`, `Издатель` (если отличается от разработчика), `Выход`, `Жанры` (до 4 через запятую), `Metacritic` (ссылка), всегда ссылка «Открыть в Steam ↗» на `storeUrl(appId)` = `https://store.steampowered.com/app/<id>`. Без `details` панель содержит только ссылку на Steam.

`SessionsPanel`: до 10 строк `formatRelativeDate` · `formatMinutes`, моно-шрифт; пусто → «Ты ещё не запускал эту игру в облаке»; ссылка «все сессии →» на `/app/time`. При `inLibrary === false` панель не рендерится.

- [ ] **Step 1: Тесты `gamePage.test.tsx`** (мок `../src/rpc` целиком, как в `myGamesPage.test.tsx` — скопировать список атомов и добавить `gameAtom = Atom.family((appId) => Atom.make(AsyncResult.initial()))`; `RouterProvider` + `RegistryProvider initialValues`)

```tsx
it("renders hero with name, cloud chip, proton, hours, last session and «Играть»", ...)  // Ready, platinum, 2460 мин, lastSession вчера 80 мин → тексты «В облаке», «ProtonDB: platinum», «41 ч сыграно», «последний запуск: вчера, 1 ч 20 м», кнопка «Играть: Baldur's Gate 3»
it("«Установить» for a missing game", ...)
it("no play button and no sessions panel for a game not in library", ...)
it("renders facts and compat from details", ...)   // «Larian Studios», «Metacritic» ссылка href = metacriticUrl, «установлена, 122.0 ГБ», «полная поддержка»
it("without details still renders hero, compat (cloud row), «Открыть в Steam» and the notice", ...) // details null → текст «Steam не дал описание этой игры»
it("GameNotFound → «Этой игры нет в твоей библиотеке»", ...)
it("empty sessions → «Ты ещё не запускал эту игру в облаке»", ...)
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/gamePage.test.tsx`

- [ ] **Step 3: Реализовать атом, `GamePage` (пока без медиа/описания/достижений — на их месте `null`), `GameHero`, `CompatPanel`, `FactsPanel`, `SessionsPanel`**

`GamePage` рисует заметку «Steam не дал описание этой игры» (панель `Panel` из `components/app/Panel.tsx`) когда `details === null`. Раскладка: `flex flex-col gap-6`; ниже шапки `grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]`.

- [ ] **Step 4: Прогнать**

Run: `cd apps/web && bun test test/gamePage.test.tsx && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/rpc.ts apps/web/src/components/app/game apps/web/src/lib/gameHero.ts apps/web/test/gamePage.test.tsx
git commit -m "feat(web): страница игры — шапка, совместимость, факты, сессии"
```

---

### Task 10: Маршрут `/app/game/$appId`, кнопка в `StickySlot` на телефоне

**Files:**
- Modify: `apps/web/src/routes/app.tsx`
- Modify: `apps/web/src/main.tsx:29` (добавить `appGameRoute` в `appRoute.addChildren([...])`)
- Modify: `apps/web/src/components/app/game/GamePage.tsx` (StickySlot)
- Test: `apps/web/test/gamePage.test.tsx`, `apps/web/test/libraryRedirect.test.tsx` (образец теста маршрута)

**Interfaces:**
- Consumes: `GamePage` (Task 9), `StickySlot` (`AppShell`).
- Produces: `export const appGameRoute = createRoute({ getParentRoute: () => appRoute, path: "/game/$appId", params: { parse: ({ appId }) => ({ appId: Number(appId) }), stringify: ({ appId }) => ({ appId: String(appId) }) }, component: GameRoutePage })`; `GameRoutePage` берёт `appId` через `appGameRoute.useParams()`, `Number.isInteger(appId) && appId > 0` иначе `<Navigate to="/app" />`.

- [ ] **Step 1: Тесты**

```tsx
it("/app/game/abc redirects to /app", async () => { /* роутер из реального routeTree с memory history ["/app/game/abc"], мок rpc с meAtom success */ expect(router.state.location.pathname).toBe("/app"); });
it("/app/game/620 renders GamePage for appId 620", ...)  // gameAtom(620) success → findByText имени
it("shows the action button in the sticky slot on mobile", ...)  // в документе два элемента с name «Играть: …»: в шапке и в sticky-слоте (StickySlot рендерит только в DOM `md:hidden`-контейнер — проверка по количеству кнопок = 2)
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/gamePage.test.tsx`

- [ ] **Step 3: Реализовать маршрут и `StickySlot` с компактной кнопкой (`Button` на всю ширину в `px-4 pb-2` поверх `BottomTabs`)**

Также обновить `AppLayout`: редирект неавторизованного уже ведёт на `/login?next=<pathname>` — ничего менять не нужно, убедиться тестом не требуется.

- [ ] **Step 4: Прогнать**

Run: `cd apps/web && bun test test/gamePage.test.tsx test/libraryRedirect.test.tsx && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes apps/web/src/components/app/game/GamePage.tsx apps/web/test/gamePage.test.tsx
git commit -m "feat(web): маршрут /app/game/:appId и кнопка игры над нижней панелью"
```

---

### Task 11: Медиа: скриншоты с лайтбоксом и трейлер по HLS

**Files:**
- Modify: `apps/web/package.json` (`bun add hls.js` из `apps/web`)
- Create: `apps/web/src/components/app/game/MediaStrip.tsx`, `Lightbox.tsx`, `TrailerPlayer.tsx`
- Modify: `apps/web/src/components/app/game/GamePage.tsx`
- Test: `apps/web/test/mediaStrip.test.tsx`

**Interfaces:**
- Consumes: `GameDetails.screenshots`, `.movies`.
- Produces: `MediaStrip({ details: GameDetails; name: string })` — панель «Скриншоты и видео»; первый элемент — трейлер (`movies.find(m => m.highlight) ?? movies[0]`), затем скриншоты; показываются первые 8 элементов, кнопка «ещё N» раскрывает все; панель не рендерится, если нет ни фильмов, ни скриншотов. `Lightbox({ items: ReadonlyArray<string>; index: number; onClose; onIndex })` — `role="dialog"`, Esc закрывает, стрелки ←/→ листают, кнопки «Назад»/«Вперёд»/«Закрыть». `TrailerPlayer({ hls: string; poster: string; name: string })` — постер с кнопкой `▶` (`aria-label="Смотреть трейлер: <name>"`); по клику монтирует `<video controls autoPlay poster>`: если `video.canPlayType("application/vnd.apple.mpegurl")` — `src=hls`, иначе `import("hls.js")` динамически → `new Hls().loadSource(hls); attachMedia(video)`; `destroy()` при размонтировании.

- [ ] **Step 1: Установить зависимость**

Run: `cd apps/web && bun add hls.js`
Expected: `hls.js` в `dependencies`, `bun.lock` обновлён.

- [ ] **Step 2: Тесты**

```tsx
it("renders trailer poster first and the first 7 screenshots, with «ещё N»", ...) // 1 фильм + 12 скриншотов → 8 img, кнопка «ещё 5»
it("click on a screenshot opens the lightbox with the full image; Esc closes", ...) // role dialog, img src === full; fireEvent.keyDown(document, {key:"Escape"}) → dialog исчез
it("arrow keys move between screenshots", ...)
it("trailer poster click mounts a video element", ...)  // happy-dom: canPlayType может не существовать → замокать на `() => "probably"`; проверить наличие <video> с src === hls
it("no panel when there is no media", ...)
```

- [ ] **Step 3: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/mediaStrip.test.tsx`

- [ ] **Step 4: Реализовать и подключить `MediaStrip` в `GamePage` (левая колонка, первой)**

- [ ] **Step 5: Прогнать**

Run: `cd apps/web && bun test test/mediaStrip.test.tsx test/gamePage.test.tsx && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/src/components/app/game apps/web/test/mediaStrip.test.tsx
git commit -m "feat(web): скриншоты с лайтбоксом и трейлер HLS на странице игры"
```

---

### Task 12: Описание с санитайзером и «Читать дальше»

**Files:**
- Create: `apps/web/src/lib/sanitizeSteamHtml.ts`
- Create: `apps/web/src/components/app/game/AboutPanel.tsx`
- Modify: `apps/web/src/components/app/game/GamePage.tsx`
- Test: `apps/web/test/sanitizeSteamHtml.test.ts`, `apps/web/test/gamePage.test.tsx`

**Interfaces:**
- Produces: `sanitizeSteamHtml(html: string): string` — через `DOMParser`; разрешены теги `p, br, strong, b, em, i, ul, ol, li, h2, img`; у `img` оставляется только `src`/`alt`, и только если `src` начинается с `https://` и хост оканчивается на `.steamstatic.com` или равен `steamstatic.com`-поддомену (иначе `img` удаляется); все остальные атрибуты удаляются; неразрешённые теги заменяются своим текстовым содержимым (`script`/`style` удаляются вместе с содержимым). `AboutPanel({ details: GameDetails })` — `short_description` абзацем, затем `about_the_game` через `dangerouslySetInnerHTML={{ __html: sanitizeSteamHtml(...) }}` в контейнере с `max-h-[9.5rem] overflow-hidden` и кнопкой «Читать дальше»/«Свернуть» (кнопка только если `scrollHeight > clientHeight` — в тестах проверяется наличие кнопки при `aboutTheGame.length > 600` как упрощённый критерий **[решение исполнителя: можно измерять через `ref` и `useLayoutEffect`, но в happy-dom размеры нулевые — тогда критерий по длине в символах]**).

- [ ] **Step 1: Тесты**

```ts
it("keeps allowed tags and strips attributes", () => expect(sanitizeSteamHtml('<p class="x" onclick="y">Hi <strong>there</strong></p>')).toBe("<p>Hi <strong>there</strong></p>"));
it("drops script with content and unwraps unknown tags", () => expect(sanitizeSteamHtml("<div>a<script>alert(1)</script><span>b</span></div>")).toBe("ab"));
it("keeps steamstatic images, drops others", () => { ... '<img src="https://shared.akamai.steamstatic.com/x.gif" alt="a"><img src="https://evil.example/x.gif">' → '<img src="https://shared.akamai.steamstatic.com/x.gif" alt="a">' });
it("drops javascript: and http: image sources", ...)
```

В `gamePage.test.tsx`: `it("about panel shows «Читать дальше» for long text and expands", ...)`.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/sanitizeSteamHtml.test.ts`

- [ ] **Step 3: Реализовать и подключить `AboutPanel` в `GamePage` (после `MediaStrip`)**

- [ ] **Step 4: Прогнать**

Run: `cd apps/web && bun test test/sanitizeSteamHtml.test.ts test/gamePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/sanitizeSteamHtml.ts apps/web/src/components/app/game apps/web/test
git commit -m "feat(web): описание игры из Steam с санитайзером и «Читать дальше»"
```

---

### Task 13: Панель достижений

**Files:**
- Create: `apps/web/src/components/app/game/AchievementsPanel.tsx`
- Modify: `apps/web/src/components/app/game/GamePage.tsx`
- Test: `apps/web/test/achievementsPanel.test.tsx`

**Interfaces:**
- Consumes: `GameAchievements` (Task 8), `Tooltip` из `components/ui/tooltip`.
- Produces: `AchievementsPanel({ achievements: GameAchievements })`: `None`/`Unlinked` → `null`; `Private` → панель «Достижения» с текстом «Steam скрывает твои достижения. Открой «Сведения об играх» в настройках приватности Steam» и ссылкой «Настройки приватности ↗» на `https://steamcommunity.com/my/edit/settings`; `Ready` → заголовок `Достижения · <unlocked.length> из <total>`, сетка `grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-1.5`: сначала `unlocked` (как есть, уже отсортированы сервером), затем `locked` (`opacity-40`, `iconGray`); у `hidden` закрытых — название «Скрытое достижение», без описания; первые 32, кнопка «ещё N». Каждая иконка — `img` с `alt={name}` внутри `Tooltip` (контент: имя + описание + для открытых `formatRelativeDate(unlockedAt)`).

- [ ] **Step 1: Тесты**

```tsx
it("Private → privacy notice with link", ...)
it("Ready → «Достижения · 2 из 5», unlocked first, locked dimmed, hidden locked titled «Скрытое достижение»", ...)
it("more than 32 → «ещё N» reveals all", ...)
it("None and Unlinked render nothing", ...)
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd apps/web && bun test test/achievementsPanel.test.tsx`

- [ ] **Step 3: Реализовать и подключить в `GamePage` (левая колонка, после `AboutPanel`)**

- [ ] **Step 4: Прогнать всё web**

Run: `cd apps/web && bun test && bun run check && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/game apps/web/test/achievementsPanel.test.tsx
git commit -m "feat(web): достижения Steam на странице игры"
```

---

### Task 14: Прогон на копии библиотеки владельца и правки по итогам

**Files:**
- Modify по итогам: любые из `apps/web/src/components/app/**`
- Modify: `docs/superpowers/specs/2026-10-27-app-cards-and-game-page-design.md` (статус «реализовано», отклонения)

Dev-окружение: БД `postgres://cg:cg@127.0.0.1:5442/cloud_gaming` уже содержит пользователя `u-smoke` с 1186 играми; dev-серверы запускаются из корня worktree `bun dev` (api :3000, web :5173). Миграции применяются при старте api. Вход в dev-браузере — через cookie `better-auth.session_token` (см. `deploy/README.md`, раздел про smoke-сессию) либо обычным входом по email-коду.

- [ ] **Step 1: Запустить dev и открыть `/app` на 1440×900, 1024×768, 390×844**

Проверить: ни одна секция не длиннее 24 плиток до клика (`document.querySelectorAll('a[aria-label^="Игра: "]').length <= 24 + 3 + 24`), общая высота страницы `document.documentElement.scrollHeight` меньше 5000 px на 1440; полоска и правая колонка остаются на месте при прокрутке к низу; в полоске нет «Установки»; у плитки готовой игры ровно одно значение справа; при наведении на неустановленную — «Установить».

- [ ] **Step 2: Открыть `/app/game/1086940` (Baldur's Gate 3) и `/app/game/<appId инструмента без магазина>`**

Проверить: описание на русском, скриншоты открываются в лайтбоксе, трейлер играет, достижения или подпись про закрытый профиль, ProtonDB, факты, сессии; у игры без магазина — шапка и «Steam не дал описание этой игры», в логах api нет ошибок (`grep -i error /tmp/cg-api.log`). Повторное открытие той же страницы не делает запрос к Steam Store (в логах api — один запрос на `appdetails` для 1086940).

- [ ] **Step 3: Исправить найденное, прогнать тесты**

Run: `cd apps/web && bun test && bun run check && cd ../api && bun test && bun run check`
Expected: PASS.

- [ ] **Step 4: Обновить статус в спеке и закоммитить**

```bash
git add -A apps/web/src docs/superpowers/specs/2026-10-27-app-cards-and-game-page-design.md
git commit -m "fix(web): правки /app и страницы игры по прогону на большой библиотеке"
```

- [ ] **Step 5: Показать владельцу скриншоты `/app` и страницы игры, дождаться приёмки перед мержем в `main` (мерж и деплой — отдельное решение владельца, см. `deploy/README.md`)**
