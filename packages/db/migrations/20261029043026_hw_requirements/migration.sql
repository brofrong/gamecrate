CREATE TABLE "game_requirements" (
	"app_id" integer PRIMARY KEY,
	"min_vram_bytes" bigint NOT NULL,
	"min_ram_bytes" bigint NOT NULL,
	"min_cpu_threads" integer NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_metrics" (
	"session_id" text PRIMARY KEY,
	"app_id" integer NOT NULL,
	"worker_id" text NOT NULL,
	"gpu_name" text NOT NULL,
	"worker_class_id" uuid,
	"slots" integer NOT NULL,
	"game_seconds" integer NOT NULL,
	"peak_vram_bytes" bigint,
	"peak_ram_bytes" bigint,
	"cpu_cores_p95" real,
	"gpu_util_p95" real,
	"vram_source" text NOT NULL,
	"game_end" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL UNIQUE,
	"rank" integer NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "class_id" uuid;--> statement-breakpoint
ALTER TABLE "game_requirements" ADD CONSTRAINT "game_requirements_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id");--> statement-breakpoint
ALTER TABLE "game_requirements" ADD CONSTRAINT "game_requirements_updated_by_user_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "session_metrics" ADD CONSTRAINT "session_metrics_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_class_id_worker_classes_id_fkey" FOREIGN KEY ("class_id") REFERENCES "worker_classes"("id") ON DELETE RESTRICT;--> statement-breakpoint
insert into worker_classes (name, rank) values ('Стандарт', 1);--> statement-breakpoint
update workers set class_id = (select id from worker_classes where rank = 1);