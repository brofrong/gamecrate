# Деплой GameCrate: главный сервер, игровые серверы, стенд brofrong

Схема (спека `docs/superpowers/specs/2026-11-09-multi-server-deploy-design.md`): один **главный**
сервер (сайт, api, оркестратор, база, хранилище профилей, без GPU) и **игровые** серверы с GPU, на
каждом только агент. Образы собирает GitLab CI на тег релиза и кладёт в реестр
`registry.imtechnologies.ru/gamecrate/imt-cloud-gaming`; на серверах ничего не собирается.
**brofrong** (`game.brofrong.ru`) — тестовый стенд: главный и игровой на одной машине, своя база.

## Что здесь

- `Dockerfile` — один образ приложения `cg-app:<тег>`: `bun install --frozen-lockfile` (с патчами
  из `patches/`), `bun run build` (SPA в `apps/web/dist`), `CG_COMMIT`/`CG_VERSION` зашиты (CI
  передаёт коммит и тег). По умолчанию запускает api; `cg-orchestrator` и `cg-agent` берут тот же
  образ со своим `command`. Всё запускается из исходников; копия репозитория в образе нужна и
  оркестратору — он отдаёт из неё файлы установки игрового сервера. Секретов в образе нет
  (`.dockerignore`).
- `compose.main.yaml` — главный сервер: `cg-api`, `cg-orchestrator`, `cg-postgres`, `cg-rustfs`;
  одноразовый `cg-rustfs-bucket` (профиль `tools`).
- `compose.worker.yaml` — игровой сервер: только `cg-agent`.
- `compose.stand.yaml` — оверлей стенда brofrong поверх двух предыдущих (агент по внутренней сети
  `cg`, пути brofrong).
- `worker/install.sh` — установка игрового сервера одной командой (её показывает админка);
  `worker/build-steam-client.sh` — сборка шаблона клиента Steam на самом сервере. Оба отдаёт
  оркестратор: `GET /agent/install.sh`, `/agent/build-steam-client.sh`, а также
  `/agent/session-isolation.sh` и `/agent/compose.worker.yaml`.
- `deploy-stand.sh <тег>` — деплой стенда brofrong по тегу; `deploy-stand.sh enroll <код>` —
  токен сервера brofrong.
- `build-steam-client.sh [ssh-хост=brofrong]` — обёртка: `worker/build-steam-client.sh` на стенде
  по ssh.
- `session-isolation.sh` — правила iptables для сети `cg-sessions` (`apply-local` на сервере,
  `detect`/`print` с машины разработчика); `check-session-isolation.sh` — проверка без sudo.
- `ci/build-session-images.sh` — сборка образов сессии в CI (по версиям из
  `images/session/drivers.txt`); `build-session-image.sh` — прежняя сборка образа сессии прямо на
  brofrong (для опытов, см. «Смена образа сессии»).
- `add-game.sh <slug> [--host <ssh-хост>] …` — сборка пакета своей игры на сервере (раздел «Свои
  игры: сборка пакета» ниже; пока рассчитан на стенд: читает `~/cloud-gaming/.env`).
- `measure-session-start.sh` — замер запуска установленной игры; `compose.dev.yaml` — локальный
  Postgres для разработки и тестов.

## Главный сервер

`compose.main.yaml`, compose-проект `cloud-gaming`. Образ `cg-app:${CG_VERSION}` из реестра
(`CG_REGISTRY` переопределяет реестр). Порты на хост не публикуются.

- `cg-postgres` (`postgres:18`, том `cg-postgres-data`) — только сеть `cg`.
- `cg-api` — сети `cg` и `proxy` (обратный прокси владельца). Прокси стрима `/stream/<id>/` ходит
  в relay оркестратора (`ORCHESTRATOR_RELAY_URL=http://cg-orchestrator:3002`), в сети
  `cg-sessions` api больше нет. Healthcheck `GET /healthz`, `mem_limit` 512m.
- `cg-orchestrator` — сети `cg` и `proxy`. На `3001`: WebSocket `/agent` агентов (токен сервера в
  `Authorization: Bearer`), тоннели стрима `/agent/tunnel/<id>`, обмен кода `/agent/enroll`,
  конфиг агента `/agent/config`, файлы установки `/agent/install.sh` и др. На `3002` — relay
  стрима для `cg-api`: пускает только запросы с общим секретом `RELAY_SECRET` (заголовок
  `x-cg-relay-secret`, его ставит `cg-api`), остальные — 403 до обращения к БД и агенту. Стартует
  после `cg-api` (healthy): оба применяют миграции.
  Посеянные входы Steam (вход по QR) хранит в `steam_login_seeds` зашифрованными (`SEED_KEY`).
- `cg-rustfs` (`rustfs/rustfs:1.0.3`, том `cg-rustfs-data`) — сети `cg` и `proxy`, S3 на `:9000`.
  В бакете `cg-profiles` — `profiles/<userId>/<uuid>.cgp` (`CGP1` + AES-256-GCM, ключ
  `PROFILE_KEY`); пишут и читают агенты игровых серверов.

Маршруты обратного прокси (настраивает владелец, WebSocket включён):

| Маршрут                  | Куда                   | Что                                                          |
| ------------------------ | ---------------------- | ------------------------------------------------------------ |
| `https://<домен>`        | `cg-api:3000`          | сайт, `/rpc`, `/stream/<id>/`                                |
| `https://<домен>/agent*` | `cg-orchestrator:3001` | агенты (`wss://…/agent`, `/agent/tunnel`), установка сервера |
| `https://<хост S3>`      | `cg-rustfs:9000`       | профили (отдельный хост: S3 плохо живёт под префиксом пути)  |

`RELAY_PORT` (3002) в маршруты **не добавлять**. Docker не делит порты контейнера по сетям, так что
в сети `proxy` relay тоже слушается — поэтому он и требует `RELAY_SECRET`: без секрета другой
контейнер в `proxy` получит 403. Секрет не выводить и не класть в маршруты прокси.

### `.env` главного

**Никогда не печатать, не логировать и не коммитить значения секретов.** Собрать `.env` рядом с
`compose.main.yaml` (права 600), значения копировать программно, не выводя на экран:

- `CG_VERSION=<тег релиза>` — тег образов (он же версия, которую ставят новые игровые серверы).
- `PUBLIC_URL=https://<домен>`, `PORT=3000`, `WEB_DIST_DIR=/app/apps/web/dist`.
- `POSTGRES_PASSWORD` — случайный; `DATABASE_URL=postgres://cg:<POSTGRES_PASSWORD>@cg-postgres:5432/cloud_gaming`.
- `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), `STEAM_API_KEY`, `POCKET_ID_URL`,
  `POCKET_ID_CLIENT_ID`, `POCKET_ID_CLIENT_SECRET`, `POCKET_ID_ADMIN_GROUP`.
- `SMTP_URL` — настоящий SMTP (`log://` разрешён только при `PUBLIC_URL` на localhost),
  `MAIL_FROM`.
- Необязательно, парами: `GOOGLE_CLIENT_ID`/`_SECRET`, `YANDEX_CLIENT_ID`/`_SECRET`,
  `TELEGRAM_CLIENT_ID`/`_SECRET`; `ALLOWED_ORIGINS`.
- `ORCHESTRATOR_PUBLIC_URL=https://<домен>` — из него адрес агентов `wss://<домен>/agent` и адрес
  в скрипте установки.
- `S3_PUBLIC_ENDPOINT=https://<хост S3>`, `S3_BUCKET=cg-profiles` (по умолчанию).
- `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` — по `openssl rand -hex 24` (корневые ключи RustFS, они
  же S3-ключи, которые оркестратор выдаёт агентам).
- `RELAY_SECRET` — `openssl rand -hex 32` (не короче 32 символов): общий секрет `cg-api` и relay
  оркестратора, compose передаёт его обоим.
- `PROFILE_KEY`, `SEED_KEY` — по `openssl rand -base64 32` (base64 ровно 32 байт).
  **`PROFILE_KEY` не менять и не терять:** им зашифрованы все профили. `SEED_KEY` сменить можно
  (посеянные входы пропадут, игроки один раз войдут по QR снова).
- `REGISTRY_SERVER=registry.imtechnologies.ru`, `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` — deploy
  token GitLab с правом `read_registry` (все три или ни одной): их получают агенты при обмене кода.

```sh
grep -q '^PROFILE_KEY=' .env || printf 'PROFILE_KEY=%s\n' "$(openssl rand -base64 32)" >> .env   # так же остальные
```

Каждый сервис получает только свои переменные (`POSTGRES_PASSWORD` — только `cg-postgres`,
`PROFILE_KEY`, `SEED_KEY`, `REGISTRY_*` — только оркестратор, `RELAY_SECRET` — api и оркестратор).

