-- A document can satisfy more than one requirement (a prospectus that contains the accreditation statement).
alter table documents add column if not exists covers text[] not null default '{}';
