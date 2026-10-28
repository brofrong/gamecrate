# Деплой на brofrong — game.brofrong.ru

## Что здесь

- `Dockerfile` — один образ приложения `cloud-gaming/cg-api:latest`: `bun install --frozen-lockfile`
  (включает патч `drizzle-orm` из `patches/`), `bun run build` (собирает SPA в `apps/web/dist`).
  По умолчанию запускает `bun apps/api/src/main.ts`; `cg-orchestrator` и `cg-agent` в compose берут
  тот же образ со своим `command` (`apps/orchestrator/src/main.ts`, `apps/agent/src/main.ts`).
  Всё запускается из исходников, без транспиляции; секретов в образе нет (`.dockerignore`).
- `compose.yaml` — боевой compose-проект `cloud-gaming` на сервере: `cg-api`, `cg-postgres`,
  `cg-orchestrator`, `cg-agent`, `cg-rustfs`; одноразовый `cg-rustfs-bucket` (профиль `tools`,
  запускает `deploy.sh`).
- `deploy.sh` — отказ при живых сессиях/установках, rsync репозитория на `brofrong:~/cloud-gaming`,
  `AGENT_TOKEN`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `PROFILE_KEY` в серверный `.env` (если
  их там нет), каталоги хоста, сеть `cg-sessions` (если нет), бакет профилей,
  `docker compose up -d --build`.
- `build-session-image.sh` — сборка образа сессии `cg-session:<версия драйвера>` на воркере
  (см. `images/session/README.md` и раздел «Обновление драйвера NVIDIA» ниже).
- `build-steam-client.sh` — сборка шаблона клиента Steam `STEAM_CLIENT_DIR` на воркере (раздел
  «Клиент Steam: пересборка шаблона» ниже).
- `measure-session-start.sh <userId> <appId> [запусков]` — замер запуска установленной игры
  (от «Играть» до `Game started`, медиана); запускает настоящие сессии пользователя, только на
  свободном воркере.
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
  связь видна в логе оркестратора и в `workers.last_seen_at`. `mem_limit` 1g (профиль до 200 МиБ сжимается и шифруется в памяти целиком). Роли
  `ROLES=worker,gamestore`: сессии и установка игр в общую библиотеку. Стартует после
  `cg-rustfs` (healthy).
  GPU: `deploy.resources.reservations.devices` с `capabilities: [utility]` (не `all`/`compute`
  и не весь набор по умолчанию) — NVIDIA Container Toolkit подкладывает только `nvidia-smi` и
  NVML для метрик админки, видеопамять и вычисления агент не занимает (это не контейнер сессии).
  **Из-за этой резервации `cg-agent` не стартует, если NVIDIA Container Toolkit или NVML на
  хосте не работают** (например, после обновления драйвера без перезагрузки — см. «Обновление
  драйвера NVIDIA» ниже): `docker compose up`/`docker inspect cg-agent` в этом случае покажет
  ошибку про `nvidia`/`could not select device driver`/недоступное устройство, а не тихо
  запустится без GPU. Чинится на уровне хоста (перезагрузка/переустановка toolkit), не в
  compose — сессиям эта же GPU нужна всё равно, слабже требование тут не поможет.
  Переменные (значения по умолчанию в `compose.yaml` — для brofrong; переопределяются в `.env`):
  `WORKER_ID=brofrong`, `WORKER_PUBLIC_IP=37.153.14.138`, `SLOTS=1`, `UDP_PORT_BASE=59000`,
  `SESSION_IMAGE=cg-session:550.163.01`,
  `GBM_ALLOCATOR_PATH=/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01`,
  `SESSION_NETWORK=cg-sessions`, `DOCKER_SOCKET=/var/run/docker.sock`, `ROLES=worker,gamestore`,
  `CG_DATA_DIR=/raid/cloud-gaming`, `SCRATCH_DIR=/home/brofrong/cloud-gaming-scratch`,
  `STEAM_CLIENT_DIR=/home/brofrong/cloud-gaming-steam/client`,
  `STEAM_CLIENT_PARENT=/home/brofrong/cloud-gaming-steam` (родитель `STEAM_CLIENT_DIR` — см. ниже),
  `S3_BUCKET=cg-profiles`, `MIN_FREE_GB=20` (см. «Место на диске»). Задаёт сам compose: `S3_ENDPOINT=http://cg-rustfs:9000`,
  `S3_ACCESS_KEY`/`S3_SECRET_KEY` = `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`, `PROFILE_KEY` из
  `.env`, `LIBRARY_DIR`, `INSTALL_SCRATCH_DIR` — внутри `CG_DATA_DIR`, а также `CG_COMMIT`
  (по умолчанию `unknown`) — коммит этого деплоя для блока «Версии» админки: `deploy.sh` считает
  его локально (`git rev-parse --short HEAD`, суффикс `-dirty` при незакоммиченных изменениях —
  `.git` в образ и на сервер не попадает, см. `rsync --exclude ".git/"` ниже) и передаёт
  `CG_COMMIT=<значение>` в окружении `docker compose up` на сервере — в `.env` эта переменная не
  пишется и не должна.
