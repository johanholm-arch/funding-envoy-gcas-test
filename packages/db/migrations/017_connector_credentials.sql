-- Credentials for a funder's real Salesforce org, entered in Studio. The secret is encrypted by the application
-- (AES-256-GCM, key from the server's secret) and never sent back to a screen.
create table connector_credentials (
  tenant_id     uuid not null references tenants(id),
  system        text not null,
  my_domain     text not null,
  client_id     text not null,
  secret_enc    text not null,
  flow          text not null default 'client-credentials',
  saved_by      text not null,
  saved_at      timestamptz not null default now(),
  last_test     jsonb,
  primary key (tenant_id, system)
);
alter table connector_credentials enable row level security;
alter table connector_credentials force row level security;
create policy tenant_isolation on connector_credentials using (tenant_id = (select current_tenant()) or (select is_operator())) with check (tenant_id = (select current_tenant()) or (select is_operator()));
grant select, insert, update, delete on connector_credentials to fe_app;

-- The demo reset also clears saved Salesforce credentials.
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
  delete from connector_credentials where tenant_id = p_tenant;
  delete from connector_links where tenant_id = p_tenant;
  delete from connector_cursors where tenant_id = p_tenant;
  delete from connector_snapshots where tenant_id = p_tenant;
  delete from sim_sf_records where tenant_id = p_tenant;
  delete from sim_sf_events where tenant_id = p_tenant;
  delete from sim_sf_usage where tenant_id = p_tenant;
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
