# Меню сессии на экране стрима — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вместо «Выйти из игры» поверх стрима — неприметная кнопка меню (качество, отладка,
«Закончить игру») с подсказкой новичку, кнопка «На весь экран» с захватом клавиш и отладочная
статистика «Коротко»/«Подробно»; настройки и признак «меню уже открывали» хранятся в аккаунте.

**Architecture:** Настройки — строка `user_stream_settings` (jsonb) на пользователя, группа RPC
`streamSettings.*`; веб держит их локально (`useStreamSettings`), сохраняет с debounce и применяет к
Selkies через мост `selkiesBridge.ts` (`postMessage` в iframe того же origin) — на каждую загрузку
iframe, на каждое `serverSettings` Selkies и на каждое изменение. Статистика: Selkies 2.0 в режиме
WebRTC не отвечает на `getStats`, поэтому мост включает его сбор (`statsOpen`) и раз в секунду читает
`window.stream_stats.latest`/`window.stream_client` окна iframe; время кадра — `requestVideoFrameCallback`
на `<video>` Selkies (у WebRTC-пути `sink: "<video> element"`); минутное окно и перцентили — чистый
модуль `streamStats.ts`. «Авто» на сервере — `SELKIES_CONGESTION_CONTROL=true` в образе, перетег —
только по слову владельца.

**Tech Stack:** Bun, Effect 4 (`effect/rpc`, `effect/reactivity`, Schema), drizzle-orm 1.0 rc +
Postgres, React 19 + TanStack Router + Tailwind 4 + shadcn (`radix-ui` 1.8.1: Popover, Switch,
Slider, ToggleGroup), `bun test` + Testing Library (happy-dom).

**Spec:** `docs/superpowers/specs/2026-10-28-session-menu-design.md` (одобрена владельцем). Факты о
Selkies сверены по `selkies-core.js` образа (копия `/tmp/selkies-src/selkies-core.js`): путь WebRTC —
обработчик `message` с `case "settings"` (→ `vb,<n>`), `setManualResolution`,
`resetResolutionToWindow`, `statsOpen`, `requestFullscreen`; `getStats`/ответ `stats` есть только в
другом (websockets) пути; `serverSettings` Selkies шлёт `window.postMessage` в своё окно после
применения настроек сервера (в т.ч. «server-enforced manual resolution» 1920×1080 из
`SELKIES_MANUAL_WIDTH/HEIGHT`).

## Global Constraints

- Тексты интерфейса — точно как в спеке: кнопки «На весь экран» и меню (`aria-label` «Меню», иконка
  `lucide-react` `Menu`; у полноэкранной — `Maximize`); плашка «Здесь **настройки игры** и выход»;
  разделы «Качество», «Отладка»; переключатель «Авто — под вашу сеть»; ползунок «Битрейт» (значение
  «N Мбит/с»), под ним мелко «максимум; при плохой сети будет ниже»; «Разрешение»: «По окну» /
  «720p» / «1080p» / «1440p»; отладка «Выкл» / «Коротко» / «Подробно»; «Закончить игру» → диалог
  «Закончить игру? Прогресс сохранится.» / «Игра закроется, сохранения синхронизируются со Steam
  Cloud.» / «Продолжить играть» / «Закончить игру» (тексты нынешнего `ExitButton`).
- Значения: битрейт 2–40 Мбит/с (целые), потолок «Авто» 20 Мбит/с; разрешения 720p = 1280×720,
  1080p = 1920×1080, 1440p = 2560×1440; окно статистики 60 с, обновление раз в 1 с, порог плохого
  кадра 25 мс; сбор статистики — только при отладке не «Выкл».
- Не цели: частота кадров, кодек, звук, микрофон, горячая клавиша меню, мобильная вёрстка.
- Не сломать: iframe — первый ребёнок `<main>` в `Player` (не переподключается), экран загрузки
  поверх скрытого стрима (`hidden`/`inert`), `IdlePrompt`, `useInputActivity` (`onFrameLoad` по-прежнему
  получает каждый `load`). Кнопки и статистика — только когда показан стрим (`!loading`).
- Настройки — новая таблица `user_stream_settings`, не колонки в `user` (ветка `feat/admin-users`
  меняет `user`). Миграции: `cd packages/db && bunx drizzle-kit generate --name <имя>`,
  `snapshot.json` руками не править; если `feat/admin-users` попадёт в `main` раньше — при слиянии
  удалить свою папку миграции и сгенерировать заново поверх.
- Токен и имя аккаунта Steam к этому не относятся: из глобалов Selkies читаются только перечисленные
  в Task 2 числовые поля и `codec`/`resolution`; объекты Selkies целиком не логировать и не
  отображать.
- Комментарии и шапки файлов — по-русски, как в соседнем коде; shadcn-примитивы — поверх
  `radix-ui` (как `components/ui/tooltip.tsx`), новых npm-зависимостей нет; цвета — `--brand-*`
  (`text-brand-cyan`, `text-brand-warn` и т. п.).