- Каталоги хоста (владелец `brofrong`, uid 1000; создаёт `deploy.sh` без sudo):

  | Каталог                                                  | Что                                                                                       |
  | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
  | `LIBRARY_DIR=/raid/cloud-gaming/library`                 | общая библиотека: `steamapps/appmanifest_*.acf`, `steamapps/common/<игра>` и шаблоны префикса Proton `steamapps/compatdata/<appid>` (см. «Шаблоны префикса Proton»); lower сессий |
  | `STEAM_CLIENT_DIR=/home/brofrong/cloud-gaming-steam/client` | шаблон клиента Steam (`build-steam-client.sh`, NVMe), внутри пустой `steamapps/`; lower сессий и установщиков |
  | `STEAM_CLIENT_PARENT=/home/brofrong/cloud-gaming-steam`  | родитель `STEAM_CLIENT_DIR` — то, что реально монтируется в `cg-agent` (см. ниже), сам не используется агентом |
  | `INSTALL_SCRATCH_DIR=/raid/cloud-gaming/install-scratch` | upper/work слоя `steamapps` установщиков; та же ФС, что библиотека (перенос `rename`)     |
  | `SCRATCH_DIR=/home/brofrong/cloud-gaming-scratch`        | upper/work сессий (NVMe), `<SCRATCH_DIR>/<sessionId>/…`, и слоя клиента Steam установщиков, `<SCRATCH_DIR>/.install/<jobId>/…`; после сессии/установки пусто |

  В `cg-agent` они смонтированы по тем же путям: `CG_DATA_DIR` (`/raid/cloud-gaming`) — **одним**
  bind (перенос `rename` между двумя bind даже одной ФС невозможен — `EXDEV`) и `SCRATCH_DIR` —
  отдельным; оба с `create_host_path: false` (нет каталога — агент не стартует, а не получает
  каталог root). Для `STEAM_CLIENT_DIR` в агент смонтирован (**`read_only: true`**) не он сам, а
  его родитель `STEAM_CLIENT_PARENT`: агенту нужна только mtime каталога (дата сборки шаблона в
  блоке «Версии» админки) — bind самого `STEAM_CLIENT_DIR` держал бы старый каталог после
  `build-steam-client.sh` (он меняет каталог через `mv -T --exchange`, а bind-mount помнит
  дентри на момент монтирования, а не путь — после обмена агент читал бы mtime прошлой сборки
  до пересоздания контейнера); bind родителя резолвит путь заново при каждом обращении. dockerd
  клиент передаётся как lower overlay по пути хоста, не через этот bind. Шаблон лежит на NVMe, а
  не в `CG_DATA_DIR`: с холодного кэша (его вытесняют соседние нагрузки) Steam читал его с RAID
  на HDD и стартовал 50–90 с вместо ~16. `SCRATCH_DIR` — вне каталога деплоя `~/cloud-gaming`
  (его `rsync --delete` и контекст сборки не должны задевать слои сессий). В библиотеку пишет
  только агент (перенос установленных игр и шаблонов префикса); руками туда ничего не класть.

