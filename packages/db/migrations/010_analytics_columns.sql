-- Analytics read these on every row of a period. As stored columns they avoid unpacking each request's state.
alter table requests
  add column group_label text generated always as (state->'reviewingGroup'->>'label') stored,
  add column decision_outcome text generated always as (state->'decision'->>'outcome') stored,
  add column flag_count int generated always as (case when jsonb_typeof(state->'flags') = 'array' then jsonb_array_length(state->'flags') else 0 end) stored,
  add column info_rounds int generated always as (case when jsonb_typeof(state->'infoRequests') = 'array' then jsonb_array_length(state->'infoRequests') else 0 end) stored;
create index requests_decided_at on requests (tenant_id, decided_at) where decided_at is not null;
