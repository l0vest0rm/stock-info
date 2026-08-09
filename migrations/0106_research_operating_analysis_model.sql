-- Keep the selected model on the durable queue item so a CLI or page request
-- controls every staged call after a runner claims the job.
alter table research_operating_analysis_jobs add column model text not null default 'gpt-5.6-luna';
