CREATE TABLE "game_achievements" (
	"app_id" integer,
	"api_name" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"icon_gray" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "game_achievements_pkey" PRIMARY KEY("app_id","api_name")
);
--> statement-breakpoint
CREATE TABLE "game_details" (
	"app_id" integer PRIMARY KEY,
	"fetched_at" timestamp with time zone NOT NULL,
	"found" boolean NOT NULL,
	"short_description" text,
	"about_the_game" text,
	"developers" text[],
	"publishers" text[],
	"genres" text[],
	"release_date" text,
	"metacritic_score" integer,
	"metacritic_url" text,
	"controller_support" text,
	"linux" boolean DEFAULT false NOT NULL,
	"achievements_total" integer DEFAULT 0 NOT NULL,
	"screenshots" jsonb,
	"movies" jsonb,
	"achievements_fetched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "game_achievements" ADD CONSTRAINT "game_achievements_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "game_details" ADD CONSTRAINT "game_details_app_id_games_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "games"("app_id") ON DELETE CASCADE;