### Запуск и обновление главного

```sh
docker login registry.imtechnologies.ru                     # токен на чтение, один раз
docker compose -f compose.main.yaml --env-file .env pull
docker compose -f compose.main.yaml --env-file .env run --rm cg-rustfs-bucket   # бакет, идемпотентно
docker compose -f compose.main.yaml --env-file .env up -d
curl -s https://<домен>/healthz                             # ok
```

Обновление: `CG_VERSION=<новый тег>` в `.env`, затем те же `pull` и `up -d`. Пересоздание `cg-api`
и `cg-orchestrator` рвёт управляющий WebSocket идущих сессий (стрим идёт через главный). Автодеплой
через Arcane — позже (спека, «Не цели»).

Владелец (один раз): маршруты обратного прокси (таблица выше); в Pocket ID OIDC-клиент с callback
`https://<домен>/api/auth/callback/pocket-id` (именно `/api/auth/callback/…`, не
`/api/auth/oauth2/callback/…`) и группа админов; у Google, Яндекса и Telegram redirect
`https://<домен>/api/auth/callback/<google|yandex|telegram>`.

## Игровой сервер

Требования: Linux x86_64 (Debian или Ubuntu), Docker Engine с плагином compose, драйвер NVIDIA
**одной из версий `images/session/drivers.txt`** (в образе сессии 32-битные библиотеки ровно этой
версии), NVIDIA Container Toolkit (`nvidia-ctk runtime configure --runtime=docker`),
`nvidia-drm modeset=1`, публичный IP с открытыми UDP-портами слотов. TCP наружу не нужен.

**Добавление** (решение владельца 6): админка → «Серверы» → «Добавить сервер» → имя и регион →
команда с одноразовым кодом (живёт 24 часа). На сервере:

```sh
curl -fsSL https://<домен>/agent/install.sh | sudo bash -s -- <код>
#   --public-ip <ip>    если api.ipify.org недоступен или IP не тот
#   --data-dir <путь>   библиотека игр не в /srv/cloud-gaming (например, большой диск)
#   --sessions-subnet a.b.c.0/24   подсеть сети cg-sessions, если 172.31.240.0/24 занята
#   --dry-run           только проверки и план, код не тратится
```

`install.sh` (комментарий в начале файла — подробно):

1. Проверки, ничего не меняя: Docker и compose, `nvidia-smi`, runtime `nvidia` в `docker info`,
   `nvidia-drm modeset=1`, драйвер из списка релиза, `libnvidia-allocator.so.<драйвер>`, публичный
   IP, сеть `cg-sessions` (если уже есть — с нужной подсетью). Что не так — пишет и выходит, код не
   тратится.
2. Меняет код на постоянный токен сервера (`POST /agent/enroll`), `docker login` реестра выданными
   учётными данными (пароль через stdin), проверяет образы релиза (`docker manifest inspect`) и
   скачивает образ сессии `cg-session:<драйвер>-<версия>`.
3. Каталоги (владелец uid 1000), сеть `cg-sessions` с фиксированной подсетью
   (`CG_SESSIONS_SUBNET`, по умолчанию `172.31.240.0/24`; контейнерам сессий Docker раздаёт адреса
   из `CG_SESSIONS_IP_RANGE` `.128/25`, `cg-agent` закреплён на `CG_AGENT_IP` `.2` вне его),
   `/opt/cloud-gaming/.env` (600, root).
4. `session-isolation.sh apply-local --agent-ip <CG_AGENT_IP>` — **до** старта агента, с
   сохранением правил на перезагрузку (ставит `iptables-persistent`); не вышло — агент прежней
   установки останавливается, выход 1. Затем `docker compose pull && up -d` агента.
5. Шаблон клиента Steam, если его нет (~2,5 ГБ, 10–30 мин; пока его нет, сервер сессий не берёт и в
   админке «Клиент Steam не собран»).
6. До 60 с ждёт в логе `cg-agent` «Connected to orchestrator» (первый отчёт, принятый
   оркестратором). Есть — «Сервер <id> подключён. Откройте UDP <порты> в файрволе провайдера»
   (`UDP_PORT_BASE` (59000) … `+SLOTS-1`, слот = одна GPU), нет — предупреждение и как смотреть лог.

Повторный запуск с новым кодом (карточка сервера → «Перевыпустить код») переустанавливает сервер:
старый токен перестаёт действовать, `.env` перезаписывается.

Файлы на сервере:

| Путь                                                              | Что                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/opt/cloud-gaming/.env`                                          | `WORKER_ID`, `WORKER_TOKEN` (секрет), `ORCHESTRATOR_URL`, `CG_VERSION`, `SESSION_IMAGE`, пути, `SLOTS`, `DOCKER_GID`, `GBM_ALLOCATOR_PATH`, `CG_SESSIONS_SUBNET`/`CG_SESSIONS_IP_RANGE`/`CG_AGENT_IP` |
| `/opt/cloud-gaming/compose.yaml`                                  | `compose.worker.yaml` с главного                                                                                                           |
| `/opt/cloud-gaming/session-isolation.sh`, `build-steam-client.sh` | помощники с главного                                                                                                                       |
| `/srv/cloud-gaming/library`                                       | библиотека игр этого сервера (`steamapps/…`, шаблоны префикса Proton); lower сессий                                                        |
| `/srv/cloud-gaming/install-scratch`                               | upper/work установщиков; та же ФС и тот же bind, что библиотека (перенос `rename`)                                                         |
| `/srv/cloud-gaming/games`                                         | пакеты своих игр `<slug>/<version>/`                                                                                                       |
| `/srv/cloud-gaming-scratch`                                       | upper/work сессий (лучше NVMe); после сессии пусто                                                                                         |
| `/srv/cloud-gaming-steam/client`                                  | шаблон клиента Steam (NVMe); в агент смонтирован родитель, только на чтение                                                                |

S3 профилей и `PROFILE_KEY` в `.env` нет: агент получает их от главного (`GET /agent/config`).

`cg-agent`: пользователь 1000 с группой сокета Docker (`DOCKER_GID`), без `privileged`; сети
`cg-sessions` (закреплённый адрес `CG_AGENT_IP`; сам ходит в Selkies сессий
`cg-session-<id>:8080` для тоннеля стрима) и своя default; GPU с `capabilities: [utility]` — только `nvidia-smi`/NVML для метрик админки. **Из-за
этой резервации агент не стартует, если NVIDIA Container Toolkit или NVML на хосте не работают**
(например, драйвер обновлён без перезагрузки) — чинится на хосте. Контейнеры сессий и
установщиков агент создаёт сам, `docker compose up/down` их не трогает.

Команды на сервере:

```sh
cd /opt/cloud-gaming
sudo docker compose -f compose.yaml --env-file .env logs -f cg-agent
sudo docker compose -f compose.yaml --env-file .env up -d          # после правки .env
sudo ./session-isolation.sh apply-local --agent-ip "$(sudo sed -n 's/^CG_AGENT_IP=//p' .env)"   # если сменились DNS хоста
sudo ./build-steam-client.sh                 # пересобрать шаблон клиента Steam (без сессий)
```

Обновление агента (пока руками, кнопка «Обновить» — третья часть): без живых сессий и установок
(«На обслуживание» в админке и дождаться) в `.env` поменять `CG_VERSION` и `SESSION_IMAGE` на новый
тег, `docker pull <SESSION_IMAGE>`, `pull`, `up -d` (адрес агента закреплён, правила изоляции
повторять не нужно).

Сеть `cg-sessions` уже есть с другой подсетью (ставили руками или старой версией) — `install.sh`
откажется. Пересоздать, пока нет сессий и установок
(`docker ps -a --filter label=cg.session --filter label=cg.install` пусто):
`docker stop cg-agent && docker network rm cg-sessions`, затем снова команда установки (новый код).

## Сетевая изоляция контейнеров сессий

Контейнеры сессий и установщиков (сеть `cg-sessions`) должны видеть интернет (Steam, игры), но не
адреса хоста, локальную сеть и другие контейнеры моста, кроме `cg-agent` → Selkies сессий `:8080`
(тоннель стрима). На игровом сервере правила ставит `install.sh` до старта агента
(`/opt/cloud-gaming/session-isolation.sh apply-local --agent-ip <CG_AGENT_IP>`: определяет подсеть,
мост и DNS хоста, проверяет, что адрес агента в подсети `cg-sessions`, применяет
`iptables-restore -n`, ставит переход из `INPUT` первым правилом и сохраняет на перезагрузку
`netfilter-persistent save`; если его нет — сам ставит `iptables-persistent` без вопросов (debconf
`autosave_v4/v6=false`, `apt-get install --no-remove`: пакет конфликтует с `ufw`, и apt тогда
откажется, а не удалит файрвол). Не сохранилось — код 1, `install.sh` агент не запускает. На
brofrong sudo нет — там правила не применяются.

Правило для `:8080` привязано к адресу `cg-agent`, а он закреплён (`ipv4_address: ${CG_AGENT_IP}` в
`compose.worker.yaml`, вне ip-range контейнеров сессий) — пересоздание агента правила не ломает.
Повторять `apply-local` нужно, только если сменились DNS-серверы хоста или пересоздана сеть
(цепочки перезапишутся целиком, переход из `INPUT` останется один). `-n` не трогает чужие таблицы,
но **стирает другие правила в `DOCKER-USER`** (общая цепочка всех сетей Docker на хосте).
`netfilter-persistent save` сохраняет и цепочки Docker — при старте Docker перестраивает их сам,
`DOCKER-USER` не трогает.

С машины разработчика (без sudo): `./deploy/session-isolation.sh detect <хост>` — аргументы для
`print --subnet <cidr> --bridge <ifname> --agent-ip <ip> [--resolver <ipv4>]… [--subnet6 <cidr>]`,
который печатает дамп правил; ручное применение — комментарий в начале скрипта. Проверка:
`./deploy/check-session-isolation.sh [ssh-хост]` — два временных контейнера в `cg-sessions` и
`curl -m 3` к шлюзу моста, LAN-адресу и шлюзу хоста, второму контейнеру `:8080`, `cg-agent:8080`
и в интернет; код 0 — всё как ожидается («закрыто» — только таймаут). Скрипт читает
`~/cloud-gaming/.env` (стенд); на игровом сервере ему нужен `SESSION_IMAGE` из
`/opt/cloud-gaming/.env`.

## Стенд brofrong

`~/cloud-gaming` на brofrong: `.env`, `compose.main.yaml`, `compose.worker.yaml`,
`compose.stand.yaml` (копирует `deploy-stand.sh`; старая копия репозитория от прежнего `deploy.sh`
там больше не нужна). Главный и агент — один compose-проект `cloud-gaming`. Агент ходит к
оркестратору тем же протоколом, что удалённые серверы (токен сервера, тоннель стрима), только по
внутренней сети `cg` (`ws://cg-orchestrator:3001/agent`). Пути стенда `deploy-stand.sh` дописывает
в `.env`, если их там нет: `CG_DATA_DIR=/raid/cloud-gaming`,
`SCRATCH_DIR=/home/brofrong/cloud-gaming-scratch`, `STEAM_CLIENT_DIR=/home/brofrong/cloud-gaming-steam/client`,
`STEAM_CLIENT_PARENT=/home/brofrong/cloud-gaming-steam`. Оверлей `compose.stand.yaml` задаёт
`WORKER_ID=brofrong`, `WORKER_PUBLIC_IP=37.153.14.138` и GBM драйвера 550.163.01 (по умолчанию).

