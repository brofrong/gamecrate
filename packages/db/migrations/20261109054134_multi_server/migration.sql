CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_credentials" (
	"worker_id" text PRIMARY KEY,
	"token_hash" text UNIQUE,
	"enroll_code_hash" text UNIQUE,
	"enroll_expires_at" timestamp with time zone,
	"token_issued_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "region_id" uuid;--> statement-breakpoint
-- Библиотека становится своей у каждого сервера (спека §5): колонка сначала
-- nullable, бэкфилл назначает существующие строки одному воркеру с ролью
-- `gamestore` (на старых установках он один — brofrong), а строки, которым
-- назначить некого (воркера с этой ролью нет вовсе), не переживают переход —
-- общей ФС между серверами больше не будет, и такая строка больше не значит
-- «игра стоит» ни на одном конкретном сервере.
ALTER TABLE "gamestore_apps" ADD COLUMN "worker_id" text;--> statement-breakpoint
update gamestore_apps set worker_id = (select id from workers where 'gamestore' = any(roles) order by id limit 1);--> statement-breakpoint
delete from gamestore_apps where worker_id is null;--> statement-breakpoint
ALTER TABLE "gamestore_apps" ALTER COLUMN "worker_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "gamestore_apps" DROP CONSTRAINT "gamestore_apps_pkey";--> statement-breakpoint
ALTER TABLE "gamestore_apps" ADD CONSTRAINT "gamestore_apps_pkey" PRIMARY KEY("worker_id","app_id");--> statement-breakpoint
-- Та же логика для активных (queued) задач установки без воркера — иначе
-- частичный уникальный индекс ниже даст `null` в обеих строках старого
-- бэкфилла и перестанет видеть их как дубль.
update install_jobs set worker_id = (select id from workers where 'gamestore' = any(roles) order by id limit 1) where state = 'queued' and worker_id is null;--> statement-breakpoint
DROP INDEX "install_jobs_active_app_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "install_jobs_active_worker_app_idx" ON "install_jobs" ("worker_id","app_id") WHERE "state" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "gamestore_apps" ADD CONSTRAINT "gamestore_apps_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id");--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_region_id_regions_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT;
