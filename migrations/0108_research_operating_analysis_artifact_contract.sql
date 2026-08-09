-- Forward-only metadata for the low-dependency terminal-artifact contract.
--
-- 0107 remains the generic task/run/artifact lifecycle.  These nullable
-- columns let the new research stages record their immutable lineage without
-- rewriting historical generic artifacts or the legacy six-stage table.
alter table llm_runs add column lineage_run_id text;
alter table llm_run_artifacts add column stage_version text;
alter table llm_run_artifacts add column input_fingerprint text;
alter table llm_run_artifacts add column source_ids_json text not null default '[]';
alter table llm_run_artifacts add column claim_ids_json text not null default '[]';
alter table llm_run_artifacts add column evidence_ids_json text not null default '[]';
alter table llm_run_artifacts add column unknown_ids_json text not null default '[]';
alter table llm_run_artifacts add column projection_version text;

create index if not exists idx_llm_run_artifacts_stage
  on llm_run_artifacts (step_key, stage_version, completed_at);

-- A recovery run links compatible terminal artifacts from the nearest prior
-- run instead of copying them.  The artifact UUID therefore remains stable,
-- while the new run owns an explicit reference and can safely invalidate only
-- changed stages and their dependency descendants.
create table if not exists llm_run_artifact_links (
  run_id text not null,
  artifact_id text not null,
  source_run_id text not null,
  step_key text not null,
  stage_version text,
  input_fingerprint text,
  upstream_artifact_ids_json text not null default '[]',
  projection_version text,
  linked_at integer not null,
  primary key (run_id, step_key),
  unique (run_id, artifact_id),
  foreign key (run_id) references llm_runs(run_id) on delete cascade,
  foreign key (artifact_id) references llm_run_artifacts(artifact_id) on delete cascade,
  foreign key (source_run_id) references llm_runs(run_id) on delete cascade
);

create index if not exists idx_llm_run_artifact_links_source
  on llm_run_artifact_links (source_run_id, step_key, linked_at);
