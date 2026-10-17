# Деплой на brofrong — game.brofrong.ru

## Что здесь

- `Dockerfile` — образ `cg-api`: `bun install --frozen-lockfile` (включает патч `drizzle-orm` из
  `patches/`), `bun run build` (собирает SPA в `apps/web/dist`), затем запускает
  `bun apps/api/src/main.ts` напрямую (api не транспилируется).
- `compose.yaml` — боевой compose-проект `cloud-gaming` на сервере: `cg-api` + `cg-postgres`.
- `deploy.sh` — rsync репозитория на `brofrong:~/cloud-gaming` + `docker compose up -d --build`.
- `compose.dev.yaml` — локальный Postgres для разработки/тестов (не трогать, не относится к проду).

## Топология на сервере

- Compose-проект `cloud-gaming` в `~/cloud-gaming`.
- `cg-postgres` (`postgres:18`, volume `cg-postgres-data`) — только во внутренней сети `cg`, порт
  наружу не публикуется.
- `cg-api` — сети `cg` (к базе) и внешняя `proxy` (к реверс-прокси ingressi), порт наружу не
  публикуется. Healthcheck: `GET /healthz`.
- Реверс-прокси (Caddy, `ingressi`) снаружи сети `proxy` проксирует `https://game.brofrong.ru` на
  `http://cg-api:3000` — это настраивает владелец сервера (см. шаг 2 ниже), наш деплой этого не
  делает и не трогает чужие контейнеры/сети/конфиг Caddy.

## Шаг 1 (один раз, локально): собрать `.env.production` и скопировать на сервер

**Никогда не печатать, не логировать и не коммитить значения секретов.**

1. Собрать `.env.production` в корне репозитория (файл в `.gitignore`, не коммитится) из корневого
   `.env` — копировать значения программно (`grep`/`sed`), не выводя их на экран:
   - `STEAM_API_KEY`, `POCKET_ID_URL`, `POCKET_ID_CLIENT_ID`, `POCKET_ID_CLIENT_SECRET`,
     `POCKET_ID_ADMIN_GROUP` — как в корневом `.env`.
   - `PUBLIC_URL=https://game.brofrong.ru`
   - `PORT=3000`
   - `WEB_DIST_DIR=/app/apps/web/dist`
   - `BETTER_AUTH_SECRET` — новый случайный (`openssl rand -hex 32`), отдельный от dev-секрета.
   - `POSTGRES_PASSWORD` — новый случайный пароль для `cg-postgres`.
   - `DATABASE_URL=postgres://cg:<POSTGRES_PASSWORD>@cg-postgres:5432/cloud_gaming` — тот же пароль,
     что в `POSTGRES_PASSWORD`.
2. `chmod 600 .env.production`.
3. Скопировать на сервер **один раз**: `scp -p .env.production brofrong:~/cloud-gaming/.env`
   (сначала `ssh brofrong 'mkdir -p ~/cloud-gaming'`, если каталога ещё нет).
   `deploy.sh` этот файл не создаёт и никогда не перезаписывает — повторный деплой его не трогает.
   Чтобы сменить секреты, копировать `.env` на сервер нужно вручную.

## Шаг 2 (ручной шаг владельца сервера)

1. **ingressi (Caddy)**, `https://proxy.brofrong.ru`: добавить хост `game.brofrong.ru` →
   `http://cg-api:3000`, WebSocket включён (нужен для `/rpc`), HTTPS (Let's Encrypt).
2. **Pocket ID**, `https://sso.brofrong.ru`: создать OIDC-клиента «Cloud Gaming» с callback-адресом
   **`https://game.brofrong.ru/api/auth/callback/pocket-id`**.

   > Важно: это путь `/api/auth/callback/pocket-id` (core-роут Better Auth `callback/:id` для
   > `genericOAuth`), а **не** `/api/auth/oauth2/callback/pocket-id` — такой путь был бы неверным.
   > См. Task 3 report, раздел Concerns, п. 1.

   Создать группу `cloud_gaming_admins`, добавить в неё себя. Client id/secret этого клиента
   записать в `POCKET_ID_CLIENT_ID`/`POCKET_ID_CLIENT_SECRET` в `.env.production` (шаг 1) ещё до
   копирования `.env` на сервер.

## Шаг 3: деплой

```sh
./deploy/deploy.sh
```

Скрипт:
1. `rsync` репозитория в `brofrong:~/cloud-gaming` (без `node_modules`, `.git`, `spike/nv`, `.env*`
   кроме `.env.example`).
2. Проверяет, что `~/cloud-gaming/.env` существует на сервере (падает с понятной ошибкой, если нет
   — см. шаг 1).
3. `ssh brofrong 'cd ~/cloud-gaming && docker compose -f deploy/compose.yaml --env-file .env up -d --build'`.

Повторный запуск безопасен: пересобирает образ и перезапускает только `cg-api`/`cg-postgres`,
другие ~39 контейнеров на сервере не трогает.

## Проверка после деплоя

```sh
curl -s https://game.brofrong.ru/healthz                       # ok
ssh brofrong 'docker ps --filter name=cg- --format "{{.Names}} {{.Status}}"'   # оба (healthy)
ssh brofrong 'docker ps --format "{{.Names}}" | sort'           # сравнить с «до» — число и состав
                                                                  # остальных контейнеров не изменились
curl -s https://game.brofrong.ru/ | head -c 200                 # отдаёт SPA (index.html)
curl -s -X POST https://game.brofrong.ru/api/auth/steam/login \
  -H 'Content-Type: application/json' -d '{"callbackURL":"/library"}'   # {"url":"https://steamcommunity.com/..."}
```

Реальный вход через Steam/Pocket ID не проверяется деплоем — это делает владелец сервера (шаг 4,
ниже), у него есть нужные аккаунты.

## Шаг 4 (приёмка, делает владелец)

- Вход через Steam на `https://game.brofrong.ru` → библиотека с Vampire Survivors и плашкой
  ProtonDB.
- Вход через Pocket ID на `/admin` → «Админка», `pong`.

## Если `https://game.brofrong.ru` отдаёт 502, а `cg-api` healthy

Проверять только нашу часть — контейнер/сеть `cg-api`, никогда конфиг Caddy/ingressi:

- `ssh brofrong 'docker inspect cg-api --format "{{json .NetworkSettings.Networks}}"'` — `cg-api`
  должен быть в сети `proxy` (и в `cg`).
- `ssh brofrong 'docker exec ingressi-caddy wget -qO- http://cg-api:3000/healthz'` (если на
  `ingressi-caddy` есть `wget`/`curl`) — проверка связности из сети `proxy`, не трогая конфиг.
- Если причина не в нашей сети/контейнере, сообщить владельцу с подробностями, а не менять его
  конфиг Caddy.
