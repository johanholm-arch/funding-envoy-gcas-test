-- FundingEnvoy schema v1
-- Tenant isolation: every tenant table has tenant_id; RLS is FORCED so even the table owner is filtered.
-- gen_random_uuid() is built in from Postgres 13; no extension is needed (managed services restrict extensions).
-- Session context (set per transaction by the API with SET LOCAL):
--   app.tenant_id  uuid of the tenant in scope
--   app.org_id     uuid of the requesting organization (requestor sessions only)
--   app.operator   'on' for managed-service operator sessions (cross-tenant read/write, every switch is logged)


create or replace function current_tenant() returns uuid language sql stable as
$$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create or replace function current_org() returns uuid language sql stable as
$$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
create or replace function is_operator() returns boolean language sql stable as
$$ select coalesce(current_setting('app.operator', true), '') = 'on' $$;

-- ─── Tenants and people ─────────────────────────────────────────────────────

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  region      text not null default 'us-east',
  residency   text not null default 'US',
  settings    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  legal_name  text not null,
  type        text not null,
  country     char(2) not null,
  identifiers jsonb not null default '{}',
  data        jsonb not null default '{}',   -- full Organization document (passport)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index organizations_identifiers on organizations using gin (identifiers);
create index organizations_name on organizations (lower(legal_name));

-- Passport sharing: an organization chooses which tenants may see its passport.
create table org_shares (
  org_id      uuid not null references organizations(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  scope       text[] not null default '{profile,documents,screening}',
  granted_by  uuid,
  granted_at  timestamptz not null default now(),
  primary key (org_id, tenant_id)
);

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  name        text not null,
  title       text,
  kind        text not null check (kind in ('internal', 'requestor', 'operator')),
  tenant_id   uuid references tenants(id),
  org_id      uuid references organizations(id),
  roles       text[] not null default '{}',
  attributes  jsonb not null default '{}',   -- therapeutic areas, countries, amount bands, groups
  active      boolean not null default true,
  external_id text,                          -- SCIM externalId / IdP subject
  created_at  timestamptz not null default now(),
  check ((kind = 'internal' and tenant_id is not null) or (kind = 'requestor' and org_id is not null) or kind = 'operator')
);

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  tenant_id   uuid references tenants(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  mfa_at      timestamptz,
  data        jsonb not null default '{}'
);

create table magic_links (
  token_hash  text primary key,
  email       text not null,
  tenant_id   uuid references tenants(id),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- Outbound email in the demo environment (nothing is sent; links are shown in the UI).
create table outbox (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants(id),
  to_email    text not null,
  subject     text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

-- ─── Configuration (versioned, signed, immutable once published) ────────────

create table packs (
  id          text not null,
  version     int  not null,
  body        jsonb not null,
  verification text not null,
  loaded_at   timestamptz not null default now(),
  primary key (id, version)
);

create table config_versions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  kind        text not null check (kind in ('rulebook', 'workflow', 'catalogue', 'autonomy', 'brand', 'words', 'policy', 'sop', 'metrics')),
  version     int  not null,
  status      text not null check (status in ('draft', 'published', 'retired')),
  body        jsonb not null,
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  signed_by   uuid,
  signed_name text,
  signed_at   timestamptz,
  unique (tenant_id, kind, version)
);
create unique index config_one_published on config_versions (tenant_id, kind) where status = 'published';

create or replace function config_versions_immutable() returns trigger language plpgsql as $$
begin
  if old.status = 'published' then
    if new.body is distinct from old.body or new.version <> old.version or new.kind <> old.kind or new.signed_at is distinct from old.signed_at then
      raise exception 'Published configuration v% (%) is immutable; create a new version', old.version, old.kind;
    end if;
    if new.status not in ('published', 'retired') then
      raise exception 'A published version can only be retired';
    end if;
  end if;
  if old.status = 'retired' and new is distinct from old then
    raise exception 'Retired configuration is immutable';
  end if;
  return new;
end $$;
create trigger config_versions_immutable before update on config_versions
  for each row execute function config_versions_immutable();
create or replace function config_versions_nodelete() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then raise exception 'Only drafts can be deleted'; end if;
  return old;
end $$;
create trigger config_versions_nodelete before delete on config_versions
  for each row execute function config_versions_nodelete();

-- ─── Requests and their records ─────────────────────────────────────────────

create table requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  ref          text not null,
  org_id       uuid not null references organizations(id),
  requestor_id uuid not null references users(id),
  family       text,
  subtype      text,
  country      char(2) not null,
  status       text not null,
  stage        text not null,
  stage_entered_at timestamptz not null default now(),
  title        text,
  amount       numeric(14, 2),
  currency     char(3),
  state        jsonb not null,             -- RequestState projection
  versions     jsonb not null,             -- pinned config versions
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  submitted_at timestamptz,
  decided_at   timestamptz,
  closed_at    timestamptz,
  unique (tenant_id, ref)
);
create index requests_tenant_stage on requests (tenant_id, stage, updated_at desc);
create index requests_tenant_org on requests (tenant_id, org_id);
create index requests_tenant_status on requests (tenant_id, status);