- `cg-rustfs` (`rustfs/rustfs:1.0.3`, volume `cg-rustfs-data` → `/data`) — хранилище профилей
  (S3, `:9000`), только сеть `cg`, порты наружу не публикуются, `mem_limit` 512m. Ключи —
  `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` из `.env` (корневые ключи RustFS; агент ходит с ними же).
  Лог — в `docker logs` (`RUSTFS_OBS_LOG_DIRECTORY` пуст). Healthcheck: `GET /health`. В бакете
  `cg-profiles` — `profiles/<userId>/<uuid>.cgp` (`CGP1` + AES-256-GCM, ключ `PROFILE_KEY`), версия
  профиля — в таблице `profiles`. На сервере есть чужие RustFS (`brotracker-prod-rustfs`,
  `exam-platform-rustfs`, образ 1.0.1) — не наши, не трогать.
- Контейнеры сессий `cg-session-<sessionId>` создаёт агент (не compose): сеть `cg-sessions`, метки
  `cg.session`/`cg.slot`/`cg.app`/`cg.user`/`cg.base-version`, наружу опубликован только UDP-порт
  слота (`59000/udp` для слота 0). Дом — слой контейнера (профиль кладётся до старта, снимается при
  остановке), `~/.local/share/Steam` и `steamapps` — overlay-тома `cg-s-<id>-client`/`cg-s-<id>-apps`
  (lower — шаблон клиента и библиотека, upper — `SCRATCH_DIR/<id>`). `docker compose up/down` их не
  трогает; агент после перезапуска подхватывает живые по метке `cg.session`.
- Установщики `cg-install-<jobId>` (роль `gamestore`, метка `cg.install`): тот же образ, без
  UDP-порта, тома `cg-i-<jobId>-*`: upper клиента Steam — в `SCRATCH_DIR/.install/<jobId>` (NVMe:
  pressure-vessel при старте копирует туда рантайм мелкими файлами с fsync, на RAID Steam не
  успевает запуститься), upper `steamapps` — в `INSTALL_SCRATCH_DIR/<jobId>`. Steam ставит игру,
  агент переносит новые приложения в библиотеку и удаляет контейнер и слои. Установки, прерванные
  перезапуском агента, не продолжаются: агент убирает их остатки при старте.
- Права в контейнере сессии: агент создаёт его с `--security-opt no-new-privileges:true` (в
  базовом образе у `ubuntu` `NOPASSWD: ALL` в sudoers и свой `/etc/shadow`; с флагом `sudo`, `su`,
  `pkexec` права не поднимают), `--tmpfs /dev/input:mode=1777` (каталог для интерпозера геймпадов,
  без sudo entrypoint его не создаст) и случайным `PASSWD` на каждый контейнер.
  Сетевая изоляция контейнеров сессий — см. раздел «Сетевая изоляция контейнеров сессий (новый
  сервер)» ниже.
- Реверс-прокси (Caddy, `ingressi`) снаружи сети `proxy` проксирует `https://game.brofrong.ru` на
  `http://cg-api:3000` — это настраивает владелец сервера (см. шаг 2 ниже), наш деплой этого не
  делает и не трогает чужие контейнеры/сети/конфиг Caddy.

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
кнопкой «Отменить», ниже итоги за 7 дней. Вкладка «Пользователи» — в следующей части. Подробности и решения по реализации —
`docs/superpowers/specs/2026-10-28-admin-orchestration-design.md`.

