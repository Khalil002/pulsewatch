-- Tenant isolation enforced by Postgres, not just by WHERE clauses in the backends.
--
-- Backends connect as pulsewatch_app, which is not the table owner and not a superuser, so the
-- policies below always apply. Each request runs in a transaction that first calls
--   SELECT set_config('app.org_id', '<org uuid>', true)
-- and can then only see and write that org's rows. Background jobs that work across tenants
-- (the scheduler, the alert worker, retention) opt in with set_config('app.bypass_rls', 'on', true).

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pulsewatch_app') THEN
        CREATE ROLE pulsewatch_app LOGIN PASSWORD '${appPassword}';
    ELSE
        ALTER ROLE pulsewatch_app LOGIN PASSWORD '${appPassword}';
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO pulsewatch_app;
GRANT SELECT, INSERT, UPDATE ON orgs, users TO pulsewatch_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys, monitors, check_results, incidents, alert_jobs TO pulsewatch_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pulsewatch_app;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['api_keys', 'monitors', 'check_results', 'incidents', 'alert_jobs'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            $p$CREATE POLICY tenant_isolation ON %I
                 USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on')$p$, t);
    END LOOP;
END
$$;

-- Resolving an API key happens before the org is known, so it runs as the table owner.
-- It only ever returns the key's own id and org, and stamps last_used_at.
CREATE FUNCTION api_key_lookup(p_hash text)
    RETURNS TABLE (key_id uuid, key_org_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
    UPDATE api_keys SET last_used_at = now()
     WHERE key_hash = p_hash AND revoked_at IS NULL
    RETURNING id, org_id
$$;
REVOKE ALL ON FUNCTION api_key_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_lookup(text) TO pulsewatch_app;