**`.env` стенда: что поменялось** (по строке, не выводя остальные значения):

- убрать `AGENT_TOKEN` (общего токена агентов больше нет);
- добавить `ORCHESTRATOR_PUBLIC_URL=https://game.brofrong.ru`;
- добавить `S3_PUBLIC_ENDPOINT=http://cg-rustfs:9000` (агент стенда ходит в RustFS по сети `cg`);
- добавить `RELAY_SECRET` (`openssl rand -hex 32`, без вывода на экран):
  `grep -q '^RELAY_SECRET=' .env || printf 'RELAY_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env`;
- `PROFILE_KEY` остаётся в `.env`, но читает его теперь оркестратор (агенту выдаёт через
  `/agent/config`); `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` — так же (S3-ключи оркестратора);
- `CG_VERSION` и `SESSION_IMAGE` пишет `deploy-stand.sh` (прежний `SESSION_IMAGE=cg-session:…`
  заменится образом релиза);
- `WORKER_TOKEN` — токен сервера brofrong: пишет `deploy-stand.sh enroll <код>` (ниже);
- пути (`CG_DATA_DIR` и др.) дописывает `deploy-stand.sh`; необязательно
  `CG_SESSIONS_SUBNET`/`CG_SESSIONS_IP_RANGE`/`CG_AGENT_IP`, если `172.31.240.0/24` на brofrong
  занята (адрес агента — внутри подсети и вне ip-range);
- необязательно: `REGISTRY_SERVER`/`REGISTRY_USERNAME`/`REGISTRY_PASSWORD` — если с этим стендом
  будут ставить игровые серверы.

Один раз на brofrong: `docker login registry.imtechnologies.ru` (deploy token с `read_registry`) и
пересоздать сеть `cg-sessions` с фиксированной подсетью (старая создана без неё — `deploy-stand.sh`
откажется с той же инструкцией): без сессий и установок
`ssh brofrong 'docker stop cg-agent && docker network rm cg-sessions'` — сеть создаст деплой.

```sh
./deploy/deploy-stand.sh v0.1.0
```

1. Отказ, если есть созданный или запущенный контейнер `cg.session`, `cg.install` или
   `cg.template` (остановленные не мешают); сессии штатно не останавливает — ждать или «На
   обслуживание».
2. Драйвер brofrong должен быть в `images/session/drivers.txt`.
3. Пути стенда в `.env` (если нет), каталоги (uid 1000), сеть `cg-sessions` с фиксированной
   подсетью (есть с другой — отказ); предупреждение, если шаблон клиента Steam не собран
   (`./deploy/build-steam-client.sh`).
4. Три compose-файла в `~/cloud-gaming/`, `config -q` и скачивание образов с новыми `CG_VERSION` и
   `SESSION_IMAGE=…/cg-session:<драйвер>-<тег>`; только после этого они пишутся в `.env`; бакет
   профилей, `up -d`.

Первый деплой: агент без `WORKER_TOKEN` не подключится (в логе `cg-agent` ошибка `WORKER_TOKEN`).
Админка → «Серверы» → brofrong → «Перевыпустить код», затем:

```sh
./deploy/deploy-stand.sh enroll <код>      # обмен внутри cg-orchestrator, токен сразу в .env, up -d cg-agent
```

GPU-слот начинает принимать сессии, как только агент подключился: спайк `cg-spike` (та же GPU и
UDP `59000`) останавливать **до** деплоя: `ssh brofrong 'cd ~/cg-spike && docker compose stop'`.

Ручные команды на стенде:
`cd ~/cloud-gaming && docker compose -f compose.main.yaml -f compose.worker.yaml -f compose.stand.yaml --env-file .env logs -f cg-orchestrator`
(для `up` ещё `DOCKER_GID=$(stat -c %g /var/run/docker.sock)` в окружении).

Проверка после деплоя:

```sh
curl -s https://game.brofrong.ru/healthz                                   # ok
ssh brofrong 'docker ps --filter name=cg- --format "{{.Names}} {{.Status}} {{.Image}}"'
  # cg-api, cg-orchestrator, cg-postgres, cg-rustfs — healthy; cg-agent — Up; образы :<тег>
ssh brofrong 'docker logs cg-agent 2>&1 | head -20'                        # нет ошибок конфига
ssh brofrong 'docker logs cg-orchestrator 2>&1 | grep "Agent connected" | tail -1'   # workerId=brofrong
ssh brofrong 'docker logs cg-agent 2>&1 | grep -m1 "Connected to orchestrator"'  # агент принят
```

## Релиз

1. Тег `vX.Y.Z` на коммите `main` (и `git push origin vX.Y.Z` — только с согласия владельца).
2. CI (`.gitlab-ci.yml`): проверки, `cg-app:vX.Y.Z` (+ `latest`, кроме `-rc`) и
   `cg-session:<драйвер>-vX.Y.Z` на каждую строку `images/session/drivers.txt`.
3. Стенд: `./deploy/deploy-stand.sh vX.Y.Z`, проверка.
4. Главный: `CG_VERSION=vX.Y.Z` в его `.env`, `pull`, `up -d` (раздел «Главный сервер»). Новые
   игровые серверы с этого момента ставятся этой версией.
5. Игровые серверы: руками по разделу «Игровой сервер» (кнопка «Обновить» — третья часть).

Новый драйвер на игровом сервере — сначала строка в `images/session/drivers.txt` и новый релиз
(образ сессии собирается только в CI), потом установка или обновление сервера.

## Админка

