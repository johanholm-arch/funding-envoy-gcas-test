-- The desk reads every open request's pile inputs; with these columns in the index it never touches the table.
create index requests_open_cover on requests (tenant_id) include (id, stage, submitted_at, stage_entered_at, judgement_open, info_open, org_id, status)
  where status not in ('draft', 'closed', 'declined', 'withdrawn');
