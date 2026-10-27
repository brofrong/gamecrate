DROP INDEX "sessions_active_worker_slot_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_held_worker_slot_idx" ON "sessions" ("worker_id","slot") WHERE "slot_released_at" is null;