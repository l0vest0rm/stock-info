-- Additive foundation for one generic local-model scheduler.
--
-- 0107 remains the task/run/artifact lifecycle used by the current callers.
-- These fields let the next phase schedule every producer through one ordered
-- queue without rewriting existing task rows or their terminal artifacts.
alter table llm_tasks add column priority integer not null default 500
  check (priority between 0 and 1000);
alter table llm_tasks add column queue_sequence integer not null default 0;
alter table llm_tasks add column handler_key text not null default 'legacy';
alter table llm_tasks add column execution_mode text not null default 'model'
  check (execution_mode in ('model', 'engineering'));
alter table llm_tasks add column parent_task_id text;
alter table llm_tasks add column stage_key text;
alter table llm_tasks add column ready_at integer;

-- Seed durable FIFO order from the existing creation order. `rowid` is used only
-- as a stable tie-breaker for equal millisecond timestamps; future inserts use
-- the singleton allocator below instead of max()+1 races.
with ordered as (
  select task_id,
         row_number() over (order by created_at, rowid) as sequence_value
    from llm_tasks
)
update llm_tasks
   set queue_sequence=(select sequence_value from ordered where ordered.task_id=llm_tasks.task_id)
 where queue_sequence=0;

update llm_tasks
   set handler_key=task_type
 where handler_key='legacy' or handler_key is null or trim(handler_key)='';

-- Tasks without dependency edges are immediately eligible. A null value is
-- retained only while a new task is waiting for its dependency projection.
update llm_tasks
   set ready_at=created_at
 where ready_at is null;

create table if not exists llm_scheduler_sequence (
  sequence_name text primary key,
  next_sequence integer not null check (next_sequence >= 0)
);
insert or ignore into llm_scheduler_sequence (sequence_name, next_sequence)
  values ('llm_tasks', 0);
update llm_scheduler_sequence
   set next_sequence=coalesce((select max(queue_sequence) from llm_tasks), 0)
 where sequence_name='llm_tasks';

create index if not exists idx_llm_tasks_global_ready
  on llm_tasks (status, priority desc, queue_sequence asc);
create index if not exists idx_llm_tasks_handler_ready
  on llm_tasks (handler_key, execution_mode, status, priority desc, queue_sequence asc);
create index if not exists idx_llm_tasks_parent_stage
  on llm_tasks (parent_task_id, stage_key, queue_sequence);
create unique index if not exists idx_llm_tasks_queue_sequence
  on llm_tasks (queue_sequence)
  where queue_sequence > 0;

-- A queued task is ready only after every edge's upstream task reaches the
-- required successful status. Failure/blocked propagation is derived by the
-- shared protocol; no second mutable readiness ledger can drift from status.
create table if not exists llm_task_dependencies (
  task_id text not null,
  depends_on_task_id text not null,
  required_status text not null default 'completed'
    check (required_status='completed'),
  created_at integer not null,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id),
  foreign key (task_id) references llm_tasks(task_id) on delete cascade,
  foreign key (depends_on_task_id) references llm_tasks(task_id) on delete cascade
);
create index if not exists idx_llm_task_dependencies_upstream
  on llm_task_dependencies (depends_on_task_id, task_id);
create index if not exists idx_llm_task_dependencies_downstream
  on llm_task_dependencies (task_id, depends_on_task_id);

-- Cross-task artifact links for workflow/child-stage projections. The existing
-- llm_run_artifact_links table intentionally remains same-task recovery-only.
create table if not exists llm_workflow_artifact_links (
  parent_task_id text not null,
  child_task_id text not null,
  run_id text not null,
  artifact_id text not null,
  stage_key text not null,
  linked_at integer not null,
  primary key (parent_task_id, child_task_id, run_id, stage_key),
  foreign key (parent_task_id) references llm_tasks(task_id) on delete cascade,
  foreign key (child_task_id) references llm_tasks(task_id) on delete cascade,
  foreign key (run_id) references llm_runs(run_id) on delete cascade,
  foreign key (artifact_id) references llm_run_artifacts(artifact_id) on delete cascade
);
create index if not exists idx_llm_workflow_artifact_links_parent_stage
  on llm_workflow_artifact_links (parent_task_id, stage_key, linked_at desc);
create index if not exists idx_llm_workflow_artifact_links_child
  on llm_workflow_artifact_links (child_task_id, linked_at desc);
