-- A company org's own "New" form for each request type (read from its page layouts), which of those request types
-- are grants, and the fields the process owner chose not to ask requestors, per request type.
alter table connector_credentials add column request_forms jsonb;
alter table connector_credentials add column grant_types text[];
alter table connector_credentials add column form_excluded jsonb;
