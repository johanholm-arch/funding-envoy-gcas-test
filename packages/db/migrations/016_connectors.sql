-- Connections to a funder's existing grants platform (Salesforce first). The mapping is a signed configuration
-- version (kind 'connector'); these tables hold what the connector learns and remembers while it runs.
alter table config_versions drop constraint if exists config_versions_kind_check;
alter table config_versions add constraint config_versions_kind_check
  check (kind in ('rulebook', 'workflow', 'catalogue', 'autonomy', 'brand', 'words', 'policy', 'sop', 'metrics', 'testset', 'connector'));

-- Which FundingEnvoy record is which record on the other side, so later writes update instead of create.
create table connector_links (
  tenant_id     uuid not null references tenants(id),
  system        text not null,
  entity_type   text not null,
  entity_id     text not null,
  remote_object text not null,
  remote_id     text not null,
  remote_modstamp timestamptz,
  synced_at     timestamptz not null default now(),
  primary key (tenant_id, system, entity_type, entity_id),
  unique (tenant_id, system, remote_object, remote_id)
);

-- The last event processed on each channel (Pub/Sub replay ID), so a restart resumes where it stopped.
create table connector_cursors (
  tenant_id   uuid not null references tenants(id),
  system      text not null,
  channel     text not null,
  replay_id   bigint not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, system, channel)
);

-- What the connector read about the org's objects, picklists and rules; the mapping names the snapshot it was made on.
create table connector_snapshots (
  tenant_id   uuid not null references tenants(id),
  system      text not null,
  hash        text not null,
  body        jsonb not null,
  read_by     text not null,
  read_at     timestamptz not null default now(),
  primary key (tenant_id, system, hash)
);

-- The simulated Salesforce org used by the demo and the tests: records, and the platform events its Flow publishes.
create table sim_sf_records (
  tenant_id   uuid not null references tenants(id),
  id          text not null,
  object      text not null,
  fields      jsonb not null,
  created_by  jsonb not null,
  modified_by jsonb not null,
  created_at  timestamptz not null default now(),
  modified_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index sim_sf_records_object on sim_sf_records (tenant_id, object, modified_at desc);

create table sim_sf_events (
  tenant_id   uuid not null references tenants(id),
  replay_id   bigserial,
  channel     text not null,
  event_uuid  uuid not null default gen_random_uuid(),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, replay_id)
);

-- API calls made to the org, per day, for the budget shown in Studio.
create table sim_sf_usage (
  tenant_id   uuid not null references tenants(id),
  day         date not null,
  calls       int not null default 0,
  primary key (tenant_id, day)
);

do $$
declare t text;
begin
  foreach t in array array['connector_links', 'connector_cursors', 'connector_snapshots', 'sim_sf_records', 'sim_sf_events', 'sim_sf_usage'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = (select current_tenant()) or (select is_operator())) with check (tenant_id = (select current_tenant()) or (select is_operator()))', t);
    execute format('grant select, insert, update, delete on %I to fe_app', t);
  end loop;
end $$;
grant usage on sequence sim_sf_events_replay_id_seq to fe_app;

-- The demo reset also clears connections and the simulated org.
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
