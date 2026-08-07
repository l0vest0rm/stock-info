-- Automatic, source-bound risk snapshots.  They are derived only from the
-- current statutory risk fact set and retain a stable source signature so a
-- new filing can be compared with the immediately prior saved state.
create table research_auto_risk_snapshots (
  auto_risk_snapshot_id text primary key,
  security_code text not null,
  source_signature text not null,
  source_document_ids_json text not null,
  items_json text not null,
  as_of integer not null,
  created_at integer not null,
  unique(security_code, source_signature)
);
create index idx_research_auto_risk_snapshots_security
  on research_auto_risk_snapshots(security_code, as_of desc);
