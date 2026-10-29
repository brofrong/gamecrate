CREATE TABLE "steam_login_seeds" (
	"user_id" text PRIMARY KEY,
	"steam_id" text NOT NULL,
	"sealed" text NOT NULL,
	"put_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "steam_login_seeds" ADD CONSTRAINT "steam_login_seeds_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;