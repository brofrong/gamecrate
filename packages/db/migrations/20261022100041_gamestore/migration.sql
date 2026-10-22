CREATE TABLE "gamestore_apps" (
	"app_id" integer PRIMARY KEY,
	"size_bytes" bigint NOT NULL,
	"build_id" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "install_jobs" (
	"id" text PRIMARY KEY,
	"app_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"bytes_downloaded" bigint,
	"bytes_total" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY,
	"version" integer NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "install_job_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "install_jobs_active_app_idx" ON "install_jobs" ("app_id") WHERE "state" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "gamestore_apps" ADD CONSTRAINT "gamestore_apps_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id");--> statement-breakpoint
ALTER TABLE "install_jobs" ADD CONSTRAINT "install_jobs_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id");--> statement-breakpoint
ALTER TABLE "install_jobs" ADD CONSTRAINT "install_jobs_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "install_jobs" ADD CONSTRAINT "install_jobs_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_install_job_id_install_jobs_id_fkey" FOREIGN KEY ("install_job_id") REFERENCES "install_jobs"("id");