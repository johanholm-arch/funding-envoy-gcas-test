-- Rules failing or pending with blocking severity in a request's stored checks, for "which rules block most".
create or replace function fe_blocking_rules(s jsonb) returns text[] language sql immutable parallel safe as $$
  select coalesce(array_agg(distinct c->>'ruleId'), '{}') from jsonb_array_elements(case when jsonb_typeof(s->'checks') = 'array' then s->'checks' else '[]'::jsonb end) c
  where c->>'status' in ('fail', 'pending') and c->>'severity' = 'block'
$$;
alter table requests add column blocking_rules text[] generated always as (fe_blocking_rules(state)) stored;
