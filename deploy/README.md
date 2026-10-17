# Деплой на brofrong — game.brofrong.ru

## Что здесь

- `Dockerfile` — один образ приложения `cloud-gaming/cg-api:latest`: `bun install --frozen-lockfile`
  (включает патч `drizzle-orm` из `patches/`), `bun run build` (собирает SPA в `apps/web/dist`).
  По умолчанию запускает `bun apps/api/src/main.ts`; `cg-orchestrator` и `cg-agent` в compose берут
  тот же образ со своим `command` (`apps/orchestrator/src/main.ts`, `apps/agent/src/main.ts`).
  Всё запускается из исходников, без транспиляции; секретов в образе нет (`.dockerignore`).
- `compose.yaml` — боевой compose-проект `cloud-gaming` на сервере: `cg-api`, `cg-postgres`,
  `cg-orchestrator`, `cg-agent`.
- `deploy.sh` — rsync репозитория на `brofrong:~/cloud-gaming`, `AGENT_TOKEN` в серверный `.env`
  (если его там нет), сеть `cg-sessions` (если нет), `docker compose up -d --build`.
- `build-session-image.sh` — сборка образа сессии `cg-session:<версия драйвера>` на воркере
  (см. `images/session/README.md` и раздел «Обновление драйвера NVIDIA» ниже).
- `compose.dev.yaml` — локальный Postgres для разработки/тестов (не трогать, не относится к проду).

## Топология на сервере

- Compose-проект `cloud-gaming` в `~/cloud-gaming`.
- `cg-postgres` (`postgres:18`, volume `cg-postgres-data`) — только во внутренней сети `cg`, порт
  наружу не публикуется.
- `cg-api` — сети `cg` (к базе и оркестратору), внешняя `proxy` (к реверс-прокси ingressi) и
  внешняя `cg-sessions` (к Selkies контейнеров сессий, `http://cg-session-<id>:8080`, для прокси
  `/stream/<id>/`). Порт наружу не публикуется. Healthcheck: `GET /healthz`.
- `cg-orchestrator` — только сеть `cg`, порт `3001` (`ORCHESTRATOR_PORT`) наружу не публикуется.
  Планировщик сессий, таймеры, WebSocket `/agent` (агенты с `Authorization: Bearer <AGENT_TOKEN>`).
  Healthcheck: `GET /healthz`. `mem_limit` 256m. Стартует после `cg-api` (healthy): оба применяют
  миграции, так они не идут одновременно.
- `cg-agent` — агент воркера `brofrong`, только сеть `cg`, подключается к
  `ws://cg-orchestrator:3001/agent`. Смонтирован `/var/run/docker.sock`; процесс — пользователь
  `1000` (bun) с дополнительной группой владельца сокета (`DOCKER_GID`, `deploy.sh` берёт её из
  `stat -c %g /var/run/docker.sock`, на brofrong `995`), без `privileged`. Healthcheck нет (нет HTTP):
  связь видна в логе оркестратора и в `workers.last_seen_at`. `mem_limit` 256m.
  Переменные (значения по умолчанию в `compose.yaml` — для brofrong; переопределяются в `.env`):
  `WORKER_ID=brofrong`, `WORKER_PUBLIC_IP=37.153.14.138`, `SLOTS=1`, `UDP_PORT_BASE=59000`,
  `SESSION_IMAGE=cg-session:550.163.01`,
  `GBM_ALLOCATOR_PATH=/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01`,
  `SESSION_NETWORK=cg-sessions`, `DOCKER_SOCKET=/var/run/docker.sock`.
- Контейнеры сессий `cg-session-<sessionId>` создаёт агент (не compose): сеть `cg-sessions`, метки
  `cg.session`/`cg.slot`/`cg.app`, наружу опубликован только UDP-порт слота (`59000/udp` для слота
  0), том дома пользователя `cg-home-<userId>`. `docker compose up/down` их не трогает; агент после
  перезапуска подхватывает живые по метке `cg.session`.
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
   - Необязательно: `ALLOWED_ORIGINS` — дополнительные Origin для WebSocket `/rpc` через запятую;
     без неё разрешён только origin `PUBLIC_URL`, для прода этого достаточно.

   - `AGENT_TOKEN` — новый случайный, не короче 32 символов (без вывода на экран):
     `grep -q '^AGENT_TOKEN=' .env.production || printf 'AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env.production`.
     Если на сервере уже есть `.env` без `AGENT_TOKEN`, `deploy.sh` сам допишет туда эту строку из
     `.env.production` (одну строку, остальные значения не читает и не меняет).

   Каждый сервис получает только перечисленные для него в `deploy/compose.yaml` переменные (не весь
   `.env`): `POSTGRES_PASSWORD` видит лишь `cg-postgres`, `AGENT_TOKEN` — оркестратор и агент.
   Новая переменная сервера — добавить её туда же.
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
1. `rsync` репозитория в `brofrong:~/cloud-gaming` (без `node_modules`, `.git`, `spike/nv`,
   `images/session/nv`, `.superpowers`, `docs`, `.env*` кроме `.env.example`).
