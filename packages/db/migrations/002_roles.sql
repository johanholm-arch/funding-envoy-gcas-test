-- Application roles. fe_app is what the API connects as: not a superuser, no BYPASSRLS, so every
-- tenant table is filtered by row-level security.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fe_app') then
    create role fe_app login password 'fe_app_dev' nosuperuser nobypassrls;
  end if;
end $$;
grant usage on schema public to fe_app;
grant select, insert, update, delete on all tables in schema public to fe_app;
grant usage, select on all sequences in schema public to fe_app;
grant execute on all functions in schema public to fe_app;
alter default privileges in schema public grant select, insert, update, delete on tables to fe_app;
