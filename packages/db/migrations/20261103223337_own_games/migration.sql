CREATE TABLE "own_games" (
	"app_id" integer PRIMARY KEY,
	"slug" text NOT NULL UNIQUE,
	"version" text NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "own_games_app_id_range" CHECK (app_id >= 1900000000)
);
--> statement-breakpoint
ALTER TABLE "own_games" ADD CONSTRAINT "own_games_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id");