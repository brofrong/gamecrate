# Образ приложения (cg-app:<тег> в реестре проекта): ставит зависимости (включая патчи drizzle-orm и
# better-auth-steam из patches/), собирает SPA (apps/web/dist). Все сервисы запускаются напрямую
# через bun из исходников (без транспиляции): по умолчанию api, а cg-orchestrator и cg-agent в
# compose.main.yaml/compose.worker.yaml переопределяют `command` (apps/orchestrator/src/main.ts,
# apps/agent/src/main.ts). Копия репозитория в образе нужна и оркестратору: он отдаёт из неё
# deploy/worker/install.sh и другие файлы установки игрового сервера (GET /agent/install.sh).
#
# Собирается из корня репозитория (CI, .gitlab-ci.yml: docker build -f deploy/Dockerfile .) —
# так Dockerfile видит apps/, packages/ и patches/.
FROM oven/bun:1.4

WORKDIR /app

# Сначала только манифесты и bun.lock — отдельный слой кэша для `bun install`,
# инвалидируется лишь при изменении зависимостей, а не исходников.
COPY package.json bun.lock bunfig.toml ./
COPY patches/ ./patches/
COPY apps/agent/package.json apps/agent/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/brands/package.json packages/brands/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/rpc/package.json packages/rpc/package.json

# --frozen-lockfile: падает, если bun.lock не совпадает с манифестами.
# patches/*.patch (drizzle-orm, better-auth-steam) применяются автоматически (patchedDependencies в package.json).
RUN bun install --frozen-lockfile

# Теперь остальной код (apps/*/src, packages/*/src, тесты, конфиги).
COPY . .

# Собирает apps/web/dist (turbo run build; у api, оркестратора и агента сборочного шага нет —
# они запускаются прямо из исходников через bun).
RUN bun run build

# CG_COMMIT и CG_VERSION зашивает CI (.gitlab-ci.yml, джоба build-app) на сборке по тегу:
# --build-arg CG_COMMIT=$CI_COMMIT_SHORT_SHA --build-arg CG_VERSION=$CI_COMMIT_TAG. Как ENV они
# становятся умолчанием для cg-api/cg-orchestrator/cg-agent (apps/*/src/config.ts), которое видно
# в блоке «Версии» админки без переменных окружения в compose; локальная сборка без --build-arg
# даёт те же значения, что и раньше ("unknown"/"dev").
ARG CG_COMMIT=unknown
ARG CG_VERSION=dev

ENV PORT=3000 \
    WEB_DIST_DIR=/app/apps/web/dist \
    CG_COMMIT=${CG_COMMIT} \
    CG_VERSION=${CG_VERSION}

EXPOSE 3000

CMD ["bun", "apps/api/src/main.ts"]
