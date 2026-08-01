create table if not exists situation_knowledge_imports (
  source_scope text not null check (source_scope in ('knowledge_docs', 'knowledge_filtered_docs')),
  doc_id text not null,
  status text not null check (status in ('imported', 'skipped_no_source_url', 'failed')),
  evidence_id text,
  reason text,
  first_seen_at integer not null,
  updated_at integer not null,
  primary key (source_scope, doc_id),
  foreign key(evidence_id) references situation_evidence(evidence_id) on delete set null
);

create index if not exists idx_situation_knowledge_imports_status
  on situation_knowledge_imports(status, updated_at desc);
