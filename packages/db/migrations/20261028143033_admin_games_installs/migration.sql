ALTER TABLE "gamestore_apps" ADD COLUMN "deleting_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "install_jobs" ADD COLUMN "cancel_requested_at" timestamp with time zone;