- Тесты: в корне `TEST_DATABASE_URL=postgres://cg:cg@127.0.0.1:5442/postgres bun run test`,
  `bun run check --force`, `bun run lint`; по пакету — `bun test` в его каталоге (api — с тем же
  `TEST_DATABASE_URL` в окружении; web — из `apps/web`, там preload happy-dom).
- `.env`, `.env.*` (кроме `.env.example`) не открывать, не печатать, не коммитить.
- Сервер brofrong: деплой — только по `deploy/README.md`, только со слова владельца и без живых
  `cg.session`/`cg.install` (`docker ps --filter label=cg.session` и `label=cg.install` пусто); `main`
  в `~/work/imt-cloud-gaming` — общий чекаут: перед слиянием проверить ветку и статус, `main` двигать
  по ref, деплоить из чистого worktree на `main`. `cg-session:<версия>` перетегивать только со
  слова владельца; без sudo, без `docker * prune`, чужие контейнеры/образы не трогать.
- Коммиты на русском, последней строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  ничего не пушить и не сливать в `main` без слова владельца; чужие `.DS_Store` не коммитить.

## Review Focus

1. **Unity-игра и смена разрешения.** `images/session/Dockerfile` фиксирует 1920×1080, потому что
   Unity-игры (Vampire Survivors) падают на смене выходов XRandR. Поэтому «Авто» шлёт
   `setManualResolution 1920×1080` (то же, что сегодня), а не «По окну»; «По окну» и смена
   разрешения — только явный выбор игрока. Тест — Task 2, `auto keeps the image resolution`;
   живая проверка — Task 7, шаг Unity.
2. **Selkies перезаписывает наши настройки после подключения** (server-enforced 1920×1080, свой
   `localStorage` от прошлой сессии на общем origin, перезагрузка iframe по 5xx): настройки
   повторно применяются на `serverSettings` и на каждый `load`, старый слушатель снимается. Тесты —
   Task 2, `serverSettings re-applies the current settings`, `reattach drops the old listener`.
3. **Вкладка свёрнута / видео на паузе:** промежуток в десятки секунд между кадрами не должен
   считаться одним кадром (испортил бы p99, макс и 1% low). Тест — Task 3, `gaps over a second are
   not frames`.
4. **Игрок меняет настройку и сразу жмёт «Закончить игру»:** отложенное сохранение не теряется при
   размонтировании. Тест — Task 1, `pending save is flushed on unmount`.
5. **После меню клавиши снова идут в игру:** закрытие меню (клик мимо, Esc, «Продолжить играть» в
   диалоге) возвращает фокус в iframe, а не на кнопку меню. Тест — Task 4, `closing the menu returns
   focus to the stream`.

---

### Task 1: Запоминание — таблица, RPC `streamSettings.*`, api, хук веба

**Files:**
- Modify: `packages/db/src/schema/sessions.ts` (таблица рядом с `settings`); миграция
  `cd packages/db && bunx drizzle-kit generate --name user_stream_settings`
- Create: `packages/rpc/src/streamSettings.ts`; Modify: `packages/rpc/src/index.ts` (экспорт, группа в
  `AppRpcs`, шапка-комментарий)
- Create: `apps/api/src/streamSettings/StreamSettingsRepo.ts`, `apps/api/src/streamSettings/rpc.ts`;
  Modify: `apps/api/src/http.ts` (`RpcHandlers`)
- Modify: `apps/web/src/rpc.ts`; Create: `apps/web/src/lib/useStreamSettings.ts`
- Test: `packages/rpc/test/streamSettings.test.ts`, `apps/api/test/streamSettings.test.ts` (по образцу
  `time.test.ts`), `apps/web/test/streamSettings.test.tsx`

