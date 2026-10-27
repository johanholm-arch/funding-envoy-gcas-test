-- Request references come from a per-tenant counter, taken under a row lock, so concurrent submissions never
-- collide and numbers never repeat when drafts become submissions.
create table ref_counters (
  tenant_id  uuid not null references tenants(id),
  scope      text not null,          -- 'draft' or the year of final references
  n          bigint not null,
  primary key (tenant_id, scope)
);
alter table ref_counters enable row level security;
alter table ref_counters force row level security;
create policy tenant_isolation on ref_counters using (tenant_id = current_tenant() or is_operator()) with check (tenant_id = current_tenant() or is_operator());
grant select, insert, update, delete on ref_counters to fe_app;

-- The demo reset also clears the counters.
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
  delete from ref_counters where tenant_id = p_tenant;
  delete from outbox where tenant_id = p_tenant;
  alter table config_versions disable trigger config_versions_nodelete;
  delete from config_versions where tenant_id = p_tenant;
  alter table config_versions enable trigger config_versions_nodelete;
  delete from sso_states where tenant_id = p_tenant;
  delete from scim_tokens where tenant_id = p_tenant;
  delete from scim_groups where tenant_id = p_tenant;
  delete from identity_providers where tenant_id = p_tenant;
  delete from sessions where tenant_id = p_tenant or user_id in (select id from users where tenant_id = p_tenant);
  delete from users where tenant_id = p_tenant;
  delete from org_shares where tenant_id = p_tenant;
end $$;
