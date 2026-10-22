-- Custom SQL migration file, put your code below! --
-- Прогресс установки (bytesDownloaded/bytesTotal) и смена state install_jobs
-- должны долетать до сессий, которые её ждут в состоянии `installing` (их
-- может быть несколько — вторая сессия на тот же appId присоединяется к уже
-- идущей задаче, Task 5). sessions.id — полезная нагрузка session_changed,
-- которую читает тот же LISTEN, что и триггер sessions.
CREATE OR REPLACE FUNCTION install_job_changed_notify() RETURNS trigger AS $$
DECLARE
  s RECORD;
BEGIN
  FOR s IN
    SELECT id FROM "sessions"
    WHERE install_job_id = NEW.id AND state = 'installing'
  LOOP
    PERFORM pg_notify('session_changed', s.id);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER install_jobs_changed_trigger
AFTER UPDATE ON "install_jobs"
FOR EACH ROW
EXECUTE FUNCTION install_job_changed_notify();
