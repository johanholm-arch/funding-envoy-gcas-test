-- The request an event belongs to, as a plain column. Under row-level security Postgres only uses an index for
-- conditions built from leakproof operators; the JSON field operator is not one, so `data->>'requestId' = $1`
-- scanned the whole events table. Text equality on a stored column is.
drop index if exists events_request;
alter table events add column request_id text generated always as (coalesce(data->>'requestId', case when entity_type = 'request' then entity_id end)) stored;
create index events_request on events (tenant_id, request_id, seq) where request_id is not null;