`/admin` (вход через Pocket ID, роль `admin`) заменяет хождение по ssh за `docker ps`/`df`/
`nvidia-smi`/логами. Вкладки: **Воркеры** — карточка на каждый
воркер (онлайн/офлайн, железо: CPU/RAM/GPU/диски; загрузка сейчас: CPU/RAM/GPU/видеопамять/диски;
версии: коммит агента (`CG_COMMIT`), `SESSION_IMAGE`, драйвер NVIDIA, дата сборки шаблона клиента
Steam, аптайм; слоты и сессии на этом воркере с кнопкой «Остановить»), под карточками — «Последние
сбои»; **Сессии** — все живые сессии со всех воркеров + история с причинами сбоев; **Настройки** —
прежняя карточка «Настройки сессий»; **Игры** — игры общей библиотеки (размер, когда поставлена,
последний запуск, число запусков) с кнопкой «Удалить» и строкой служебных пакетов Steam (Proton,
Steam Linux Runtime — удалить нельзя); **Установки** — очередь и идущие установки с прогрессом и
кнопкой «Отменить», ниже итоги за 7 дней; **Пользователи** — список (способы входа, SteamID,
регистрация, последняя сессия, наиграно, размер и версия облачного профиля) с поиском по имени/почте
и действиями «Сделать админом»/«Сделать игроком», «Заблокировать»/«Разблокировать», «Сбросить вход
Steam»; своя строка — действия неактивны. Подробности и решения по реализации —
`docs/superpowers/specs/2026-10-28-admin-orchestration-design.md`.

**Роль и блокировка пользователя.** Роль переключает «Сделать админом»/«Сделать игроком»; у
пользователей, вошедших через Pocket ID, роль на самом деле пересчитывается из группы Pocket ID при
каждом входе — админка это помечает подсказкой у строки, а изменённая вручную роль переживёт только
до следующего входа. Блокировка останавливает текущую игру пользователя штатно (профиль
сохраняется) и не даёт запустить новую — экран показывает «Доступ закрыт»; вход на сайт при этом не
трогается, разблокировать можно в любой момент. Сброс входа Steam не трогает привязку аккаунта и
сохранения — только стирает данные входа в контейнере: при следующем запуске Steam попросит войти
заново (QR), сохранения останутся на месте.

**Удаление игры.** Нельзя, пока в игру играют, она ставится или для неё сейчас собирается шаблон
префикса Proton («Собирается шаблон префикса» — см. «Шаблоны префикса Proton»). Api ставит
`gamestore_apps.deleting_at`, оркестратор шлёт агенту с ролью `gamestore` `DeleteGame`: агент
переносит манифест, `common/<installdir>`, `compatdata/<appId>` (шаблон префикса Proton этой игры) и
`shadercache/<appId>` в `<LIBRARY_DIR>/.trash` той же ФС и очищает корзину (что не может uid 1000 —
помощником от root; остаток корзины убирается при следующем удалении или старте агента). Пока игра
удаляется, её сессии ждут в очереди, после — ставят игру заново обычной установкой.

**Отмена установки.** Api ставит `install_jobs.cancel_requested_at`: задача в очереди сразу
`failed`, идущей оркестратор шлёт `CancelInstall`; ждущие сессии завершаются с причиной «Установка
отменена администратором». Если агент уже переносит игру в библиотеку, отмена не успевает — игра
остаётся установленной.

**«На обслуживание» перед деплоем.** Кнопка на карточке сервера (там же «Вернуть в работу»):
сервер на обслуживании доигрывает текущие сессии и установки, но новых не берёт — так можно
заранее перекрыть приток новых сессий, не дожидаясь, пока `deploy-stand.sh` откажется деплоить из-за
живых `cg.session`/`cg.install` (см. «Стенд brofrong»). Флаг (`workers.draining`) переживает
перезапуск агента и оркестратора; сам деплой его не трогает — возвращать воркер в работу нужно
руками, после деплоя.

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
`StopSession`, агент даст Steam выгрузить сохранения, сохранит профиль и удалит контейнер.
`docker rm -f` контейнера сессии — крайний случай: сохранения Steam Cloud могут не выгрузиться,
профиль (вход Steam, локальные сохранения) этой сессии теряется, сессия станет `failed`.

Установки, профили, библиотека:

```sh
ssh brofrong 'docker ps --filter label=cg.install --format "{{.Names}} app={{.Label \"cg.app\"}} {{.Status}}"'
ssh brofrong "docker exec cg-postgres psql -U cg -d cloud_gaming -c 'select id, app_id, user_id, state, bytes_downloaded, bytes_total, error, created_at from install_jobs order by created_at desc limit 10'"
ssh brofrong "docker exec cg-postgres psql -U cg -d cloud_gaming -c 'select app_id, size_bytes, build_id, installed_at from gamestore_apps'"
ssh brofrong "docker exec cg-postgres psql -U cg -d cloud_gaming -c 'select user_id, version, object_key, size_bytes, updated_at from profiles'"
ssh brofrong 'ls /raid/cloud-gaming/library/steamapps /raid/cloud-gaming/library/steamapps/common; du -sh /raid/cloud-gaming/library'
ssh brofrong 'ls -A /home/brofrong/cloud-gaming-scratch /raid/cloud-gaming/install-scratch'
ssh brofrong 'docker volume ls --filter label=cg.session; docker volume ls --filter label=cg.install'
# объекты профилей в RustFS (ключи — из .env через compose, на экран не выводятся)
ssh brofrong 'cd ~/cloud-gaming && docker compose -f compose.main.yaml --env-file .env run --rm --no-deps --entrypoint aws cg-rustfs-bucket s3 ls --recursive s3://cg-profiles/'
```

## Профиль не сохранён (`profile-unsaved`)

Если при остановке сессии профиль не удалось снять, зашифровать, выгрузить в RustFS или
зафиксировать в `profiles` (RustFS недоступен или не отвечает — тайм-аут 2 мин на выгрузку, сбой
`cg-profile-pack`, архив профиля больше 200 МиБ — `stage: "size"` с размером в `error`, выгрузка
отклонена из-за устаревшей версии — `stage: "commit"`, `rejected: stale base version`), агент **не
удаляет** контейнер: `cg-session-<id>` остаётся остановленным вместе с томами `cg-s-<id>-*` и
каталогом `<SCRATCH_DIR>/<id>`, в логе агента — `profile-unsaved` (`sessionId`, `userId`, `stage`,
`error`). Сессия завершается (`profileSaved: false`), слот свободен; следующая сессия пользователя
получит предыдущую версию профиля. Если `docker stop` завис, агент повторяет его, и слот держится до
остановки (см. «Контейнер сессии не остановился»). Оркестратор пишет в свой лог предупреждение
`Session profile not saved` (`sessionId`, `userId`). Ни остановка, ни перезапуск агента такой
контейнер не удаляют — решает человек.

Слои сессии монтируются с `volatile` (без fsync, иначе Steam стартует на минуту дольше): после
размонтирования ядро оставляет в `<SCRATCH_DIR>/<id>/*/work/work/incompat` метку, и пока она
есть, тома повторно не смонтировать. Агент сразу после остановки сам сбрасывает данные слоёв на
диск и снимает метку (помощник `cg-s-<id>-unmark`; не вышло — в логе
`Unmarking kept session layers failed`). Если `docker start cg-session-<id>` всё же падает с
ошибкой монтирования overlay (`…,volatile: invalid argument`) — `docker restart cg-agent` (при
старте агент снимает метку у всех остановленных сессий; предупреждение об установках из п. 1
действует и здесь) и повторить.

Ещё у слоёв сессии (и слоя клиента Steam установщика) — `metacopy=on`: на `chmod` и жёсткой ссылке
overlay копирует в upper только метаданные (иначе каждая сессия копировала ~1,4 ГБ рантайма
pressure-vessel и файлов Proton, этап «Готовим запуск» шёл ~100 с вместо ~60 с). Поэтому часть
файлов в `<SCRATCH_DIR>/<id>/*/upper` — пустые, с данными в lower: читать слои только через
контейнер (`docker start`, `docker exec`/`docker cp`), не с хоста напрямую. Слой `steamapps`
установщика — без `metacopy` (его upper переносится в библиотеку).

**После сбоя хоста** (пропало питание, перезагрузка, упал dockerd), пока сессия шла, такой
контейнер **не восстанавливать** (п. 2), только выбросить (п. 3). Без fsync файлы в его слоях могли
не дойти до диска. Агент при старте всё равно снимет с них метку, и `docker start` пройдёт, но
профиль из такого контейнера может оказаться битым и заменить хороший.

```sh
ssh brofrong 'docker logs cg-agent 2>&1 | grep profile-unsaved'
ssh brofrong 'docker ps -a --filter label=cg.session --filter status=exited --format "{{.Names}} user={{.Label \"cg.user\"}} base={{.Label \"cg.base-version\"}} {{.Status}}"'
```

1. Устранить причину (обычно — `cg-rustfs` не healthy: `docker logs cg-rustfs`).

   **Внимание:** `docker restart cg-agent` в пп. 2–3 прерывает идущие установки (`cg.install`): они
   не продолжаются, задачи станут `failed`, пользователю придётся нажать «Играть» снова. Перед
   перезапуском проверить, что установок нет: `ssh brofrong 'docker ps -a --filter label=cg.install'`.

2. **Сохранить профиль из контейнера** (если в этой сессии было что-то важное: первый вход Steam,
   локальные сохранения, которых нет в Steam Cloud). Только когда нет других живых сессий (контейнер
   снова займёт GPU и UDP-порт своего слота):
   `ssh brofrong 'docker start cg-session-<id> && docker restart cg-agent'`. Агент при старте
   подхватит живой контейнер, оркестратор не знает такой активной сессии и пришлёт `StopSession`, и
   агент остановит его штатно — с сохранением профиля и удалением контейнера и слоёв (в логе
   `Session stopped` с `profileSaved`). Steam при этом заново не запускается (замок `cg-launch` в
   слое контейнера). Если пользователь уже играл после этой сессии, версия профиля ушла вперёд и
   выгрузка будет отклонена (`profileSaved: false`, контейнер снова остаётся остановленным) —
   более новый профиль остаётся, этот контейнер — выбросить (п. 3). Если причина — размер (больше
   200 МиБ), повтор не поможет: найти, что разрослось
   (`docker cp cg-session-<id>:/tmp/cg-profile.tar /tmp/ && tar -tvf /tmp/cg-profile.tar | sort -k3 -n | tail`),
   и выбросить контейнер (п. 3) либо добавить исключение в `images/session/cg-profile-pack`.
3. **Или выбросить** (профиль этой сессии не нужен): `ssh brofrong 'docker rm cg-session-<id> && docker restart cg-agent'`
   — агент при старте удалит осиротевшие тома `cg-s-<id>-*` и `<SCRATCH_DIR>/<id>` (каталог от
   root, руками без sudo не удалить).

Пункты 2 и 3 описаны по коду агента и на сервере не проверялись — после первого случая уточнить.

## Контейнер сессии не остановился (`docker stop` завис)

Признак: в логе агента `Session container cleanup failed, retrying` (`sessionId`, `container`,
`mode`, `error` — обычно `tried to kill container, but did not receive an exit event`), контейнер
`cg-session-<id>` есть, а сессия в БД уже `ended`/`failed`. Причина — процесс контейнера в
D-состоянии (непрерываемое ожидание ядра, например `sync()` Proton при выходе из игры): его не
убить, пока ядро не отпустит (на пробах — 15–35 мин).

Что делает агент:

- Игрок видит конец сессии сразу (обычный `Stopped`/`Failed` с `cleanupPending: true`), а не
  «Сохраняем прогресс…» и не ошибку остановки.
- Каждые 30 с агент повторяет уборку. Профиль сохранён (`mode: "remove"`): `docker rm -f`, затем
  тома `cg-s-<id>-*` и `<SCRATCH_DIR>/<id>`. Профиль не сохранён (`mode: "stop"`): только
  `docker stop`, контейнер со слоями остаётся (см. «Профиль не сохранён»).
- Пока идут повторы, сессия остаётся в heartbeat агента, и слот держится: на её GPU и UDP-порт
  новую сессию не назначат. Убрал — ближайший heartbeat без сессии освобождает слот. Если в это
  время агент переподключился или перезапустился, в логе оркестратора будет `Stopping container
  of an unknown session` для уже закончившейся сессии — это нормально: агент на этот `StopSession`
  ничего не делает, уборка идёт своим чередом.
- Сразу после сохранения профиля агент пишет метку `<SCRATCH_DIR>/<id>/profile-saved`.
  Перезапуск агента такой контейнер (запущенный или нет) удалит вместе со слоями, профиль второй
  раз не снимается.
- Через 60 мин в логе `session-container-stuck` (`sessionId`, `container`, `mode`, один раз) —
  дальше решает человек. Агент не сдаётся совсем: повторяет уборку каждые 5 мин, сессия остаётся
  в heartbeat, и слот держится, пока контейнер не уберётся (у живого контейнера всё ещё его
  UDP-порт и GPU — новая сессия на этом слоте не стартовала бы).

```sh
ssh brofrong 'docker logs cg-agent 2>&1 | grep -E "Session container cleanup failed|session-container-stuck"'
ssh brofrong 'docker ps -a --filter label=cg.session --format "{{.Names}} {{.Status}}"; ls /home/brofrong/cloud-gaming-scratch/*/profile-saved'
```

После `session-container-stuck`:

1. Найти процесс в D: `ssh brofrong "ps -eo pid,stat,wchan:32,cmd | awk '\$2 ~ /D/'"`.
2. Дождаться его выхода (в D процесс не убить даже `kill -9`).
3. `ssh brofrong 'docker restart cg-agent'`. Метка `profile-saved` есть — агент удалит контейнер
   со слоями (без перезапуска он сделает это сам на ближайшем повторе, до 5 мин). Метки нет
   (профиль не сохранён) — порядок из «Профиль не сохранён».

Предупреждение об установках из «Профиль не сохранён», п. 1, действует и здесь: перезапуск агента
прерывает идущие установки.

## Профиль в RustFS потерян, повреждён или сменился `PROFILE_KEY`

Признак: запуск сессии пользователя падает сразу с «Не удалось загрузить профиль пользователя», в
логе агента `Session failed` с `stage: "get"` и ошибкой вида `NoSuchKey` (объекта нет),
`не удалось расшифровать (AES-GCM)` / `неверная сигнатура` (объект повреждён или зашифрован другим
ключом) или `timeout` (RustFS не отвечает — тогда чинить RustFS, профиль не трогать).

- **`PROFILE_KEY` сменили случайно** — вернуть прежний ключ в `.env` и передеплоить: иначе не
  читается ни один профиль. Ключ не менять никогда, пока в `profiles` есть строки.
- **Объект одного пользователя потерян/повреждён** — удалить его строку в `profiles` (версия
  профиля начнётся заново):

  ```sh
  ssh brofrong "docker exec cg-postgres psql -U cg -d cloud_gaming -c \"delete from profiles where user_id = '<userId>'\""
  ```

  Следующая сессия пользователя: если том `cg-home-<userId>` (MVP-2) ещё есть — профиль заново
  импортируется из него (см. ниже); иначе дом пустой — Steam попросит QR-вход. Пока пользователь не
  вошёл в Steam (в сессии уже установленной игры), установка новых игр для него сразу падает с
  «Сначала войдите в Steam: запустите любую уже установленную игру». Старый объект в бакете можно
  удалить (`... cg-rustfs-bucket s3 rm s3://cg-profiles/<objectKey>`, как `s3 ls` выше).

## Место на диске (`MIN_FREE_GB`)

Слои сессий (`SCRATCH_DIR`, корневая ФС общего сервера) и установок (`INSTALL_SCRATCH_DIR`, ФС
библиотеки) пишутся на общие диски. Перед каждым `StartSession` агент проверяет свободное место на
ФС `SCRATCH_DIR`, перед каждой установкой — на ФС `INSTALL_SCRATCH_DIR` и `SCRATCH_DIR` (`statfs`, место для
непривилегированного пользователя). Меньше `MIN_FREE_GB` ГиБ (по умолчанию 20, переменная в
`.env`) — запуск отклоняется: пользователь видит «На сервере закончилось место» (у установки —
«Не удалось установить игру», у задачи в `install_jobs.error` — «На сервере закончилось место»), в
логе агента — `Not enough free disk space` (`dir`, `freeGb`, `minFreeGb`). Если `statfs` не удался,
запуск не блокируется (предупреждение `Measuring free disk space failed`).

```sh
ssh brofrong 'df -h / /home/brofrong/cloud-gaming-scratch /raid/cloud-gaming'
ssh brofrong 'docker logs cg-agent 2>&1 | grep -E "Not enough free disk space|Measuring free disk space"'
ssh brofrong 'du -sh /home/brofrong/cloud-gaming-scratch/* /raid/cloud-gaming/install-scratch/* 2>/dev/null'
```

Освободить место: остановленные контейнеры `profile-unsaved` (см. выше; их слои — в
`SCRATCH_DIR`), наши старые образы без тега (`docker images --filter dangling=true` — только
`cg-*`, чужие не трогать). Порог меняется в `.env` (`MIN_FREE_GB=…`) и применяется после
`docker compose up -d cg-agent` (перезапуск агента прерывает идущие установки).

## Установка падает: в библиотеке `common/<игра>` без манифеста

