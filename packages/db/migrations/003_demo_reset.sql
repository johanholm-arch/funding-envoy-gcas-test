-- Demo-environment reset of one tenant. The audit trail is append-only by trigger; this owner-only
-- function disables that trigger for the duration of the reset and is the only path that can remove events.
-- It must not exist in production databases: the API refuses to start in production if it is present.
create or replace function fe_demo_reset_tenant(p_tenant uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  alter table events disable trigger events_no_update;
  delete from events where tenant_id = p_tenant;
  alter table events enable trigger events_no_update;
  delete from event_heads where tenant_id = p_tenant;
  delete from chain_anchors where tenant_id = p_tenant;
  delete from transfers_of_value where tenant_id = p_tenant;
  delete from payments where tenant_id = p_tenant;
  delete from agreements where tenant_id = p_tenant;
  delete from decisions where tenant_id = p_tenant;
  delete from meetings where tenant_id = p_tenant;
  delete from reviews where tenant_id = p_tenant;
  delete from tasks where tenant_id = p_tenant;
  delete from messages where tenant_id = p_tenant;
  delete from documents where tenant_id = p_tenant or request_id in (select id from requests where tenant_id = p_tenant);
  delete from requests where tenant_id = p_tenant;
  delete from outbox where tenant_id = p_tenant;
  alter table config_versions disable trigger config_versions_nodelete;
  delete from config_versions where tenant_id = p_tenant;
  alter table config_versions enable trigger config_versions_nodelete;
  delete from sessions where user_id in (select id from users where tenant_id = p_tenant);
  delete from users where tenant_id = p_tenant;
  delete from org_shares where tenant_id = p_tenant;
end $$;
revoke all on function fe_demo_reset_tenant(uuid) from public;
grant execute on function fe_demo_reset_tenant(uuid) to fe_app;
