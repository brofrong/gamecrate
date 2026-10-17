-- Custom SQL migration file, put your code below! --
-- `session_changed` только при значимых изменениях сессии. Раньше триггер срабатывал на
-- каждый UPDATE, в том числе на heartbeat браузера и агента (client_seen_at,
-- last_input_at, agent_seen_at) — слушатели перечитывали сессию впустую. Игровое время
-- наблюдатели и так перечитывают каждые 5 с.
-- INSERT — всегда; UPDATE — только если реально изменился один из столбцов, которые
-- видны пользователю или нужны планировщику.
DROP TRIGGER IF EXISTS session_changed_trigger ON "sessions";
--> statement-breakpoint
CREATE TRIGGER session_changed_insert_trigger
AFTER INSERT ON "sessions"
FOR EACH ROW
EXECUTE FUNCTION session_changed_notify();
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
)
EXECUTE FUNCTION session_changed_notify();
