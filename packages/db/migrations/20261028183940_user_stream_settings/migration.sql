CREATE TABLE "user_stream_settings" (
	"user_id" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_stream_settings" ADD CONSTRAINT "user_stream_settings_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;