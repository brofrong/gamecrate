CREATE TABLE "play_segments" (
	"id" serial PRIMARY KEY,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"app_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"billable" boolean NOT NULL,
	"open" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"app_id" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"slot" integer,
	"stream_url" text,
	"fail_reason" text,
	"client_seen_at" timestamp with time zone,
	"last_input_at" timestamp with time zone,
	"agent_seen_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY,
	"public_ip" text NOT NULL,
	"slots" integer NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "play_segments_open_session_idx" ON "play_segments" ("session_id") WHERE "open" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_user_idx" ON "sessions" ("user_id") WHERE "state" not in ('ended', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_worker_slot_idx" ON "sessions" ("worker_id","slot") WHERE "state" not in ('ended', 'failed');--> statement-breakpoint
ALTER TABLE "play_segments" ADD CONSTRAINT "play_segments_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "play_segments" ADD CONSTRAINT "play_segments_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "play_segments" ADD CONSTRAINT "play_segments_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id");