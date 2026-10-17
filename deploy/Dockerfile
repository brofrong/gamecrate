# Образ cg-api: ставит зависимости (включая патч drizzle-orm из patches/),
# собирает SPA (apps/web/dist), затем запускает api напрямую через bun (без транспиляции).
#
# Собирается из корня репозитория: docker compose (см. compose.yaml) передаёт
# context: .. — так Dockerfile видит apps/, packages/ и patches/.
FROM oven/bun:1.4

WORKDIR /app

# Сначала только манифесты и bun.lock — отдельный слой кэша для `bun install`,
# инвалидируется лишь при изменении зависимостей, а не исходников.
COPY package.json bun.lock bunfig.toml ./
COPY patches/ ./patches/
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/rpc/package.json packages/rpc/package.json

# --frozen-lockfile: падает, если bun.lock не совпадает с манифестами.
# patches/drizzle-orm@1.0.0-rc.4.patch применяется автоматически (patchedDependencies в package.json).
RUN bun install --frozen-lockfile

# Теперь остальной код (apps/*/src, packages/*/src, тесты, конфиги).
COPY . .

# Собирает apps/web/dist (turbo run build; у apps/api сборочного шага нет —
# api запускается прямо из исходников через bun).
RUN bun run build

ENV PORT=3000 \
    WEB_DIST_DIR=/app/apps/web/dist

EXPOSE 3000

CMD ["bun", "apps/api/src/main.ts"]
