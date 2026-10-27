-- Scale: what the desk, brief, trail and analytics need to stay fast at hundreds of thousands of requests.

-- Items for a person's judgement on a request: checks marked for judgement or submitted with a flag that nobody
-- has judged yet, plus conflict-of-interest answers of yes. Same rule as the desk's count in desk.ts.
create or replace function fe_judgement_open(s jsonb) returns int language sql immutable parallel safe as $$
  select coalesce((select count(*) from jsonb_array_elements(case when jsonb_typeof(s->'checks') = 'array' then s->'checks' else '[]'::jsonb end) c
          where (c->>'status' = 'judge' or (c ? 'acknowledged' and c->'acknowledged' <> 'null'::jsonb))
            and not (coalesce(s->'judgements', '{}'::jsonb) ? (c->>'ruleId'))), 0)::int
       + coalesce((select count(*) from jsonb_each(case when jsonb_typeof(s->'coi') = 'object' then s->'coi' else '{}'::jsonb end) a where a.value->>'answer' = 'yes'), 0)::int
$$;

create or replace function fe_info_open(s jsonb) returns boolean language sql immutable parallel safe as $$
  select exists (select 1 from jsonb_array_elements(case when jsonb_typeof(s->'infoRequests') = 'array' then s->'infoRequests' else '[]'::jsonb end) i where i->>'status' = 'open')
$$;

alter table requests add column judgement_open int generated always as (fe_judgement_open(state)) stored;
alter table requests add column info_open boolean generated always as (fe_info_open(state)) stored;

-- Work in flight is a small, hot part of the table.
create index requests_open on requests (tenant_id, stage, submitted_at) where status not in ('draft', 'closed', 'declined', 'withdrawn');
create index requests_done on requests (tenant_id, updated_at desc) where status in ('closed', 'declined');
create index requests_decided on requests (tenant_id, subtype, decided_at) where decided_at is not null;
create index requests_submitted on requests (tenant_id, submitted_at);
create index tasks_request_open on tasks (request_id) where status = 'open';
create index events_request on events (tenant_id, (data->>'requestId'));
create index payments_request on payments (request_id);
create index payments_paid on payments (tenant_id, paid_at) where status = 'paid';
