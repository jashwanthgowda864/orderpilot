-- 002: Remove Supabase Data API access to OrderPilot tables.
-- The browser never talks to the database; only the server (table owner) does.
-- RLS (enabled in 001, no policies) already blocks row access; this removes the
-- table privileges too, so access stays closed even if a policy is added by mistake.
-- Safe on plain Postgres: does nothing when the Supabase roles do not exist.

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      -- Tables created later by this owner are not exposed either.
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
