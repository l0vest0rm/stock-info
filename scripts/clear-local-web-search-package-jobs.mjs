#!/usr/bin/env node

import { executeLocalD1Sql } from "./lib/local-d1-sqlite.mjs";

const now = Date.now();
const databaseFile = executeLocalD1Sql(`
  -- Generic task/run state is the sole Web Search execution ledger.  Scope
  -- every mutation by task_type so this maintenance command cannot requeue
  -- information-processing or operating-analysis tasks.
  update llm_runs
     set status='failed',
         error_code='lease_expired',
         error_message='local Web Search runner lease expired; requeued for a new attempt',
         completed_at=${now},
         updated_at=${now},
         lease_until=null
   where status='running'
     and lease_until<${now}
     and task_id in (select task_id from llm_tasks where task_type='research_web_search');

  update llm_tasks
     set status='queued',
         last_error_code='lease_expired',
         last_error_message='local Web Search runner lease expired; requeued for a new attempt',
         completed_at=null,
         updated_at=${now}
   where status='running'
     and task_type='research_web_search'
     and last_run_id in (select run_id from llm_runs where error_code='lease_expired' and status='failed');

  delete from local_job_provider_leases
   where provider_id='openai'
     and job_type='llm_run'
     and exists (
       select 1
         from llm_runs r
         join llm_tasks t on t.task_id=r.task_id
        where t.task_type='research_web_search'
          and r.status='failed'
          and r.error_code='lease_expired'
          and r.updated_at=${now}
          and r.task_id=local_job_provider_leases.job_id
          and r.attempt=local_job_provider_leases.attempt
          and r.lease_owner=local_job_provider_leases.lease_owner
     );

  update local_job_provider_slots
     set active_count=(select count(*) from local_job_provider_leases where provider_id='openai'),
         updated_at=${now}
   where provider_id='openai';
`, { requiredTable: "llm_tasks" });

console.log(`Requeued only expired generic Web Search task/run leases: ${databaseFile}`);