**Удаление игры.** Нельзя, пока в игру играют или она ставится. Api ставит
`gamestore_apps.deleting_at`, оркестратор шлёт агенту с ролью `gamestore` `DeleteGame`: агент
переносит манифест и `common/<installdir>` (и `shadercache/<appId>`) в `<LIBRARY_DIR>/.trash` той же
ФС и очищает корзину (что не может uid 1000 — помощником от root; остаток корзины убирается при
следующем удалении или старте агента). Пока игра удаляется, её сессии ждут в очереди, после — ставят
игру заново обычной установкой.

**Отмена установки.** Api ставит `install_jobs.cancel_requested_at`: задача в очереди сразу
`failed`, идущей оркестратор шлёт `CancelInstall`; ждущие сессии завершаются с причиной «Установка
отменена администратором». Если агент уже переносит игру в библиотеку, отмена не успевает — игра
остаётся установленной.

**«На обслуживание» перед деплоем.** Кнопка на карточке воркера (там же «Вернуть в работу»):
воркер на обслуживании доигрывает текущие сессии и установки, но новых не берёт — так можно
заранее перекрыть приток новых сессий, не дожидаясь, пока `deploy.sh` откажется деплоить из-за
живых `cg.session`/`cg.install` (см. «Шаг 4: деплой»). Флаг (`workers.draining`) переживает
перезапуск агента и оркестратора; сам деплой его не трогает — возвращать воркер в работу нужно
руками, после деплоя.

## Сетевая изоляция контейнеров сессий (новый сервер)

Контейнеры сессий и установщиков (сеть `cg-sessions`) должны видеть интернет (Steam, игры), но не
адреса хоста, локальную сеть и другие контейнеры моста, кроме `cg-api` → Selkies сессий `:8080`
(поток стрима через `cg-api`). На `brofrong` сейчас изоляции нет — у нас нет sudo на этот хост, и
применять правила там нельзя; на новом (арендованном) сервере, где у владельца есть sudo, это надо
сделать перед тем, как пускать на сервер посторонних игроков.

- `deploy/session-isolation.sh` — только печатает правила (ничего не применяет и не нужен sudo,
  чтобы его запустить):
  - `detect [ssh-хост=brofrong]` — читает (не меняет) `docker network inspect cg-sessions` и
    `docker inspect cg-api` на сервере, печатает аргументы для `print`;
  - `print --subnet <cidr> --bridge <ifname> --api-ip <ip> [--subnet6 <cidr>]` — печатает фрагмент
    дампа `iptables-save`/`ip6tables-save` (таблица `filter`, цепочки `DOCKER-USER` и `INPUT`).
- `deploy/check-session-isolation.sh [ssh-хост=brofrong]` — проверка без sudo: два временных
  контейнера в `cg-sessions` (свои, с меткой `cg.isolation-check`, без GPU, удаляются в конце),
  изнутри одного — `curl -m 3` к шлюзу моста, LAN-адресу и LAN-шлюзу хоста, второму контейнеру
  `:8080`, `cg-api:3000` и в интернет. Печатает таблицу «цель | ожидается | факт»; код 0 — всё как
  ожидается, код 1 — где-то открыто то, что должно быть закрыто.

Порядок на новом сервере. Шаги 1–3 — локально (в репозитории, с машины, у которой есть ssh-доступ
на сервер; sudo не нужен ни здесь, ни для `detect`/`print`), шаги 4–6 — на сервере, с sudo, делает
владелец:

1. Узнать подсеть/мост/IP `cg-api`: `./deploy/session-isolation.sh detect <хост>`.
2. Напечатать и сохранить правила:
   `./deploy/session-isolation.sh print $(./deploy/session-isolation.sh detect <хост>) > /tmp/cg-session-isolation.rules`.
