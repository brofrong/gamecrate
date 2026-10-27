-- Custom SQL migration file, put your code below! --
-- `stage` (этап запуска до появления игрового окна, экран загрузки) — тоже
-- значимое изменение сессии, как state/stream_url/fail_reason и т.п.
-- (20261017141200_sessions_notify_changes): пересоздаём update-триггер с тем
-- же WHEN плюс стадия.
DROP TRIGGER IF EXISTS session_changed_update_trigger ON "sessions";
--> statement-breakpoint
CREATE TRIGGER session_changed_update_trigger
AFTER UPDATE ON "sessions"
FOR EACH ROW
WHEN (
  OLD.state IS DISTINCT FROM NEW.state
  OR OLD.state_since IS DISTINCT FROM NEW.state_since
  OR OLD.stream_url IS DISTINCT FROM NEW.stream_url
  OR OLD.fail_reason IS DISTINCT FROM NEW.fail_reason
  OR OLD.stop_requested_at IS DISTINCT FROM NEW.stop_requested_at
  OR OLD.worker_id IS DISTINCT FROM NEW.worker_id
  OR OLD.slot IS DISTINCT FROM NEW.slot
  OR OLD.ended_at IS DISTINCT FROM NEW.ended_at
  OR OLD.stage IS DISTINCT FROM NEW.stage
)
EXECUTE FUNCTION session_changed_notify();