Перенос игры в библиотеку — `rename` каталога `common/<installdir>`, затем манифеста
`appmanifest_<appId>.acf`. Если агент упал или перезапустился между ними, в
`/raid/cloud-gaming/library/steamapps/common/` остаётся каталог без манифеста: Steam сессий игру не
видит, а каждая новая установка этой игры падает («Не удалось установить игру», в
`install_jobs.error` — «Не удалось перенести игру в библиотеку», в логе агента `Install failed` с
`app <id> is not unpacked in the install layer`) — агент не перезаписывает существующий каталог.

```sh
# каталоги common/ без манифеста с таким installdir
ssh brofrong 'cd /raid/cloud-gaming/library/steamapps && for d in common/*/; do d=${d#common/}; d=${d%/}; grep -qsF "\"$d\"" appmanifest_*.acf || echo "orphan: $d"; done'
```

Только когда нет живых сессий и установок (`docker ps --filter label=cg.session`,
`--filter label=cg.install`: библиотека — lower их overlay, менять её под смонтированным overlay
нельзя), убрать каталог **из библиотеки, на той же ФС** (владелец — uid 1000, sudo не нужен):

```sh
ssh brofrong 'mkdir -p /raid/cloud-gaming/orphans && mv "/raid/cloud-gaming/library/steamapps/common/<dir>" "/raid/cloud-gaming/orphans/<dir>-$(date +%F)"'
```

Затем повторить установку (пользователь снова нажимает «Играть»). Когда игра встала, удалить
отложенный каталог: `ssh brofrong 'rm -rf "/raid/cloud-gaming/orphans/<dir>-<дата>"'`.

## Импорт старого дома `cg-home-<userId>` (MVP-2)

Происходит сам: при первом запуске (установке или сессии) пользователя, у которого нет записи в
`profiles`, агент читает его том `cg-home-<userId>` (только чтение, помощником `cg-profile-pack`;
архив больше 200 МиБ не импортируется — запуск падает с «Профиль пользователя слишком большой
(больше 200 МиБ)»; тогда владелец вручную удаляет в томе лишнее (код том не меняет) или, если
прогресс не нужен, удаляет том — пользователь войдёт по QR заново),
делает из него профиль и кладёт в дом нового контейнера; при его остановке профиль сохраняется в
RustFS как версия 1. Повторно
QR-вход не нужен. Код том не изменяет и не удаляет никогда. Удалить вручную, когда убедились, что
профиль перенёсся (в `profiles` есть строка пользователя, следующая сессия входит в Steam без QR и
прогресс на месте), и только для этого пользователя:
`ssh brofrong 'docker volume rm cg-home-<userId>'`. Игры, установленные в старом томе, в общую
библиотеку не переносятся — их поставит установщик при первом запуске.

## Клиент Steam: пересборка шаблона

`STEAM_CLIENT_DIR` (`/home/brofrong/cloud-gaming-steam/client`, NVMe) — чистый клиент Steam без входа и без игр,
lower overlay `~/.local/share/Steam` каждой сессии и установки (без шаблона каждая сессия сама
скачивала бы обновление ~500 МБ и распаковывала клиент, ~2,5 ГБ). Собирается на воркере:

```sh
./deploy/build-steam-client.sh            # воркер по умолчанию: brofrong
```

Когда: первый деплой MVP-3; после пересборки образа сессии с новым клиентом Steam; если сессии
начали подолгу входить в Steam или в `<SCRATCH_DIR>/<id>/client/upper` во время сессии пишутся
сотни МБ (клиент обновился — шаблон устарел). Только когда нет сессий и установок (скрипт сам
отказывается и проверяет это ещё раз перед заменой каталога), и **сервис на всё время сборки
должен простаивать**: никто не нажимает «Играть» (новая сессия или установка займёт ту же GPU, а
если появится к концу — скрипт откажется заменять каталог, сборку придётся повторить). Спайк
`cg-spike` должен быть остановлен (одна GPU). Занимает ~5–15 мин; шаблон — ~2,5 ГБ.

Что делает: контейнер `cg-steam-client-build` (метка `cg.template=steam-client`) из
`SESSION_IMAGE` с пустым домом и `CG_MODE=install` (GPU, `shm` 2g, `no-new-privileges`,
`/dev/input`, GBM — как у сессий); Steam сам скачивает обновление (~500 МБ) и распаковывает
клиент. Цикл: ждать `logs/connection_log.txt` и 60 с без роста `~/.local/share/Steam` (рост меньше
1 МБ; `logs/`, `htmlcache/`, `dumps/` не считаются — их клиент пишет и в простое), затем
`cg-steam-shutdown`. Таких цикла два (второй — `steam -silent` через `docker exec` и
`cg-session-exec` в окружении процесса сессии — labwc, на старом образе KDE — plasmashell, как в
`cg-steam-shutdown`): после одного `steamrt64`/`appcache` распакованы не до конца, и сессии потом
сами докачивали ~480 МБ и долго входили. Затем `docker cp` клиента в `<STEAM_CLIENT_DIR>.new` (без
`logs/`, с пустым `steamapps/`, всё 1000:1000), замена каталога `mv --exchange` и удаление старого
шаблона помощником от root. Прервался — контейнер `cg-steam-client-build` удаляется сам (если
остался: `docker rm -f cg-steam-client-build`), рабочий шаблон не меняется до последнего шага.

## Шаблоны префикса Proton

Зачем: Proton при создании префикса игры (`compatdata/<appid>`) дважды зовёт глобальный `sync()` —
он ждёт запись всех грязных страниц хоста, включая чужие диски. На свободном хосте это ~6 с
старта (этап `prepare` 20 Minutes Till Dawn: 23,3 → 16,9 с), на занятом — минуты (базы 200 и
336 с, процесс `proton` в состоянии D 15–35 мин, остановка сессии падала). Раньше префикс
создавался заново в каждой сессии. Теперь агент держит готовый префикс на игру в библиотеке, и
Proton в сессии его не создаёт и `sync()` не зовёт (спека плана 4, «Пробы ускорения» и «Шаблон
префикса: проба сборки»).

Где: `/raid/cloud-gaming/library/steamapps/compatdata/<appid>` (~375 МБ на игру) — lower слоя
`apps` каждой сессии, сессия пишет только в свой upper. В нём файл `cg-template` — сборка Proton
(первая строка `common/Proton - Experimental/version`), из которой он сделан. Другая сборка —
шаблон устарел и пересобирается; до пересборки сессии работают со старым (Proton обновляет его в
своём upper без создания префикса).

Когда собирается (только агентом, только для игр с `.exe` на глубине до 4 и при Proton
Experimental и его Steam Linux Runtime в библиотеке):

- после установки, до «готово»: установка ждёт шаблон не дольше 2 мин, дальше он собирается в
  фоне, а первая сессия идёт без него;
- после сессии, в которой Proton создавал префикс, если шаблона нет или он устарел (в фоне, после
  удаления контейнера сессии);
- вручную — CLI ниже.

Как: помощник `cg-i-pfx-<appid>-build` (метка `cg.helper=prefix-template`) из `SESSION_IMAGE`
без сети, GPU, входа в Steam и профиля; слои — как у установщика (`<SCRATCH_DIR>/.install/pfx-<appid>`,
`<INSTALL_SCRATCH_DIR>/pfx-<appid>`), префикс пишется в `<INSTALL_SCRATCH_DIR>/pfx-<appid>/build`
и переносится в библиотеку `rename`. ~45–60 с на игру (копия рантайма pressure-vessel в tmpfs
помощника ~20 с, Proton ~25–30 с). Пока в библиотеке есть контейнер этой игры (`cg.app=<appid>`:
сессия или установка), шаблон не собирается и не переносится (`deferred`; проверка до сборки и
ещё раз перед переносом) — повторится при следующем поводе.

Удаление игры (`DeleteGame`, см. «Удаление игры» выше) переносит шаблон (`compatdata/<appid>`) в
корзину вместе с манифестом и остальными каталогами игры. Пока шаблон собирается (`ensure` этой
игры ещё не завершился), удаление отказывает с причиной «Собирается шаблон префикса» — агент не
трогает каталог, в который сейчас пишет Proton.

Что внутри: префикс, который создал Proton, включая его умолчания `pfx/user.reg` и
`pfx/drive_c/users/steamuser` (данных игрока там нет — помощник без входа и профиля; файлы игрока
из профиля ложатся сверху). Если в префиксе найден `steam_autocloud.vdf`, шаблон не переносится.
`MachineGuid` в `pfx/system.reg` у всех игроков игры общий до пересборки шаблона (с аккаунтом не
связан). `cg-profile-pack` кладёт в профиль игрока умолчания префикса и для игр, в которые он не
играл, — килобайты на игру.

Как посмотреть:

```sh
ssh brofrong 'cd /raid/cloud-gaming/library/steamapps/compatdata && for d in */; do echo "${d%/} $(head -1 "$d/cg-template" 2>/dev/null || echo "-")"; done'
ssh brofrong 'docker logs cg-agent 2>&1 | grep "Prefix template"'
ssh brofrong 'docker logs cg-agent 2>&1 | grep "Install finished" | tail -3'   # поле prefixTemplate
```

Исходы в логе: `Prefix template built` (`appId`, `build`), `Prefix template deferred: app in use`,
`Prefix template skipped` (`why`: нет Proton/рантайма, нет `.exe`, мало места, нет
`INSTALL_SCRATCH_DIR`), `Prefix template build failed` (`error`), `Prefix template has player
data` (пути). У установки в `Install finished` — `prefixTemplate`: `built`/`fresh`/…, `pending` —
не дождались за 2 мин.

Пересобрать вручную (например, после ручной смены Proton в библиотеке — сам установщик Proton
не обновляет): только когда нет сессий и установок (`docker ps -a --filter label=cg.session`,
`docker ps -a --filter label=cg.install` — по отдельности; имена помощника те же, что у агента).
По очереди, на каждый appid — строка `<appid> <исход>`, код 1 при `failed`:

```sh
ssh brofrong 'cd /raid/cloud-gaming/library/steamapps && docker exec cg-agent bun apps/agent/src/prefixTemplateCli.ts $(ls appmanifest_*.acf | sed "s/appmanifest_//; s/\.acf//")'
```

Рантаймы и игры без `.exe` дадут `skipped` — это нормально.

Выбросить битый шаблон (игра в сессиях падает на старте Proton, а без шаблона шла): без живых
сессий этой игры, на той же ФС, как в «common без манифеста»; следующая сессия создаст префикс
сама, после неё агент соберёт шаблон заново:

```sh
ssh brofrong 'mkdir -p /raid/cloud-gaming/orphans && mv /raid/cloud-gaming/library/steamapps/compatdata/<appid> "/raid/cloud-gaming/orphans/compatdata-<appid>-$(date +%F)"'
```

Помощник завис (Proton в `sync()` на занятом хосте, состояние D): `docker ps -a --filter
label=cg.helper` покажет `cg-i-pfx-<appid>-build`. Установка ждёт его не дольше 2 мин, сессии он
не мешает; агент ждёт выхода помощника до 10 мин и тогда считает сборку неудачной. Остатки
(контейнер, тома `cg-i-pfx-*`, каталоги `pfx-<appid>`) агент убирает при следующем старте.

## Вход в Steam по QR

Игрок подключает Steam на самом сайте (`/library`, `/profile` или экран сессии): QR-код,
отсканировать приложением Steam на телефоне (устройство называется «GameCrate»), подтвердить вход.
Это одновременно и привязка Steam-аккаунта (`account`/`user.steam_id`), и источник входа — отдельной
кнопки Steam OpenID в интерфейсе больше нет (сам плагин `better-auth-steam` с сервера не убран,
просто больше не вызывается из UI). Токен живёт в оркестраторе в памяти — до 24 ч или до того, как
оркестратор примет коммит профиля с `steamLoginSeeded: true` (профиль уже хранит вход, сеять больше
незачем), — и прикладывается к каждому следующему запуску/установке этого игрока; агент перед стартом
контейнера вписывает его в четыре файла клиента Steam (`local.vdf`, `loginusers.vdf`, `config.vdf`, `registry.vdf`), а сохранение
профиля в конце сессии/установки уносит обновлённый вход в RustFS — отдельно токен никогда не
хранится. Формат этих файлов не документирован Valve и может сломаться с обновлением клиента, поэтому
после каждой пересборки шаблона клиента (`./deploy/build-steam-client.sh`) нужно **руками** пройти
QR-вход на тестовом аккаунте и поставить любую игру.

Запрос к Steam (`api.steampowered.com`) для самой QR-сессии теперь идёт из `cg-orchestrator`, а не
из `cg-api`: сеть `cg` — обычный bridge (не `internal`), исходящий доступ в интернет есть так же, как
у `cg-api` (библиотека уже туда ходит) — доменных блокировок нет, отдельная настройка не нужна.

Никогда не задавать `DEBUG` (`DEBUG=*`, `DEBUG=steam-session*` и т.п.) у `cg-orchestrator`:
отладочный вывод библиотеки `steam-session` печатает refresh-токен в лог контейнера.

Признак поломки формата — предупреждение в логе агента:

```sh
ssh brofrong 'docker logs cg-agent 2>&1 | grep "Seeded Steam login was not accepted"'
```

Его пишет **только установщик**: вход был вписан этим запуском, а клиент Steam не вошёл за
`steamLoginTimeoutSeconds` (настройка «Ожидание входа в Steam установщиком» в админке, 30–600 с, по
умолчанию 90), отсчитанные не с первых строк журнала подключения (`logs/connection_log.txt` — клиент
начинает писать его, только закончив свой bootstrap/самообновление), а с момента, когда клиент в этом
журнале реально **позвал** `LogOn()` (строка попытки входа) — на части железа от первых строк журнала
до этой попытки проходит до пары минут, и раньше таймаут истекал, не дождавшись самой попытки. До
попытки входа отдельный фиксированный лимит — 5 мин от первых строк журнала; истёк — тот же «Войдите
в Steam» и то же предупреждение (вписанный вход всё равно не был принят). Сессии игры это
предупреждение не пишут никогда — поэтому проверка после пересборки клиента — именно **установка**
игры, а не запуск. Если журнал подключения так и не появился за 10 мин — установка падает как
«Загрузка остановилась», без этого предупреждения.

Скорее всего, Valve сменила формат `local.vdf`/`loginusers.vdf`. Что видит игрок при сломанном
формате:

- **сессия игры** — обычное окно входа Steam в трансляции; QR в нём работает, игрок войдёт сам;
- **установка** — падает с «Войдите в Steam» (на экране — «Войдите в Steam ещё раз» и QR сайта);
  новый QR снова кладёт вход в тех же форматах, установка снова падает — круг не разорвать, пока не
  исправлен формат файлов в агенте (`apps/agent/src/steam/loginSeed.ts`).

Отозвать тестовое устройство: в приложении Steam на телефоне → значок щита (Steam Guard) →
«Устройства» → найти «GameCrate» → отозвать. Следующий запуск/установка этого игрока увидит
«Войдите в Steam ещё раз» и экран QR.

## Свои игры: сборка пакета (`add-game.sh`)

Свои игры (фанатские ПК-порты вне Steam, первая — Ship of Harkinian) описаны в `games/<slug>/`
(`games/README.md`). Пакет собирается на воркере, с мака:

```sh
./deploy/add-game.sh soh --input rom=<путь к ROM Ocarina of Time>
```

Скрипт читает `games/<slug>/game.json` (`version`, `binary`, `inputs` — каждый вход обязателен) и
из серверного `.env` только `CG_DATA_DIR` и `SESSION_IMAGE`. Пакет этой версии уже есть — выход
(«уже есть»; `--rebuild` пересобирает, если на версии не идёт сессия). Дальше:

- свой каталог запуска `~/cg-games-src/<slug>.XXXXXX` (`mktemp`): `src/` (`rsync games/<slug>/`),
  `build.sh`, `build.log`, `build.rc`. Удачный запуск его удаляет, неудачный оставляет с логом —
  такие каталоги старше суток убирает следующая сборка игры. Две сборки одной игры не идут разом:
  вторая упирается в замок `~/cg-games-src/<slug>.lock` и выходит, не трогая первую;
- сборка на хосте стартует отдельным процессом (`setsid nohup`) **до** передачи входных файлов:
  она создаёт временный каталог для них (`mktemp -d`, на brofrong `/tmp` — tmpfs), и её ловушка
  удаляет его на любом выходе. Если мак пропал посреди передачи (обрыв, сон, kill), сборка ждёт
  файлы не дольше часа и выходит, удалив каталог. Занят замок или на версии идёт сессия — сборка
  выходит сразу, и ROM не передаётся;
- входные файлы — 8 частей параллельно, каждая с докачкой после обрыва, на хосте склейка и сверка
  SHA-256. Канал с мака до brofrong бывает 5–20 КиБ/с на соединение и рвётся каждые 10–20 минут:
  одним потоком ROM 32 МиБ шёл около двух часов, scp падал по таймауту. Мак показывает лог сборки
  и после обрыва переподключается. Связь пропала совсем — сборка доходит до конца там же (`ssh
  brofrong tail -f ~/cg-games-src/<slug>.XXXXXX/build.log`). Ctrl-C на маке останавливает её;