3. Посмотреть их глазами: `cat /tmp/cg-session-isolation.rules` — прежде чем применять.
4. Применить на сервере: IPv4-часть — всё до строки `# ip6tables`, если она есть; IPv6-часть —
   после неё, без самой этой строки:

   ```sh
   sed '/^# ip6tables/,$d' /tmp/cg-session-isolation.rules | ssh <хост> 'sudo iptables-restore -n'
   sed -n '/^# ip6tables/,$p' /tmp/cg-session-isolation.rules | tail -n +2 | ssh <хост> 'sudo ip6tables-restore -n'
   ```

   `-n` (noflush) не трогает остальные правила хоста и другие таблицы/цепочки; политики встроенных
   цепочек в дампе помечены `-` — `*tables-restore` их не меняет. `DOCKER-USER` — общая цепочка для
   всех сетей docker на хосте: если на сервере будут другие правила в ней, аккуратно совмещать
   руками; повторное применение добавит дубликаты строк — перед повтором старые лучше убрать.
5. Сохранить правила после перезагрузки (Debian/Ubuntu):
   `sudo apt install iptables-persistent && sudo netfilter-persistent save`.
6. Проверить: `./deploy/check-session-isolation.sh <хост>` → код 0, в таблице везде «факт»
   совпадает с «ожидается».

Если `cg-api` пересоздан (например, после деплоя) — у него может измениться IP в `cg-sessions`,
и правило для `:8080` перестанет пускать нужный трафик (или наоборот, останется открытым для
старого, уже не существующего адреса). Повторить шаги 1–3 с текущим `detect`.

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
   - `SMTP_URL` — настоящий SMTP для писем с кодом входа (например
     `smtps://user:pass@smtp.example:465`). **`SMTP_URL=log://` только для dev** (пишет письма в
     лог вместо отправки) — `apps/api/src/config.ts` разрешает его лишь когда `PUBLIC_URL` —
     `localhost`/`127.0.0.1`, в проде с `PUBLIC_URL=https://game.brofrong.ru` сервис не стартует.
   - `MAIL_FROM` — заголовок `From` писем, например `GameCrate <no-reply@brofrong.ru>`.
   - Необязательно (каждая пара — вместе или не задавать вовсе, пустая строка тоже считается «не
     задано»): `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `YANDEX_CLIENT_ID`/`YANDEX_CLIENT_SECRET`,
     `TELEGRAM_CLIENT_ID`/`TELEGRAM_CLIENT_SECRET` — ключи провайдеров входа, завести их на сервере
     владелец может и после первого деплоя (шаг 2 ниже, п. 3–5): провайдер без ключей просто не
     появится на `/login`.

   - `AGENT_TOKEN` — новый случайный, не короче 32 символов (без вывода на экран):
     `grep -q '^AGENT_TOKEN=' .env.production || printf 'AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env.production`.
     Если на сервере уже есть `.env` без `AGENT_TOKEN`, `deploy.sh` сам допишет туда эту строку из
     `.env.production` (одну строку, остальные значения не читает и не меняет).
   - `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` — ключи хранилища профилей `cg-rustfs`, каждый не
     короче 16 символов, и `PROFILE_KEY` — ключ шифрования профилей, base64 ровно 32 байт (без
     вывода на экран):

     ```sh
     grep -q '^RUSTFS_ACCESS_KEY=' .env.production || printf 'RUSTFS_ACCESS_KEY=%s\n' "$(openssl rand -hex 24)" >> .env.production
     grep -q '^RUSTFS_SECRET_KEY=' .env.production || printf 'RUSTFS_SECRET_KEY=%s\n' "$(openssl rand -hex 24)" >> .env.production
     grep -q '^PROFILE_KEY=' .env.production || printf 'PROFILE_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.production
     ```

     Как и `AGENT_TOKEN`, `deploy.sh` допишет в серверный `.env` недостающие из этих строк (и
     откажется деплоить, если их нет и в `.env.production` или значение не проходит проверку).
     **`PROFILE_KEY` не менять и не терять:** им зашифрованы все профили в RustFS; с другим ключом
     агент их не расшифрует (вход Steam и сохранения пользователей пропадут). Хранить копию
     `.env.production` в надёжном месте. Ключи RustFS менять только вместе (RustFS берёт корневые
     ключи из окружения при каждом старте, данные тома сохраняются).

   - Необязательно (не секреты): `CG_DATA_DIR` (по умолчанию `/raid/cloud-gaming`), `SCRATCH_DIR`
     (по умолчанию `/home/brofrong/cloud-gaming-scratch`), `STEAM_CLIENT_DIR` (по умолчанию
     `/home/brofrong/cloud-gaming-steam/client`), `STEAM_CLIENT_PARENT` (по умолчанию
     `/home/brofrong/cloud-gaming-steam` — менять вместе со `STEAM_CLIENT_DIR`, см. выше), `ROLES`,
     `S3_BUCKET` — без кавычек.

   Каждый сервис получает только перечисленные для него в `deploy/compose.yaml` переменные (не весь
   `.env`): `POSTGRES_PASSWORD` видит лишь `cg-postgres`, `AGENT_TOKEN` — оркестратор и агент,
   `RUSTFS_*` — `cg-rustfs`, агент и одноразовый `cg-rustfs-bucket`, `PROFILE_KEY` — только агент.
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
3. **Google** (Google Cloud Console): OAuth-клиент «Web application», redirect-адрес
   **`https://game.brofrong.ru/api/auth/callback/google`** → `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
4. **Яндекс** (oauth.yandex.ru): приложение с правами «доступ к адресу электронной почты, имени,
   аватару», redirect-адрес **`https://game.brofrong.ru/api/auth/callback/yandex`** →
   `YANDEX_CLIENT_ID`/`YANDEX_CLIENT_SECRET`.
