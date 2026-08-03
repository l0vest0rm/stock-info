create table if not exists information_processing_jobs (
  job_id text primary key,
  doc_id text not null unique,
  status text not null check (status in ('queued', 'processing', 'completed', 'needs_review', 'failed')),
  attempt_count integer not null default 0,
  last_run_id text,
  last_error text,
  created_at integer not null,
  updated_at integer not null,
  foreign key(doc_id) references knowledge_docs(doc_id) on delete restrict,
  foreign key(last_run_id) references knowledge_processing_runs(run_id) on delete set null
);
create index if not exists idx_information_processing_jobs_queue on information_processing_jobs(status, created_at);