**Interfaces:**
- Produces:
  - `userStreamSettings = pgTable("user_stream_settings", { userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }), value: jsonb("value").notNull(), updatedAt: timestamptz("updated_at").notNull().defaultNow().$onUpdate(() => new Date()) })`.
  - `@cg/rpc`:
    ```ts
    StreamQuality = Schema.Literals(["auto", "manual"])
    StreamResolution = Schema.Literals(["window", "720p", "1080p", "1440p"])
    DebugMode = Schema.Literals(["off", "short", "detailed"])
    minBitrateMbps = 2; maxBitrateMbps = 40; autoBitrateMbps = 20
    StreamSettings = Schema.Struct({
      quality: StreamQuality,
      bitrateMbps: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 40 })), // ручной потолок
      resolution: StreamResolution,                                                 // ручной режим
      debug: DebugMode,
      menuSeen: Schema.Boolean,                                                     // меню уже открывали
    })
    defaultStreamSettings: StreamSettings = { quality: "auto", bitrateMbps: 20, resolution: "1080p", debug: "off", menuSeen: false }
    decodeStreamSettings(value: unknown): StreamSettings
    StreamSettingsRpcs = RpcGroup.make(
      Rpc.make("streamSettings.get", { success: StreamSettings }),
      Rpc.make("streamSettings.save", { payload: StreamSettings, success: StreamSettings }),
    ).middleware(AuthMiddleware)
    ```
  - api: `loadStreamSettings(userId: string): Effect<StreamSettings, never, Db>`,
    `saveStreamSettings(userId: string, value: StreamSettings): Effect<StreamSettings, never, Db>`;
    `StreamSettingsRpcHandlers` (пользователь — `CurrentUser`, как в `time/rpc.ts`).
  - web `rpc.ts`: `streamSettingsAtom = Api.query("streamSettings.get", undefined, { reactivityKeys: streamSettingsKeys })`,
    `saveStreamSettingsAtom = Api.mutation("streamSettings.save")`, `saveStreamSettingsArgs(settings)` →
    `{ payload: settings, reactivityKeys: streamSettingsKeys }` (следующая сессия читает свежие).
  - `useStreamSettings.ts`:
    ```ts
    type StreamSettingsControl = { readonly settings: StreamSettings; readonly loaded: boolean; readonly update: (patch: Partial<StreamSettings>) => void }
    SAVE_DEBOUNCE_MS = 500
    useStreamSettingsState(loaded: StreamSettings | undefined, save: (settings: StreamSettings) => Promise<unknown>): StreamSettingsControl
    useStreamSettings(): StreamSettingsControl   // обёртка над атомами
    ```

- [ ] **Step 1: Write the failing tests:**
  - `packages/rpc/test/streamSettings.test.ts`: `schema rejects bitrate 1, 41 and 2.5`;
    `decode falls back per field`: `decodeStreamSettings({ quality: "turbo", bitrateMbps: 99, debug: "detailed", menuSeen: true, extra: 1 })`
    → `{ ...defaultStreamSettings, debug: "detailed", menuSeen: true }` (без `extra`);
    `"garbage"`, `null`, `[]` → `defaultStreamSettings`.
  - `apps/api/test/streamSettings.test.ts`: `get returns defaults when nothing is stored`;
    `save then get returns the saved value` (второй `save` перезаписывает, строка одна);
    `broken stored value falls back per field` (сырая вставка jsonb как выше);
    `settings are per user` (строка другого пользователя → у текущего умолчания).
  - `apps/web/test/streamSettings.test.tsx` (`renderHook`, `jest.useFakeTimers()`):
    `defaults until loaded` (`loaded: false`, `settings` = умолчания);
    `loaded value is adopted once` (повторная смена `loaded` не перетирает правки);
    `edits before load win over the loaded value` (`update({ debug: "short" })`, затем пришло
    `{ ...defaults, menuSeen: true }` → `{ debug: "short", menuSeen: true, … }`);
    `update applies at once and saves once after 500 ms` (три `update` за 100 мс → `save` один раз
    с итоговым значением через 500 мс, до этого 0 раз);
    `save failure keeps the settings` (`save` отклоняется → нет исключения, `settings` прежние);
    `pending save is flushed on unmount` (`update`, `unmount` до 500 мс → `save` вызван сразу).
- [ ] **Step 2: Run** `cd packages/rpc && bun test test/streamSettings.test.ts`;
  `cd apps/api && TEST_DATABASE_URL=postgres://cg:cg@127.0.0.1:5442/postgres bun test test/streamSettings.test.ts`;
  `cd apps/web && bun test test/streamSettings.test.tsx` — FAIL (нет модулей).
- [ ] **Step 3: Implement.** `decodeStreamSettings`: не объект — умолчания; иначе каждое поле
  `Schema.decodeUnknownOption(<схема поля>)`, `None` → поле умолчаний. `saveStreamSettings` — upsert
  ровно полей схемы (как `saveSessionSettings`). Ошибки БД — дефекты (`Effect.orDie`). Хук: локальное
  состояние, `update` мерджит и ставит таймер `SAVE_DEBOUNCE_MS`; ошибка сохранения —
  `console.warn("Stream settings not saved")` без значений, тоста нет (настройка уже применена);
  `useStreamSettings` берёт значение из `AsyncResult.value(streamSettingsAtom)`, ошибка загрузки —
  `loaded` остаётся `false` (подсказки нет, работают умолчания).
- [ ] **Step 4: Run** те же тесты — PASS; затем пакеты целиком и `bun run check --force`.
- [ ] **Step 5: Commit** `feat: настройки стрима в аккаунте — таблица, RPC streamSettings, хук веба`.

### Task 2: Мост к Selkies

**Files:**
- Create: `apps/web/src/lib/selkiesBridge.ts`
- Test: `apps/web/test/selkiesBridge.test.ts`

