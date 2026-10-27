-- Identity: single sign-on per tenant (OIDC), SCIM v2 provisioning, and groups that map to roles.

create table identity_providers (
  tenant_id      uuid primary key references tenants(id),
  protocol       text not null default 'oidc' check (protocol in ('oidc')),
  issuer         text not null,
  client_id      text not null,
  client_secret_ref text,                         -- name of the secret in the vault/env, never the secret itself
  email_domains  text[] not null default '{}',     -- home-realm discovery: who is sent to this provider
  groups_claim   text not null default 'groups',
  role_mapping   jsonb not null default '{}',      -- { "<IdP group>": ["coordinator", ...] }
  jit            boolean not null default false,   -- create people on first sign-in (otherwise SCIM must have created them)
  enforced       boolean not null default false,   -- internal people of this tenant may not use any other sign-in
  updated_at     timestamptz not null default now()
);

create table sso_states (
  state          text primary key,
  tenant_id      uuid not null references tenants(id),
  nonce          text not null,
  code_verifier  text not null,
  return_to      text not null default '/',
  expires_at     timestamptz not null
);

create table scim_tokens (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  token_hash     text not null unique,
  label          text not null,
  created_by     text not null,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);

create table scim_groups (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  display_name   text not null,
  external_id    text,
  members        uuid[] not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, display_name)
);

alter table users add column if not exists source text not null default 'manual' check (source in ('manual', 'scim', 'sso-jit', 'seed'));
alter table users add column if not exists last_sign_in_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['identity_providers','sso_states','scim_tokens','scim_groups'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = current_tenant() or is_operator()) with check (tenant_id = current_tenant() or is_operator())$p$, t);
  end loop;
end $$;

-- Internal users can be created and changed inside their own tenant (the users policy only covered reading).
create policy users_tenant_write on users for insert with check (is_operator() or (kind = 'internal' and tenant_id = current_tenant()));
create policy users_tenant_update on users for update using (is_operator() or (kind = 'internal' and tenant_id = current_tenant())) with check (is_operator() or (kind = 'internal' and tenant_id = current_tenant()));

-- A SCIM request arrives with only a bearer token; this narrow function resolves it to a tenant.
create or replace function auth_scim_token(p_hash text)
returns table (tenant_id uuid, token_id uuid)
language sql security definer set search_path = public as
$$ update scim_tokens set last_used_at = now() where token_hash = p_hash and revoked_at is null returning tenant_id, id $$;

-- Home-realm discovery before any tenant is in scope.
create or replace function auth_idp_for_domain(p_domain text)
returns table (tenant_id uuid, slug text, issuer text, client_id text)
language sql security definer set search_path = public as
$$ select i.tenant_id, t.slug, i.issuer, i.client_id from identity_providers i join tenants t on t.id = i.tenant_id where lower(p_domain) = any(i.email_domains) $$;

grant select, insert, update, delete on identity_providers, sso_states, scim_tokens, scim_groups to fe_app;
grant execute on function auth_scim_token(text), auth_idp_for_domain(text) to fe_app;

-- The demo reset also clears identity data.
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
  delete from sso_states where tenant_id = p_tenant;
  delete from scim_tokens where tenant_id = p_tenant;
  delete from scim_groups where tenant_id = p_tenant;
  delete from identity_providers where tenant_id = p_tenant;
  delete from sessions where tenant_id = p_tenant or user_id in (select id from users where tenant_id = p_tenant);
  delete from users where tenant_id = p_tenant;
  delete from org_shares where tenant_id = p_tenant;
end $$;
