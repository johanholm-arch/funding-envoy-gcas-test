-- For a company's own Salesforce org: which object holds its grant requests, and the field mapping chosen in the
-- Connect wizard. Kept here, not as a configuration draft, until writing to a company org is switched on.
alter table connector_credentials add column request_object text;
alter table connector_credentials add column mapping jsonb;
alter table connector_credentials add column mapping_saved_by text;
alter table connector_credentials add column mapping_saved_at timestamptz;