**Interfaces:**
- Consumes: Task 1 — `StreamSettings`, `autoBitrateMbps`.
- Produces:
  ```ts
  STREAM_RESOLUTIONS = { "720p": { width: 1280, height: 720 }, "1080p": { width: 1920, height: 1080 }, "1440p": { width: 2560, height: 1440 } } as const
  AUTO_RESOLUTION = STREAM_RESOLUTIONS["1080p"]   // разрешение образа; см. Review Focus 1
  type SelkiesMessage =
    | { type: "settings"; settings: { video_bitrate: number } }   // кбит/с
    | { type: "setManualResolution"; width: number; height: number }
    | { type: "resetResolutionToWindow" }
    | { type: "statsOpen"; open: boolean }
  settingsMessages(settings: StreamSettings): ReadonlyArray<SelkiesMessage>          // [битрейт, разрешение]
  changedSettingsMessages(prev: StreamSettings, next: StreamSettings): ReadonlyArray<SelkiesMessage>
  type SelkiesSample = { fps: number | null; mbps: number | null; rttMs: number | null; decodeMs: number | null;
    jitterMs: number | null; lossPercent: number | null; framesDropped: number | null; codec: string | null; resolution: string | null }
  readSelkiesStats(win: Window | null): SelkiesSample | null
  type SelkiesBridge = {
    attach(frame: HTMLIFrameElement): void      // на каждый load iframe
    update(prev: StreamSettings, next: StreamSettings): void
    setStatsOpen(open: boolean): void
    frameWindow(): Window | null
    detach(): void
  }
  createSelkiesBridge(getSettings: () => StreamSettings): SelkiesBridge
  ```
  Поля `SelkiesSample` ← `stream_stats.latest`: `fps`, `mbps`, `rtt_ms`, `decode_ms`,
  `jitter_buffer_ms`, `packet_loss_percent`, `frames_dropped`; ← `stream_client`: `codec`,
  `resolution`. Не число/не строка — `null`.

- [ ] **Step 1: Write the failing tests** (фейковые `frame`/окно: `{ contentWindow: { postMessage: mock(), addEventListener, removeEventListener } } as unknown as HTMLIFrameElement`):
  - `auto keeps the image resolution`: `settingsMessages(defaultStreamSettings)` →
    `[{ type: "settings", settings: { video_bitrate: 20000 } }, { type: "setManualResolution", width: 1920, height: 1080 }]`.
  - `manual sends the chosen ceiling and resolution`: `{ quality: "manual", bitrateMbps: 8, resolution: "720p" }`
    → `video_bitrate: 8000`, `1280×720`; `resolution: "window"` → `{ type: "resetResolutionToWindow" }`.
  - `only changed values are sent`: смена только битрейта → один `settings`; смена `debug`/`menuSeen` → `[]`;
    `auto` → `manual` при умолчаниях (20, 1080p) → `[]`.
  - `attach posts all settings with the page origin`: `postMessage` вызван с каждым сообщением и
    `"http://localhost:3000"`.
  - `serverSettings re-applies the current settings`: после `attach` слушатель окна iframe получает
    `{ data: { type: "serverSettings" } }` → снова все сообщения, уже по новому `getSettings()`;
    другие типы сообщений — ничего.
  - `reattach drops the old listener`: второй `attach` (новое окно) снимает слушатель со старого;
    `postMessage`, бросающий исключение, не роняет `attach`/`update`.
  - `stats open survives a reload`: `setStatsOpen(true)` → `{ type: "statsOpen", open: true }`;
    следующий `attach` шлёт его снова; `setStatsOpen(false)` → `open: false`, после `attach` не шлётся.
  - `readSelkiesStats picks only known fields`: окно с `stream_stats.latest` (`fps: 59.8, mbps: 18.42, rtt_ms: 12.3, decode_ms: 2.1, jitter_buffer_ms: 4, packet_loss_percent: 0.2, frames_dropped: 12, account: "x"`)
    и `stream_client` (`codec: "H264", resolution: "1920x1080"`) → ровно объект `SelkiesSample` из
    этих значений (без `account`); `latest: null` → `null`; `fps: "60"` → `fps: null`; геттер окна
    бросает → `null`.
- [ ] **Step 2: Run** `cd apps/web && bun test test/selkiesBridge.test.ts` — FAIL.
- [ ] **Step 3: Implement** `selkiesBridge.ts`. Отправка —
  `frame.contentWindow.postMessage(msg, window.location.origin)` в `try`; слушатель — `message` на
  `frame.contentWindow` (Selkies шлёт `serverSettings` в своё окно, родителю не пишет). Шапка файла —
  кратко факты §5 спеки с поправкой про `getStats` (см. заголовок плана).
- [ ] **Step 4: Run** тот же тест — PASS; `bun run check --force`.
- [ ] **Step 5: Commit** `feat(web): мост к Selkies — настройки стрима и чтение статистики`.

### Task 3: Окно статистики за минуту

**Files:**
- Create: `apps/web/src/lib/streamStats.ts`
- Test: `apps/web/test/streamStats.test.ts`