- образ `cg-game-builder-<slug>:<version>` из `builder.Dockerfile` (`FROM ${SESSION_IMAGE}`);
- `docker run --rm --init --user 1000:1000` сборщика: `/game` (ro), `/input` (ro),
  `/out = <GAMES_DIR>/<slug>/.build-<version>`. После него входные файлы удаляются сразу. Если
  удалить их не вышло ни на хосте, ни с мака, скрипт печатает команду для ручного удаления;
- `ldd` бинарника в `SESSION_IMAGE`: чего нет — из сборщика в `lib/`, не больше 5 проходов;
- проверки: есть `run` и бинарник, нет ROM (`*.z64`, `*.n64`, `*.v64`) и копий входных файлов
  под любым именем (тот же размер и SHA-256);
- `.build-<version>` → `<version>`. При `--rebuild` занятость версии проверяется ещё раз прямо
  перед заменой: если за время сборки на ней началась сессия, старая версия остаётся, новая
  удаляется. Из прочих версий остаётся одна, самая свежая по mtime. Версии под живой сессией
  (метка `cg.own-game`) не удаляются.

Каталоги с точкой в `<GAMES_DIR>/<slug>/` (`.build-<version>`) — недособранные пакеты, не версии.
Сборка не трогает сессии и compose-сервисы, деплой для неё не нужен. Агент видит новый пакет после
деплоя с `GAMES_DIR`. Игроки видят игру, когда в админке включено «Открыта игрокам».

Файлов Nintendo (ROM, `.o2r`, `roms/`) нет в git, в образах и в rsync деплоя: `.gitignore`,
`.dockerignore`, исключения `rsync` в обоих скриптах.

## Смена образа сессии: перетег и откат

С релизами через CI образ сессии приходит из реестра (`SESSION_IMAGE=…/cg-session:<драйвер>-<тег>`,
его пишут `install.sh` и `deploy-stand.sh`); откат — прежний тег в `SESSION_IMAGE` и `up -d`.
Ниже — прежний способ для опытов на стенде: образ, собранный на brofrong, и перетег.

Агент берёт образ сессии по `SESSION_IMAGE`. Новый образ
собирается рядом под своим тегом (`./deploy/build-session-image.sh brofrong <суффикс>` →
`cg-session:<версия>-<суффикс>`) и становится рабочим перетегом — без деплоя и без перезапуска
агента (каждая новая сессия создаётся из образа по тегу; идущие не затрагиваются). Только когда
нет сессий и установок, и сразу после — пересборка шаблона клиента Steam новым образом.

Переход на образ-киоск (план 4, 2026-10-28; прежний образ KDE сохранён как `-kde`):

```sh
ssh brofrong 'docker tag cg-session:550.163.01 cg-session:550.163.01-kde && docker tag cg-session:550.163.01-kiosk cg-session:550.163.01'
./deploy/build-steam-client.sh
```

Откат (сессия не стартует, нет картинки, не работает ввод): без сессий и установок

```sh
ssh brofrong 'docker tag cg-session:550.163.01-kde cg-session:550.163.01'
```

Шаблон клиента Steam при откате не пересобирается: это файлы клиента, от образа они не зависят
(киоск проверялся на шаблоне, собранном образом KDE). Да и `build-steam-client.sh` на образе
`-kde` откажется: в нём нет `cg-session-exec`. Агент и оркестратор работают с обоими образами
(агент зовёт только скрипты самого образа). Шаблоны префикса Proton от образа не зависят. Старые
теги удалять (`docker rmi`) только когда откат уже не нужен.

### Подстройка битрейта (меню сессии, 2026-10-28)

Меню сессии позволяет игроку выбрать потолок битрейта видео. Selkies может подстраивать битрейт под
сетевые условия (congestion control по отчётам WebRTC). Без подстройки видео идёт с фиксированным
битрейтом из меню, вне зависимости от сети.

**Сборка образа с поддержкой подстройки:**

```sh
./deploy/build-session-image.sh brofrong cc
```

Образ соберётся как `cg-session:550.163.01-cc`. Проверка, что настройка включена:

```sh
docker image inspect cg-session:550.163.01-cc --format '{{json .Config.Env}}' | grep SELKIES_CONGESTION_CONTROL
```

Должна быть строка с `SELKIES_CONGESTION_CONTROL=true`.

**Перетег только без живых сессий и установок** (см. выше, условие смены образа). Меню работает
с обоими образами (потолок из меню применяется как фиксированный битрейт). Новая функция подстройки
работает только с образом `-cc`:

```sh
ssh brofrong 'docker tag cg-session:550.163.01 cg-session:550.163.01-nocc && docker tag cg-session:550.163.01-cc cg-session:550.163.01'
./deploy/build-steam-client.sh
```

Откат (без живых сессий и установок):

```sh
ssh brofrong 'docker tag cg-session:550.163.01-nocc cg-session:550.163.01'
```

Шаблон клиента Steam при откате не пересобирается.

## Обновление драйвера NVIDIA на игровом сервере

Образ сессии содержит 32-битные библиотеки NVIDIA ровно версии драйвера хоста, а агент
пробрасывает GBM-бэкенд по пути с версией. Порядок:

1. Новая версия `<ver>` — строкой в `images/session/drivers.txt`, затем релиз (раздел «Релиз»): CI
   соберёт `cg-session:<ver>-<тег>`.
2. Без сессий и установок («На обслуживание») владелец обновляет драйвер и перезагружает сервер;
   `nvidia-smi` → `<ver>`, есть `libnvidia-allocator.so.<ver>` (Debian —
   `/usr/lib/x86_64-linux-gnu/nvidia/current/`, Ubuntu — `/usr/lib/x86_64-linux-gnu/`).
3. Игровой сервер: в `/opt/cloud-gaming/.env` — `SESSION_IMAGE=…/cg-session:<ver>-<тег>` и
   `GBM_ALLOCATOR_PATH=…/libnvidia-allocator.so.<ver>`, `docker pull <SESSION_IMAGE>`, `up -d`,
   `apply-local`. Стенд: `GBM_ALLOCATOR_PATH` в `~/cloud-gaming/.env` (по умолчанию в
   `compose.stand.yaml` — для 550.163.01), затем `./deploy/deploy-stand.sh <тег>` (сам определит
   драйвер и `SESSION_IMAGE`).
4. Шаблон клиента Steam от драйвера не зависит. Старые образы — `docker rmi`, когда на них нет
   сессий.

## Приёмка MVP (история, делал владелец)

Главная страница после входа — `/app` (библиотека «Мои игры», «В тренде», «Из ящика», «Время»);
старый `/library` перенаправляет на неё.

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
  Selkies — WebSocket через ingressi, `cg-api` и тоннель агента); в консоли браузера нет ошибок
  WebSocket про
  subprotocol (`Sec-WebSocket-Protocol`) и циклических переподключений.

MVP-3 (магазин игр и профили). До деплоя: `./deploy/build-session-image.sh`,
`./deploy/build-steam-client.sh`, затем деплой; сессий в начале нет.

1. Vampire Survivors (нет в библиотеке) → «Устанавливаем N %» растёт → игра; профиль
   импортирован из `cg-home-*` — QR не спрашивали.
2. Поиграть, получить прогресс, выйти → в `profiles` версия 1, объект в RustFS
   (`profiles/<userId>/…cgp`); `<SCRATCH_DIR>` пуст, томов `cg-s-*` нет.
3. Снова Vampire Survivors → без установки, ≤ 60 с от «Играть» до игры, прогресс на месте.
4. 20 Minutes Till Dawn (Proton) → установка → сохранение в игре → выход → снова → сохранение на
   месте.
5. Вторая вкладка/второй аккаунт на ту же неустановленную игру (если есть второй аккаунт) — одна
   установка, общий процент.
6. Библиотека: `steamapps` содержит только `appmanifest_*.acf`, `common/<игры и рантаймы>` и
   `compatdata/<appid>` игр на Proton — в каждом есть `cg-template` (шаблоны префикса, план 4);
   нет `workshop`, `shadercache`, `Steam Controller Configs`.

## Если `https://game.brofrong.ru` отдаёт 502, а `cg-api` healthy

Проверять только нашу часть — контейнер/сеть `cg-api`, никогда конфиг Caddy/ingressi:

- `ssh brofrong 'docker inspect cg-api --format "{{json .NetworkSettings.Networks}}"'` — `cg-api`
  должен быть в сети `proxy` (и в `cg`).
- `ssh brofrong 'docker exec ingressi-caddy wget -qO- http://cg-api:3000/healthz'` (если на
  `ingressi-caddy` есть `wget`/`curl`) — проверка связности из сети `proxy`, не трогая конфиг.
- Если причина не в нашей сети/контейнере, сообщить владельцу с подробностями, а не менять его
  конфиг Caddy.
