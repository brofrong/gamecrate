ALTER TABLE "workers" ADD COLUMN "roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "draining" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "hardware" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "versions" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "stats_at" timestamp with time zone;