-- Sync progress and latest execution status are fixed-key kv_cache records.
-- sync_jobs retained one row per execution but had no runtime reader or
-- recovery responsibility, so it grew without a consumer.
drop table if exists sync_jobs;
