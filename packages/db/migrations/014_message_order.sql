-- Messages written in one transaction used to share now() (the transaction start), so their order was unstable.
-- clock_timestamp() is the moment of each insert.
alter table messages alter column created_at set default clock_timestamp();
