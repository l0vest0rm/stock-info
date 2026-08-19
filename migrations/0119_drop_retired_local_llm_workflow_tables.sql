-- Every local LLM caller is now either request-bound and persists its own
-- business result, or a taskd client whose remote task is projected to
-- kv_cache.  No runtime code claims, recovers, or reads this local workflow
-- ledger, so remove the entire retired scheduler schema together.
drop table if exists llm_workflow_artifact_links;
drop table if exists llm_task_dependencies;
drop table if exists llm_run_artifact_links;
drop table if exists llm_run_artifacts;
drop table if exists llm_runs;
drop table if exists workflow_tasks;
drop table if exists llm_scheduler_sequence;
drop table if exists local_job_provider_slots;

-- These former local queue projections likewise have no remaining producer
-- or consumer. Knowledge processing checkpoints in kv_cache; investment
-- analysis and financial analysis are taskd workflows with business-result
-- projections in kv_cache.
drop table if exists information_processing_jobs;
drop table if exists research_operating_analysis_jobs;