**Interfaces:**
- Consumes: Task 2 — `SelkiesSample`.
- Produces:
  ```ts
  STATS_WINDOW_MS = 60_000; BAD_FRAME_MS = 25; BAD_PING_MS = 50; BAD_DECODE_MS = 10; MAX_FRAME_GAP_MS = 1_000
  type Percentiles = { p50: number; p90: number; p95: number; p99: number; max: number }
  percentiles(values: ReadonlyArray<number>): Percentiles | null      // ближайший ранг: sorted[ceil(p/100·n) − 1]
  onePercentLowFps(frameMs: ReadonlyArray<number>): number | null      // 1000 / среднее худших max(1, ceil(n/100)) кадров
  type Point = { at: number; value: number }
  type StatsSnapshot = {
    fps: number | null            // кадров за последнюю секунду; кадров нет — Selkies `fps`
    low1: number | null
    frameTimes: ReadonlyArray<Point>; ping: ReadonlyArray<Point>; bitrate: ReadonlyArray<Point>
    table: { frame: Percentiles | null; ping: Percentiles | null; decode: Percentiles | null }
    latest: SelkiesSample | null
  }
  createStatsWindow(): {
    addFrame(at: number, frameMs: number): void   // часы родителя; frameMs > MAX_FRAME_GAP_MS отбрасывается
    addSample(at: number, sample: SelkiesSample): void
    snapshot(now: number): StatsSnapshot           // выкидывает всё с at <= now − 60 000
    clear(): void
  }
  ```

- [ ] **Step 1: Write the failing tests:**
  - `percentiles of 1..100`: `{ p50: 50, p90: 90, p95: 95, p99: 99, max: 100 }`; `[]` → `null`; `[7]` → все 7.
  - `one percent low`: 99 кадров по 10 мс + один 50 мс → `20`; 198 × 10 + 2 × 40 → `25`; `[]` → `null`.
  - `fps counts frames of the last second`: кадры каждые 16 мс на `[0, 2000)` → `snapshot(2000).fps` = 62
    (число `at` в `(1000, 2000]`); без кадров, `latest.fps = 59.8` → `59.8`.
  - `gaps over a second are not frames`: `addFrame(…, 30_000)` → `frameTimes`, `table.frame`, `low1` его не содержат.
  - `old points leave the window`: кадр и выборка в `at = 0` → `snapshot(60_001)` пуст; в `60_000` — ещё есть
    при `now = 119_999`.
  - `samples feed ping, bitrate and decode`: три выборки (`rttMs` 10/20/30, `mbps` 18, `decodeMs` 2)
    → `ping` три точки, `table.ping.max = 30`, `table.decode.p50 = 2`; выборка с `rttMs: null` в
    `ping` не попадает; `latest` — последняя выборка.