create table documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id),     -- null = passport document owned by the organization
  org_id       uuid not null references organizations(id),
  request_id   uuid references requests(id),
  type         text not null,
  name         text not null,
  mime         text not null,
  size         int  not null,
  sha256       text not null,
  storage_key  text not null,
  page_count   int,
  pages_text   jsonb,                         -- extracted text per page
  dated        date,
  classified_by text,
  uploaded_by  uuid,
  created_at   timestamptz not null default now()
);
create index documents_request on documents (request_id);
create index documents_org on documents (org_id);

create table messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  request_id  uuid not null references requests(id),
  author      jsonb not null,                -- Actor
  channel     text not null default 'requestor' check (channel in ('requestor', 'internal')),
  body        text not null,
  data        jsonb not null default '{}',   -- options, cards, proposals, citations
  created_at  timestamptz not null default now()
);
create index messages_request on messages (request_id, created_at);

create table tasks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  request_id    uuid references requests(id),
  kind          text not null,
  title         text not null,
  assignee_role text,
  assignee_id   uuid references users(id),
  due_at        timestamptz,
  status        text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  data          jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index tasks_open on tasks (tenant_id, status, assignee_role);

create table reviews (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  request_id  uuid not null references requests(id),
  stage       text not null,
  reviewer_id uuid not null references users(id),
  outcome     text not null,
  reason      text,
  form        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table meetings (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  body        text not null default 'committee',
  meets_on    date not null,
  status      text not null default 'scheduled' check (status in ('scheduled', 'held', 'cancelled')),
  members     uuid[] not null default '{}',
  minutes     text,
  created_at  timestamptz not null default now()
);

create table decisions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  request_id  uuid not null references requests(id),
  meeting_id  uuid references meetings(id),
  outcome     text not null check (outcome in ('approve', 'approve-with-conditions', 'decline', 'defer')),
  amount      numeric(14, 2),
  conditions  text,
  rationale   text not null,
  votes       jsonb not null default '[]',
  recusals    jsonb not null default '[]',
  decided_by  uuid not null references users(id),
  decided_at  timestamptz not null default now()
);

create table agreements (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  request_id  uuid not null references requests(id),
  template_id text not null,
  clauses     jsonb not null,
  body        text not null,
  status      text not null check (status in ('draft', 'sent', 'signed', 'certified', 'void')),
  envelope_id text,
  signatures  jsonb not null default '[]',
  certified_by uuid references users(id),
  certified_at timestamptz,
  created_at  timestamptz not null default now()
);

create table payments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  request_id  uuid not null references requests(id),
  milestone   int  not null,
  label       text not null,
  amount      numeric(14, 2) not null,
  currency    char(3) not null,
  status      text not null check (status in ('scheduled', 'ready', 'released', 'paid', 'cancelled')),
  gl_account  text,
  tax_class   text,
  payee       jsonb not null default '{}',
  erp_refs    jsonb not null default '{}',
  released_by uuid references users(id),
  released_at timestamptz,
  paid_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table transfers_of_value (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  request_id  uuid not null references requests(id),
  payment_id  uuid references payments(id),
  regime      text not null,
  category    text not null,
  recipient   jsonb not null,
  amount      numeric(14, 2) not null,
  currency    char(3) not null,
  period      text not null,               -- e.g. "2027" or "2027-H1"
  state       text not null default 'recorded' check (state in ('recorded', 'in-file', 'submitted', 'published', 'corrected')),
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index tov_regime_period on transfers_of_value (tenant_id, regime, period);

-- ─── Audit: append-only, hash-chained per tenant ────────────────────────────

create table event_heads (
  tenant_id uuid primary key references tenants(id),
  seq       bigint not null,
  hash      text not null
);

create table events (
  tenant_id   uuid not null references tenants(id),
  seq         bigint not null,
  id          uuid not null unique,
  at          timestamptz not null,
  actor       jsonb not null,
  entity_type text not null,
  entity_id   text not null,
  action      text not null,
  data        jsonb not null default '{}',
  ai          jsonb,
  prev_hash   text not null,
  hash        text not null,
  primary key (tenant_id, seq)
);
create index events_entity on events (tenant_id, entity_type, entity_id, seq);
create index events_actor_type on events (tenant_id, (actor->>'type'), at);

create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'The audit trail is append-only';
end $$;
create trigger events_no_update before update or delete on events
  for each row execute function events_append_only();

create table chain_anchors (
  tenant_id   uuid not null references tenants(id),
  seq         bigint not null,
  hash        text not null,
  anchored_at timestamptz not null default now(),
  method      text not null default 'database',  -- 'database' in the demo; 'worm+rfc3161' in production
  token       text,
  primary key (tenant_id, seq)
);

-- ─── Row-level security ─────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['config_versions','requests','messages','tasks','reviews','meetings','decisions','agreements','payments','transfers_of_value','events','event_heads','chain_anchors','outbox'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = current_tenant() or is_operator()) with check (tenant_id = current_tenant() or is_operator())$p$, t);
  end loop;
