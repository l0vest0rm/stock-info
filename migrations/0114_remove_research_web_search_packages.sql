-- The local Web Search evidence-package feature has been retired.  Its three
-- dedicated projections are not a source of record for any remaining page or
-- workflow.  Generic task/run rows are retained as historical execution
-- records, but live tasks are terminalized so the dispatcher cannot claim an
-- unhandled research_web_search task after this migration.
update llm_runs
   set status = 'failed',
       error_code = 'feature_removed',
       error_message = 'research Web Search evidence packages were removed',
       lease_until = null,
       completed_at = coalesce(completed_at, unixepoch() * 1000),
       updated_at = unixepoch() * 1000
 where task_id in (select task_id from workflow_tasks where task_type = 'research_web_search')
   and status = 'running';

update workflow_tasks
   set status = 'failed',
       last_error_code = 'feature_removed',
       last_error_message = 'research Web Search evidence packages were removed',
       completed_at = coalesce(completed_at, unixepoch() * 1000),
       updated_at = unixepoch() * 1000
 where task_type = 'research_web_search'
   and status in ('queued', 'running');

delete from local_job_provider_leases
 where job_type = 'llm_run'
   and job_id in (select task_id from workflow_tasks where task_type = 'research_web_search');

update local_job_provider_slots
   set active_count = (select count(*) from local_job_provider_leases where provider_id = local_job_provider_slots.provider_id),
       updated_at = unixepoch() * 1000;

drop table research_web_search_package_jobs;
drop table research_web_search_evidence_records;
drop table research_web_search_source_packages;
