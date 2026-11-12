CREATE TABLE "hour_packs" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"minutes" integer NOT NULL,
	"price_rub" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "minute_credits" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"minutes" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "minute_credits_minutes_positive" CHECK ("minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "tariff_grants" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"tariff_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariffs" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"price_rub" integer,
	"queue_priority" integer DEFAULT 0 NOT NULL,
	"monthly_minutes" integer,
	"rollover" boolean DEFAULT false NOT NULL,
	"max_resolution" text DEFAULT '1440p' NOT NULL,
	"max_bitrate_mbps" integer DEFAULT 40 NOT NULL,
	"max_session_minutes" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "queue_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "queue_position" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "queue_total" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "queue_eta_minutes" integer;--> statement-breakpoint
CREATE INDEX "sessions_queue_idx" ON "sessions" ("state","queue_priority" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE INDEX "minute_credits_user_created_idx" ON "minute_credits" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tariff_grants_user_starts_idx" ON "tariff_grants" ("user_id","starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "tariffs_default_idx" ON "tariffs" ("is_default") WHERE "is_default";--> statement-breakpoint
ALTER TABLE "minute_credits" ADD CONSTRAINT "minute_credits_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "minute_credits" ADD CONSTRAINT "minute_credits_granted_by_user_id_fkey" FOREIGN KEY ("granted_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tariff_grants" ADD CONSTRAINT "tariff_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tariff_grants" ADD CONSTRAINT "tariff_grants_tariff_id_tariffs_id_fkey" FOREIGN KEY ("tariff_id") REFERENCES "tariffs"("id");--> statement-breakpoint
ALTER TABLE "tariff_grants" ADD CONSTRAINT "tariff_grants_granted_by_user_id_fkey" FOREIGN KEY ("granted_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Тариф по умолчанию (спека §2): на него падает пользователь без активной
-- выдачи (`tariff_grants`); безлимит минут, без переноса, 1440p/40 Мбит/с,
-- без ограничения длины сессии. Остальные колонки — умолчания таблицы.
INSERT INTO "tariffs" ("id", "name", "is_default") VALUES (gen_random_uuid()::text, 'Базовый', true);