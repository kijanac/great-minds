CREATE FUNCTION notify_progress_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wake_key text;
BEGIN
  IF TG_TABLE_NAME = 'vault_memberships' THEN
    wake_key := OLD.vault_id::text || ':' || OLD.user_id::text;
  ELSIF TG_OP = 'DELETE' THEN
    wake_key := OLD.id::text;
  ELSE
    wake_key := NEW.id::text;
  END IF;
  PERFORM pg_notify('great_minds_progress', TG_TABLE_NAME || ':' || wake_key);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER pipeline_runs_progress_changed
AFTER UPDATE OF status, current_phase, phase_status, stages, warnings, outcome, error, updated_at, completed_at OR DELETE ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION notify_progress_change();--> statement-breakpoint
CREATE TRIGGER replies_progress_changed
AFTER UPDATE OF version OR DELETE ON replies
FOR EACH ROW EXECUTE FUNCTION notify_progress_change();--> statement-breakpoint
CREATE TRIGGER vault_memberships_progress_removed
AFTER DELETE ON vault_memberships
FOR EACH ROW EXECUTE FUNCTION notify_progress_change();--> statement-breakpoint
CREATE TRIGGER vaults_progress_deleted
AFTER UPDATE OF deleted_at ON vaults
FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION notify_progress_change();
