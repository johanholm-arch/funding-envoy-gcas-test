-- Test sets and reviewing groups are versioned configuration too.
alter table config_versions drop constraint if exists config_versions_kind_check;
alter table config_versions add constraint config_versions_kind_check
  check (kind in ('rulebook', 'workflow', 'catalogue', 'autonomy', 'brand', 'words', 'policy', 'sop', 'metrics', 'testset'));