end $$;

-- Requestor sessions see only their own organization's requests and the records hanging off them.
create policy requestor_org on requests as restrictive using (current_org() is null or org_id = current_org());
create policy requestor_org on messages as restrictive using (current_org() is null or (channel = 'requestor' and exists (select 1 from requests r where r.id = request_id)));
create policy requestor_org on tasks as restrictive using (current_org() is null or exists (select 1 from requests r where r.id = request_id));
create policy requestor_org on reviews as restrictive using (current_org() is null);
create policy requestor_org on decisions as restrictive using (current_org() is null or exists (select 1 from requests r where r.id = request_id));
create policy requestor_org on agreements as restrictive using (current_org() is null or exists (select 1 from requests r where r.id = request_id));
create policy requestor_org on payments as restrictive using (current_org() is null or exists (select 1 from requests r where r.id = request_id));
create policy requestor_org on transfers_of_value as restrictive using (current_org() is null);

alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_self on tenants using (id = current_tenant() or is_operator());

-- Organizations: a tenant sees organizations that shared their passport with it; a requestor sees their own.
alter table organizations enable row level security;
alter table organizations force row level security;
create policy org_visibility on organizations using (
  is_operator() or id = current_org()
  or exists (select 1 from org_shares s where s.org_id = organizations.id and s.tenant_id = current_tenant())
) with check (is_operator() or id = current_org() or current_tenant() is not null);

alter table org_shares enable row level security;
alter table org_shares force row level security;
create policy shares_visibility on org_shares using (is_operator() or tenant_id = current_tenant() or org_id = current_org());

alter table documents enable row level security;
alter table documents force row level security;
create policy documents_visibility on documents using (
  is_operator()
  or (tenant_id = current_tenant() and (current_org() is null or org_id = current_org()))
  or (tenant_id is null and (org_id = current_org() or exists (select 1 from org_shares s where s.org_id = documents.org_id and s.tenant_id = current_tenant() and 'documents' = any(s.scope))))
);

alter table users enable row level security;
alter table users force row level security;
create policy users_visibility on users using (
  is_operator() or tenant_id = current_tenant() or org_id = current_org()
  or (kind = 'requestor' and exists (select 1 from requests r where r.requestor_id = users.id))
);

-- Login lookup happens before a tenant is in scope; this narrow function is the only bypass.
create or replace function auth_find_user(p_email text)
returns table (id uuid, email text, name text, kind text, tenant_id uuid, org_id uuid, roles text[], active boolean)
language sql security definer set search_path = public as
$$ select id, email, name, kind, tenant_id, org_id, roles, active from users where lower(email) = lower(p_email) $$;

create or replace function auth_get_user(p_id uuid)
returns table (id uuid, email text, name text, title text, kind text, tenant_id uuid, org_id uuid, roles text[], attributes jsonb, active boolean)
language sql security definer set search_path = public as
$$ select id, email, name, title, kind, tenant_id, org_id, roles, attributes, active from users where id = p_id $$;

create or replace function auth_tenant_by_slug(p_slug text)
returns table (id uuid, slug text, name text, settings jsonb)
language sql security definer set search_path = public as
$$ select id, slug, name, settings from tenants where slug = p_slug $$;