2. Проверяет, что `~/cloud-gaming/.env` существует на сервере (падает с понятной ошибкой, если нет
   — см. шаг 1).
3. Если в серверном `.env` нет ключа `AGENT_TOKEN` — дописывает строку `AGENT_TOKEN=…` из локального
   `.env.production` (значение идёт через stdin ssh, на экран не выводится).
4. Создаёт сеть `cg-sessions`, если её нет.
5. `ssh brofrong 'cd ~/cloud-gaming && DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose -f deploy/compose.yaml --env-file .env up -d --build'`.

Повторный запуск безопасен: пересобирает образ и перезапускает только сервисы `cg-*` этого
compose-проекта; контейнеры сессий `cg-session-*` и другие контейнеры на сервере не трогает.
Внимание: пересоздание `cg-api` рвёт стримы идущих сессий (браузер переподключится), пересоздание
`cg-agent` — нет (агент подхватывает живые контейнеры).

Ручные команды compose на сервере — с теми же флагами, например:
`cd ~/cloud-gaming && docker compose -f deploy/compose.yaml --env-file .env logs -f cg-orchestrator`.

## Проверка после деплоя

```sh
curl -s https://game.brofrong.ru/healthz                       # ok
ssh brofrong 'docker ps --filter name=cg- --format "{{.Names}} {{.Status}}"'
  # cg-api, cg-postgres, cg-orchestrator — (healthy); cg-agent — Up
ssh brofrong 'docker logs cg-orchestrator 2>&1 | grep "Agent connected"'   # workerId=brofrong
ssh brofrong 'docker exec cg-postgres psql -U cg -d cloud_gaming -c "select id, public_ip, slots, last_seen_at from workers"'  # строка brofrong
ssh brofrong 'docker ps --format "{{.Names}}" | sort'           # сравнить с «до» — число и состав
                                                                  # остальных контейнеров не изменились
curl -s https://game.brofrong.ru/ | head -c 200                 # отдаёт SPA (index.html)
curl -s -X POST https://game.brofrong.ru/api/auth/steam/login \
  -H 'Content-Type: application/json' -d '{"callbackURL":"/library"}'   # {"url":"https://steamcommunity.com/..."}
```

Реальный вход через Steam/Pocket ID не проверяется деплоем — это делает владелец сервера (шаг 4,
ниже), у него есть нужные аккаунты.

## Сессии: как посмотреть

```sh
# контейнеры сессий
ssh brofrong 'docker ps --filter label=cg.session'
ssh brofrong 'docker ps --filter label=cg.session --format "{{.Names}} slot={{.Label \"cg.slot\"}} app={{.Label \"cg.app\"}} {{.Status}} {{.Ports}}"'
# активные сессии в БД
ssh brofrong "docker exec cg-postgres psql -U cg -d cloud_gaming -c \"select id, user_id, app_id, state, worker_id, slot, stream_url is not null as stream, state_since, fail_reason from sessions where state not in ('ended', 'failed') order by created_at\""
# последние 10 сессий и их игровое время
ssh brofrong "docker exec cg-postgres psql -U cg -d cloud_gaming -c \"select s.id, s.state, s.created_at, s.ended_at, s.fail_reason, coalesce(sum(p.ended_at - p.started_at) filter (where p.billable), interval '0') as billable from sessions s left join play_segments p on p.session_id = s.id group by s.id order by s.created_at desc limit 10\""
# логи
ssh brofrong 'docker logs --tail 100 cg-orchestrator'
ssh brofrong 'docker logs --tail 100 cg-agent'
ssh brofrong 'docker logs --tail 100 cg-session-<sessionId>'
```