5. **Telegram** (BotFather → бот → «Login Widget»): Telegram теперь обычный OIDC-провайдер. В
   списке разрешённых адресов (Allowed URLs) должен быть redirect
   **`https://game.brofrong.ru/api/auth/callback/telegram`**; там же BotFather показывает Client ID и
   Client Secret → `TELEGRAM_CLIENT_ID`/`TELEGRAM_CLIENT_SECRET`. Бот-токен серверу не нужен.

   Ключи из пунктов 3–5 дописать в `.env.production` (шаг 1) и скопировать на сервер тем же `scp`;
   провайдер без ключей просто не появится на `/login`, так что эти пункты можно делать по одному,
   в любом порядке, и после первого деплоя.

## Шаг 3 (один раз, перед первым деплоем этой работы): чистка старых Steam-пользователей

Сейчас в проде есть пользователи, созданные Steam-входом: синтетическая почта `steam_<id>@…`,
единственная привязка — Steam. Перенос таких записей не делается (их не жалко — см.
`docs/superpowers/specs/2026-10-22-auth-login-and-linking-design.md`, §3.5); перед первым деплоем
этой работы их нужно один раз удалить вручную, иначе привязка Steam к новому аккаунту не пройдёт
(плагин ответит «Steam уже привязан к другому аккаунту»). Удаление `user` каскадом уносит его
`account`, `session`, `sessions`, `user_games` и остальные таблицы с `user_id`, кроме `play_segments`
(у неё `NO ACTION`) — её строки удаляются первыми в той же транзакции. Выполнено 2026-10-23.

```sh
ssh brofrong "cd ~/cloud-gaming && docker compose -f deploy/compose.yaml --env-file .env exec cg-postgres psql -U cg -d cloud_gaming -v ON_ERROR_STOP=1 -c \"BEGIN; DELETE FROM play_segments WHERE user_id IN (SELECT id FROM \\\"user\\\" WHERE email LIKE 'steam\_%@%' AND id NOT IN (SELECT user_id FROM account WHERE provider_id <> 'steam')); DELETE FROM \\\"user\\\" WHERE email LIKE 'steam\_%@%' AND id NOT IN (SELECT user_id FROM account WHERE provider_id <> 'steam'); COMMIT;\""
```

