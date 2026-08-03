alter table information_processing_jobs add column trigger_source text not null default 'manual';

create index if not exists idx_information_processing_jobs_trigger_source on information_processing_jobs(trigger_source, updated_at desc);
