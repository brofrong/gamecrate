CREATE TABLE "install_stage_marks" (
	"job_id" text,
	"stage" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "install_stage_marks_pkey" PRIMARY KEY("job_id","stage")
);
--> statement-breakpoint
CREATE TABLE "session_stage_marks" (
	"session_id" text,
	"stage" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_stage_marks_pkey" PRIMARY KEY("session_id","stage")
);
--> statement-breakpoint
CREATE INDEX "install_stage_marks_stage_at_idx" ON "install_stage_marks" ("stage","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "session_stage_marks_stage_at_idx" ON "session_stage_marks" ("stage","at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "install_stage_marks" ADD CONSTRAINT "install_stage_marks_job_id_install_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "install_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_stage_marks" ADD CONSTRAINT "session_stage_marks_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE;