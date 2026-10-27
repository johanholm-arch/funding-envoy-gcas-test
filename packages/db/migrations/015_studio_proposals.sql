-- What FundingEnvoy proposed the last time it read a funder's policy and SOP, with the source of every proposal,
-- so the guided setup can show where each suggestion came from.
create table studio_proposals (
  tenant_id   uuid primary key references tenants(id),
  body        jsonb not null,
  documents   jsonb not null default '{}',
  provider    text not null,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
alter table studio_proposals enable row level security;
alter table studio_proposals force row level security;
create policy tenant_isolation on studio_proposals using (tenant_id = (select current_tenant()) or (select is_operator())) with check (tenant_id = (select current_tenant()) or (select is_operator()));
grant select, insert, update, delete on studio_proposals to fe_app;

-- The demo reset also clears proposals.
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
  delete from studio_proposals where tenant_id = p_tenant;
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
