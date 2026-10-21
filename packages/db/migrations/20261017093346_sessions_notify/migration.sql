-- Custom SQL migration file, put your code below! --
-- Уведомляет слушателей канала `session_changed` о вставке/обновлении строки sessions.
-- Полезная нагрузка — id сессии (text/uuid); её читает orchestrator через LISTEN.
CREATE OR REPLACE FUNCTION session_changed_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('session_changed', NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER session_changed_trigger
AFTER INSERT OR UPDATE ON "sessions"
FOR EACH ROW
EXECUTE FUNCTION session_changed_notify();
