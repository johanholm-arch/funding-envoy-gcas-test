-- How a company's grant request is built in its Salesforce: the parent, its request types and its child records
-- (read-only, counts only), and which of those parts the process owner said belong to a grant request.
alter table connector_credentials add column request_map jsonb;
alter table connector_credentials add column request_parts text[];