(`~/cloud-gaming` и контейнер `cg-postgres` на сервере уже есть — это чистка перед деплоем
**новой версии входа**, а не перед первым деплоем вообще.) Если такой пользователь всё же
останется, привязка его Steam даст ту же штатную ошибку плагина — данные никуда не переезжают,
просто придётся почистить руками позже.

## Шаг 4: деплой

> **Внимание: GPU-слот начинает принимать настоящие сессии, как только `cg-agent` подключится к
> оркестратору** (через несколько секунд после `up`). На brofrong одна GPU и один слот (UDP
> `59000`). Если GPU или UDP `59000` в этот момент заняты (спайк `cg-spike` или что-то ещё),
> первая же нажатая «Играть» упадёт с «Не удалось запустить игровой сервер» (`failed to bind host
port 0.0.0.0:59000/udp: address already in use`). Поэтому спайк останавливать **до деплоя**, а не
> только на время приёмки:
>
> ```sh
> ssh brofrong 'cd ~/cg-spike && docker compose stop'      # до ./deploy/deploy.sh
> ssh brofrong 'ss -lun | grep ":59000 " || echo free'      # UDP 59000 свободен
> ```
>
> Вернуть спайк — только когда сессий нет (`docker ps --filter label=cg.session` пуст) и они не
> ожидаются, потому что спайк снова займёт GPU и `59000`:
> `ssh brofrong 'cd ~/cg-spike && docker compose start'`.

```sh
./deploy/deploy.sh
```

Скрипт:

1. Отказывается деплоить (exit 1, печатает имена), если на сервере есть созданный или запущенный
   контейнер с меткой `cg.session`, `cg.install` или `cg.template` (сборка клиента Steam).
   Остановленные (`exited`, например `profile-unsaved`) не мешают.
2. `rsync` репозитория в `brofrong:~/cloud-gaming` (без `node_modules`, `.git`, `spike/nv`,
   `images/session/nv`, `.superpowers`, `docs`, `.env*` кроме `.env.example`).
3. Проверяет, что `~/cloud-gaming/.env` существует на сервере (падает с понятной ошибкой, если нет
   — см. шаг 1).
4. Для каждого из `AGENT_TOKEN`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `PROFILE_KEY`: если в
   серверном `.env` нет такого ключа — дописывает строку из локального `.env.production` (значение
   проверяется локально и идёт через stdin ssh, на экран не выводится).
5. Каталоги хоста `CG_DATA_DIR/{library/steamapps,install-scratch}`, `SCRATCH_DIR`,
   `STEAM_CLIENT_PARENT` и `STEAM_CLIENT_DIR/steamapps` — `mkdir -p` от `brofrong`, проверка
   владельца uid 1000 (пути — из серверного `.env`, если там заданы
   `CG_DATA_DIR`/`SCRATCH_DIR`/`STEAM_CLIENT_DIR`/`STEAM_CLIENT_PARENT`, иначе по умолчанию). Если
   шаблон клиента Steam не собран — предупреждение (см. «Клиент Steam: пересборка шаблона»).
6. Создаёт сеть `cg-sessions`, если её нет.
7. Бакет профилей: `docker compose … run --rm cg-rustfs-bucket` — поднимает `cg-rustfs` (ждёт
   healthy) и пиннутым `amazon/aws-cli:2.38.4` в сети `cg` создаёт `S3_BUCKET`, если его нет
   (`head-bucket` → `create-bucket`; ключи — через окружение контейнера).
8. `ssh brofrong 'cd ~/cloud-gaming && DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose -f deploy/compose.yaml --env-file .env up -d --build'`.