Остановить зависшую сессию штатно — «Выйти из игры» в интерфейсе (`session.stop`) или
`update sessions set stop_requested_at = now() where id = '<id>'`: оркестратор отправит агенту
`StopSession`, агент даст Steam выгрузить сохранения и удалит контейнер. `docker rm -f` контейнера
сессии — крайний случай: сохранения Steam Cloud могут не выгрузиться, сессия станет `failed`.

## Обновление драйвера NVIDIA на воркере

Образ сессии содержит 32-битные библиотеки NVIDIA ровно версии драйвера хоста, а агент
пробрасывает GBM-бэкенд по пути с версией. После обновления драйвера (и перезагрузки — её делает
владелец):

1. `nvidia-smi` на воркере → новая версия `<ver>`; проверить, что
   `/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.<ver>` существует.
2. Пересобрать образ: `./deploy/build-session-image.sh` — сам определит версию, скачает и
   распакует драйвер, соберёт `cg-session:<ver>`.
3. Дописать или исправить в серверном `~/cloud-gaming/.env` (по строке, не выводя остальные
   значения): `SESSION_IMAGE=cg-session:<ver>` и
   `GBM_ALLOCATOR_PATH=/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.<ver>`
   (без них `compose.yaml` берёт значения по умолчанию для 550.163.01). Либо поменять значения по
   умолчанию в `compose.yaml` и закоммитить.
4. `./deploy/deploy.sh` — пересоздаст `cg-agent` с новыми переменными; новые сессии пойдут на
   новый образ.
5. Старый образ `cg-session:<старая версия>` удалить вручную (`docker rmi`), когда на нём нет сессий.

## Шаг 4 (приёмка, делает владелец)

MVP-1:
- Вход через Steam на `https://game.brofrong.ru` → библиотека с Vampire Survivors и плашкой
  ProtonDB.
- Вход через Pocket ID на `/admin` → «Админка», `pong`.

MVP-2 (сессии). На время приёмки спайк остановлен (одна GPU):
`ssh brofrong 'cd ~/cg-spike && docker compose stop'`; после приёмки — `docker compose start`.

1. «Играть» на Vampire Survivors → статусы → вход Steam по QR (первый раз, новый том
   `cg-home-<userId>`) → игра; геймпад работает.
2. В админке поставить простой N = 1 мин → через минуту без ввода «Вы ещё здесь?» → «Я здесь»
   возвращает игру; вернуть N = 15.
3. Закрыть вкладку на ~1 мин, открыть `/session/<id>` → игра продолжается.
4. «Выйти из игры» → «Сохраняем прогресс…» → «Вы играли …»; в БД `play_segments` сходятся с
   фактическим временем ±1 мин; контейнер `cg-session-*` удалён.

Дополнительно проверить:
- **StopSession даёт Steam выгрузить сохранения.** После «Выйти из игры» в логе агента у сессии
  `Session stopped` с `cloudSynced` = `true` (`docker logs cg-agent 2>&1 | grep "Session stopped"`),
  и прогресс виден в следующей сессии. `cloudSynced: false` у сессии, где игра шла, значит, что
  `pkill -TERM` по `AppId=<id>` не дал Steam штатно закрыть игру и выгрузить облако, — сообщить.
- **Геймпад считается вводом.** Играть только геймпадом (клавиатуру и мышь не трогать) дольше N
  минут при фокусе на iframe стрима — «Вы ещё здесь?» появляться не должно.
- **WebSocket через прокси.** Стрим идёт через `https://game.brofrong.ru/stream/<id>/` (сигналинг
  Selkies — WebSocket через ingressi и `cg-api`); в консоли браузера нет ошибок WebSocket про
  subprotocol (`Sec-WebSocket-Protocol`) и циклических переподключений.

## Если `https://game.brofrong.ru` отдаёт 502, а `cg-api` healthy

Проверять только нашу часть — контейнер/сеть `cg-api`, никогда конфиг Caddy/ingressi:

- `ssh brofrong 'docker inspect cg-api --format "{{json .NetworkSettings.Networks}}"'` — `cg-api`
  должен быть в сети `proxy` (и в `cg`).
- `ssh brofrong 'docker exec ingressi-caddy wget -qO- http://cg-api:3000/healthz'` (если на
  `ingressi-caddy` есть `wget`/`curl`) — проверка связности из сети `proxy`, не трогая конфиг.
- Если причина не в нашей сети/контейнере, сообщить владельцу с подробностями, а не менять его
  конфиг Caddy.