- [ ] **Step 2: Run** `cd apps/web && bun test test/streamStats.test.ts` — FAIL.
- [ ] **Step 3: Implement** `streamStats.ts` (массивы точек, вытеснение с начала).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): статистика стрима — окно минуты, перцентили, 1% low`.

### Task 4: Кнопки, подсказка, меню, полный экран

**Files:**
- Create: `apps/web/src/components/ui/popover.tsx`, `switch.tsx`, `slider.tsx`, `toggle.tsx`,
  `toggle-group.tsx` (shadcn new-york, импорт из `radix-ui`)
- Create: `apps/web/src/components/session/SessionControls.tsx` (кнопки, подсказка, поповер, диалог
  выхода), `apps/web/src/components/session/SessionMenu.tsx` (содержимое панели)
- Create: `apps/web/src/lib/fullscreen.ts`
- Modify: `apps/web/src/components/Player.tsx` (убрать `ExitButton`), `apps/web/src/routes/session.$id.tsx`
- Test: `apps/web/test/sessionMenu.test.tsx` (новый), `apps/web/test/session.test.tsx` («Выйти из
  игры» → кнопка «Меню»; выход — через меню)

**Interfaces:**
- Consumes: Task 1 — `StreamSettingsControl`, `useStreamSettings`, `defaultStreamSettings`,
  `min/maxBitrateMbps`; Task 2 — `SelkiesBridge`, `createSelkiesBridge`.
- Produces:
  - `Player` — новые необязательные пропсы: `streamSettings?: StreamSettingsControl` (по умолчанию
    умолчания, `loaded: false`, `update` — noop) и `bridge?: SelkiesBridge` (по умолчанию создаётся
    один раз на `Player` из `createSelkiesBridge(() => актуальные settings)`). На каждый `load` iframe:
    `bridge.attach(frame)`, счётчик `frameGeneration` +1, затем `onFrameLoad?.(frame)`. Смена
    `settings` → `bridge.update(prev, next)`. Размонтирование → `bridge.detach()`. `<main ref>` —
    корень полного экрана.
  - `fullscreen.ts`: `enterFullscreen(root: HTMLElement, frame: HTMLIFrameElement | null): Promise<void>`
    (`root.requestFullscreen()`, затем `navigator.keyboard?.lock?.()` с проглоченной ошибкой, затем
    `focusStream(frame)`); `focusStream(frame: HTMLIFrameElement | null): void` (`frame.focus()` и
    `contentWindow.focus()` в `try`); `useIsFullscreen(): boolean` (по `fullscreenchange`; при выходе —
    `navigator.keyboard?.unlock?.()`). Тип `keyboard` — локальное расширение `Navigator`.
  - `SessionControls({ control, onExit, rootRef, frameRef })` — правый верхний угол, `z-30`.
    `SessionMenu({ settings, onChange, onEndGame })`.
  - Route: `const streamSettings = useStreamSettings()` → `<Player streamSettings={streamSettings} … />`.

Вид (спека §2): кнопки ~34 px (`size-[34px]`), `opacity-60`, ярче при `hover`/`focus-visible`.
Подсказка — при `control.loaded && !settings.menuSeen`: кольцо `--brand-cyan` с пульсацией (при
`usePrefersReducedMotion` — без анимации) и плашка слева, `pointer-events-none`. Открытие меню при
`!menuSeen` → `update({ menuSeen: true })`. Поповер ~300 px под кнопкой; Esc закрывает только вне
полного экрана (`onEscapeKeyDown` → `preventDefault`, если `useIsFullscreen()`); `onCloseAutoFocus` →
`preventDefault` + `focusStream`. «Закончить игру» в меню закрывает поповер и открывает
`AlertDialog` (управляемый); его закрытие тоже возвращает фокус в стрим. Ползунок: значение на экране
меняется при перетаскивании, `update({ bitrateMbps })` — в `onValueCommit`. Переключатель «Авто»:
`update({ quality: checked ? "auto" : "manual" })`; ползунок и «Разрешение» видны только в ручном
режиме; «Разрешение» и «Отладка» — `ToggleGroup type="single"` (пустой выбор игнорировать).

- [ ] **Step 1: Write the failing tests** (`sessionMenu.test.tsx`; `Player` в `playing` с фейковым
  `bridge` из `mock()` и `streamSettings` из теста; `HTMLElement.prototype.requestFullscreen`,
  `document.fullscreenElement`, `navigator.keyboard` — заглушки на время теста):
  - `menu button replaces the exit button`: есть «Меню» и «На весь экран», нет «Выйти из игры»; под
    экраном загрузки (`starting` со `stage: "login"`) — ни одной из двух.
  - `hint waits for loaded settings and goes away on first open`: `loaded: false` → нет текста
    «настройки игры»; `loaded: true, menuSeen: false` → есть; клик «Меню» → `update` с
    `{ menuSeen: true }`; перерисовка с `menuSeen: true` → текста нет; второе открытие `update` с
    `menuSeen` не вызывает.
  - `auto hides manual controls`: в «Авто» нет «Битрейт»/«Разрешение»; клик по «Авто — под вашу сеть»
    → `update({ quality: "manual" })`; при `manual` — ползунок со значением «20 Мбит/с», подпись
    «максимум; при плохой сети будет ниже», клик «720p» → `update({ resolution: "720p" })`.
  - `slider commits on release`: фокус на бегунке, `ArrowRight` → `update({ bitrateMbps: 21 })`.
  - `debug mode switch`: «Подробно» → `update({ debug: "detailed" })`.
  - `end game asks for confirmation`: «Меню» → «Закончить игру» → диалог «Закончить игру? Прогресс
    сохранится.»; `onExit` не вызван; «Закончить игру» в диалоге → `onExit` один раз.
  - `closing the menu returns focus to the stream`: открыть меню, `Escape` → меню закрыто,
    `document.activeElement` — iframe; то же после «Продолжить играть» в диалоге.
  - `escape does not close the menu in fullscreen`: `document.fullscreenElement` = `<main>` +
    `fullscreenchange` → `Escape` не закрывает меню.
  - `fullscreen locks the keyboard and hides its button`: клик «На весь экран» → `requestFullscreen`
    вызван на `<main>`, затем `keyboard.lock`; без `navigator.keyboard` — без ошибки; после
    `fullscreenchange` кнопки нет; выход из полного экрана → `keyboard.unlock`.
  - `frame load attaches the bridge and input`: `fireEvent.load(iframe)` → `bridge.attach(iframe)` и
    `onFrameLoad(iframe)`; перерисовка с `debug: "short"` → `bridge.update(prev, next)`.
  - `session.test.tsx`: проверки «Выйти из игры» заменить на «Меню»; `exit asks for confirmation
    before stopping` — через меню.
- [ ] **Step 2: Run** `cd apps/web && bun test test/sessionMenu.test.tsx test/session.test.tsx` — FAIL.
- [ ] **Step 3: Implement** примитивы, `fullscreen.ts`, `SessionMenu`, `SessionControls`, `Player`,
  маршрут. Если happy-dom не хватает API для Radix (`ResizeObserver`, `hasPointerCapture`) — заглушки
  в `test/setup.ts` с комментарием.
- [ ] **Step 4: Run** `cd apps/web && bun test`, `bun run check --force`, `bun run lint` — PASS/чисто.
- [ ] **Step 5: Проба захвата клавиш (throwaway, локально, Chrome):** временная страница вне репозитория
  (`bun` статикой с `localhost`), iframe того же origin с логом `keydown` в iframe; в родителе
  `requestFullscreen` + `navigator.keyboard.lock()` и фокус в iframe. Нажать Esc (коротко), Alt+Tab,
  Win/Cmd, F11: доходят ли до лога iframe. Итог — строкой в «Результаты» спеки. Не доходят — заменить
  в `enterFullscreen` захват на `bridge` → `{ type: "requestFullscreen" }` (спека §2.4), тест поправить.
- [ ] **Step 6: Commit** `feat(web): меню сессии — качество, отладка, выход, полный экран`.

### Task 5: Отладочная плашка «Коротко» / «Подробно»

**Files:**
- Create: `apps/web/src/lib/useStreamStats.ts`, `apps/web/src/components/session/StatsOverlay.tsx`,
  `apps/web/src/components/session/Sparkline.tsx`
- Modify: `apps/web/src/components/Player.tsx` (плашка слева от кнопок, только при `!loading` и
  `debug !== "off"`)
- Test: `apps/web/test/statsOverlay.test.tsx`

**Interfaces:**
- Consumes: Task 2 — `SelkiesBridge`, `readSelkiesStats`; Task 3 — `createStatsWindow`,
  `StatsSnapshot`, пороги; Task 4 — `frameGeneration`, `bridge` в `Player`.
- Produces:
  - `STATS_TICK_MS = 1_000`; `useStreamStats(bridge: SelkiesBridge, frameGeneration: number, mode: DebugMode): StatsSnapshot | null`
    — `off`: `bridge.setStatsOpen(false)`, ни таймеров, ни `rVFC`, `null`. Иначе
    `setStatsOpen(true)`; раз в секунду `readSelkiesStats(bridge.frameWindow())` → `addSample(performance.now(), …)`,
    проверка `<video>` в `frameWindow().document` (сменился — перерегистрировать
    `requestVideoFrameCallback`), `snapshot` в состояние. Время кадра — разность `now` соседних
    колбэков (часы iframe), метка `at` — `performance.now()` родителя. Смена `frameGeneration` —
    `clear()` и новая регистрация. Нет `requestVideoFrameCallback` — кадров нет, FPS из Selkies.
  - `StatsOverlay({ mode: "short" | "detailed", snapshot: StatsSnapshot | null })`;
    `sparklineGeometry(points: ReadonlyArray<Point>, now: number, size: { width: number; height: number }, threshold?: number): { path: string; p95Y: number | null; dots: ReadonlyArray<{ x: number; y: number; point: Point }> }`
    (x — время в окне 60 с, y — от 0 до максимума ряда; `dots` — точки выше `threshold`);
    `Sparkline({ label, unit, points, now, threshold? })` — у «Время кадра» порог `BAD_FRAME_MS`, у
    остальных нет.

Числа — `toLocaleString("ru-RU", { maximumFractionDigits: 1 })`, разрешение `1920x1080` → `1920×1080`,
нет значения — «—». Плашка: `pointer-events-none`, полупрозрачный тёмный фон, `font-mono`; в
«Подробно» графики — `pointer-events-auto`. Перед кодом графиков — skill `dataviz` (тонкая линия,
пунктир p95, точки над порогом).

- [ ] **Step 1: Write the failing tests:**
  - `short shows two lines`: снимок (`fps` 60, `rttMs` 12, `mbps` 18.42, `resolution` "1920x1080",
    `lossPercent` 0.2) → строки «60 FPS · 12 мс · 18,4 Мбит/с» и «1920×1080 · потери 0,2 %»; `null` →
    «— FPS · — мс · — Мбит/с».
  - `detailed shows header, charts and table`: «60 FPS · 1% low 41», «H264 1920×1080», «потери 0,2 % ·
    джиттер 4 мс · выпавших кадров 12»; три графика `role="img"` с именами «Время кадра», «Пинг»,
    «Битрейт»; таблица со столбцами p50/p90/p95/p99/макс и строками «Кадр, мс», «Пинг, мс», «Декодер, мс»;
    ячейка хуже порога (кадр 30 мс, пинг 60 мс, декодер 12 мс) — `data-bad="true"` и `text-brand-warn`.
  - `chart hover shows value and age`: `pointerMove` над графиком у точки 5 с назад → «12,3 мс · 5 с назад».
  - `sparkline geometry`: две точки на краях окна → `path` от `x = 0` до `x = width`; точка 30 мс при
    `threshold` 25 — в `dots`; пустой ряд → `path: ""`, `p95Y: null`.
  - `stats hook is idle when off`: `mode: "off"` → `setStatsOpen(false)`, через 3 с `frameWindow` не
    вызывался, результат `null`.
  - `stats hook samples Selkies and frames`: фейковое окно (`stream_stats.latest`, `document.querySelector("video")`
    → объект с `requestVideoFrameCallback`, колбэк сохраняется); вызвать колбэк с `now` 0, 16, 32, …
    и продвинуть таймер на 1 с → `fps` > 0, `latest.rttMs` из окна; смена `frameGeneration` → окно
    очищено, колбэк зарегистрирован заново.
  - `Player shows the overlay only over the stream`: `debug: "short"` в `playing` — плашка есть; под
    экраном загрузки — нет.
- [ ] **Step 2: Run** `cd apps/web && bun test test/statsOverlay.test.tsx` — FAIL.
- [ ] **Step 3: Implement** хук, `Sparkline`, `StatsOverlay`, вставку в `Player` (после `IdlePrompt`,
  до `SessionControls`; iframe остаётся первым).
- [ ] **Step 4: Run** `cd apps/web && bun test`, `bun run check --force`, `bun run lint` — PASS/чисто.
- [ ] **Step 5: Commit** `feat(web): отладочная статистика стрима — коротко и подробно`.

### Task 6: Образ — подстройка битрейта Selkies (серверная часть — по слову владельца)

**Files:**
- Modify: `images/session/Dockerfile` (блок `ENV` с `SELKIES_*`)
- Modify: `deploy/README.md` — раздел «Смена образа сессии: перетег и откат»

- [ ] **Step 1:** в `ENV` после `SELKIES_VIDEO_BITRATE` — `SELKIES_CONGESTION_CONTROL=true` и
  комментарий: подстройка битрейта под сеть по отчётам WebRTC; битрейт из меню сессии — её потолок
  («Авто» — 20 Мбит/с).
- [ ] **Step 2:** в README — подраздел «Подстройка битрейта (меню сессии, 2026-10-28)»: сборка
  `./deploy/build-session-image.sh brofrong cc` → `cg-session:550.163.01-cc`; проверка
  (`docker image inspect … --format '{{json .Config.Env}}'` содержит `SELKIES_CONGESTION_CONTROL=true`);
  перетег без сессий и установок
  `ssh brofrong 'docker tag cg-session:550.163.01 cg-session:550.163.01-nocc && docker tag cg-session:550.163.01-cc cg-session:550.163.01'`
  и `./deploy/build-steam-client.sh`; откат `ssh brofrong 'docker tag cg-session:550.163.01-nocc cg-session:550.163.01'`.
  Без перетега меню работает, «Авто» = фиксированные 20 Мбит/с.
- [ ] **Step 3: Commit** `feat(image): подстройка битрейта Selkies под сеть` (без сервера).
- [ ] **Step 4:** (слово владельца, нет живых `cg.session`/`cg.install`) сборка `-cc` по README;
  что Selkies образа знает настройку: во временном контейнере `docker run --rm --entrypoint sh
  cg-session:550.163.01-cc -c '…'` найти каталог пакета (`python3 -c 'import selkies, os;
  print(os.path.dirname(selkies.__file__))'`) и `grep -rl congestion_control` в нём → непусто. Пусто
  или пакет не найден — стоп, к владельцу (в этой версии настройка называется иначе).