Повторный запуск безопасен: пересобирает образ и перезапускает только сервисы `cg-*` этого
compose-проекта; другие контейнеры на сервере не трогает. При живых сессиях и установках скрипт не
запускается вовсе: пересоздание `cg-api` рвёт стримы, а `cg-agent` прерывает установки (они не
продолжаются после перезапуска агента).

Ручные команды compose на сервере — с теми же флагами, например:
`cd ~/cloud-gaming && docker compose -f deploy/compose.yaml --env-file .env logs -f cg-orchestrator`.

## Проверка после деплоя

```sh
curl -s https://game.brofrong.ru/healthz                       # ok
ssh brofrong 'docker ps --filter name=cg- --format "{{.Names}} {{.Status}}"'
  # cg-api, cg-postgres, cg-orchestrator, cg-rustfs — (healthy); cg-agent — Up
ssh brofrong 'docker logs cg-agent 2>&1 | head -20'              # нет ошибок конфига (ROLES, каталоги, S3_*)
ssh brofrong 'docker logs cg-orchestrator 2>&1 | grep "Agent connected"'   # workerId=brofrong
ssh brofrong 'docker exec cg-postgres psql -U cg -d cloud_gaming -c "select id, public_ip, slots, last_seen_at from workers"'  # строка brofrong
ssh brofrong 'docker ps --format "{{.Names}}" | sort'           # сравнить с «до» — число и состав
                                                                  # остальных контейнеров не изменились
curl -s https://game.brofrong.ru/ | head -c 200                 # отдаёт SPA (index.html)
curl -s -X POST https://game.brofrong.ru/api/auth/steam/login \
  -H 'Content-Type: application/json' -d '{"callbackURL":"/app"}'   # {"url":"https://steamcommunity.com/..."}
```

Реальный вход через Steam/Pocket ID не проверяется деплоем — это делает владелец сервера (шаг 5,
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
ssh brofrong 'cd ~/cloud-gaming && docker compose -f deploy/compose.yaml --env-file .env run --rm --no-deps --entrypoint aws cg-rustfs-bucket s3 ls --recursive s3://cg-profiles/'
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
- Через 60 мин агент сдаётся: в логе `session-container-stuck` (`sessionId`, `container`, `mode`),
  сессия уходит из heartbeat, и слот освобождается, хотя контейнер всё ещё есть. Дальше решает
  человек.

```sh
ssh brofrong 'docker logs cg-agent 2>&1 | grep -E "Session container cleanup failed|session-container-stuck"'
ssh brofrong 'docker ps -a --filter label=cg.session --format "{{.Names}} {{.Status}}"; ls /home/brofrong/cloud-gaming-scratch/*/profile-saved'
```

После `session-container-stuck`:

1. Найти процесс в D: `ssh brofrong "ps -eo pid,stat,wchan:32,cmd | awk '\$2 ~ /D/'"`.
2. Дождаться его выхода (в D процесс не убить даже `kill -9`).
3. `ssh brofrong 'docker restart cg-agent'`. Метка `profile-saved` есть — агент удалит контейнер
   со слоями. Метки нет (профиль не сохранён) — порядок из «Профиль не сохранён».

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
сессия или установка), шаблон не переносится (`deferred`) — повторится при следующем поводе.

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

## Смена образа сессии: перетег и откат

Агент берёт образ сессии по `SESSION_IMAGE` (по умолчанию `cg-session:550.163.01`). Новый образ
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

## Шаг 5 (приёмка, делает владелец)

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
  Selkies — WebSocket через ingressi и `cg-api`); в консоли браузера нет ошибок WebSocket про
  subprotocol (`Sec-WebSocket-Protocol`) и циклических переподключений.

MVP-3 (магазин игр и профили). До деплоя: `./deploy/build-session-image.sh`,
`./deploy/build-steam-client.sh`, затем `./deploy/deploy.sh`; сессий в начале нет.

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
