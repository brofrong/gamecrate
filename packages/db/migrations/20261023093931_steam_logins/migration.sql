CREATE TABLE "steam_logins" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"qr_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "steam_logins_active_user_idx" ON "steam_logins" ("user_id") WHERE "state" in ('pending', 'waiting', 'scanned');--> statement-breakpoint
ALTER TABLE "steam_logins" ADD CONSTRAINT "steam_logins_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;