- [ ] **Step 5:** (слово владельца) перетег и `build-steam-client.sh` по README; сессия владельца
  стартует, в `docker logs <контейнер сессии>` есть упоминание congestion control (только `grep -ci`,
  без вывода строк с аккаунтом); не стартует — сразу откат.
- [ ] **Step 6: Commit** (если README уточнялся по факту) `docs: перетег образа с подстройкой битрейта`.

### Task 7: Деплой и проверка владельцем (по слову владельца)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-28-session-menu-design.md` — раздел «Результаты»

- [ ] **Step 1:** (слово владельца) слияние `feat/session-menu` в `main` по правилам общего чекаута;
  деплой из чистого worktree на `main`: без живых `cg.session`/`cg.install`, `./deploy/deploy.sh`,
  «Проверка после деплоя» из README; таблица на месте:
  `ssh brofrong 'docker exec cg-postgres psql -U cg -d cloud_gaming -c "\d user_stream_settings"'`.
- [ ] **Step 2:** ручная проверка владельцем в Chrome: подсказка видна до первого открытия и не
  возвращается в другом браузере; настройки переживают новую сессию; ручной битрейт 5 Мбит/с —
  в «Коротко» битрейт ≤ 5; 720p — разрешение в статистике 1280×720; полный экран: короткий Esc и
  Alt+Tab уходят в игру, удержание Esc выходит; после закрытия меню клавиши идут в игру;
  «Подробно» — графики и таблица правдоподобны, 1% low не выше FPS.
- [ ] **Step 3:** Unity-игра (Vampire Survivors): «По окну» + вход/выход из полного экрана и
  переключение 720p ↔ 1080p во время игры — игра не падает. Падает — стоп, к владельцу (варианты:
  скрыть «По окну»/смену разрешения во время игры для таких игр или оставить с предупреждением).
- [ ] **Step 4:** в консоли страницы и логах `cg-api` нет имени аккаунта Steam (`grep -c`, значение
  не печатать).
- [ ] **Step 5: Commit** `docs: проверка меню сессии владельцем`.
