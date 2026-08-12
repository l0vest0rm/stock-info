-- Rename the local orchestration ledger away from the remote-task-specific
-- llm_tasks name. The table continues to hold stock-info's local workflow task
-- state while remote model/browser execution is delegated to taskd.
alter table llm_tasks rename to workflow_tasks;

update llm_scheduler_sequence
   set sequence_name='workflow_tasks'
 where sequence_name='llm_tasks';
