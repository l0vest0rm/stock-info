-- Explicit public links are required before a risk can request thesis review.
-- Text matching would create unauditable, potentially misleading propagation.
create table research_risk_thesis_links (
  risk_thesis_link_id text primary key,
  risk_id text not null,
  thesis_id text not null,
  relationship text not null check (relationship in ('invalidates', 'pressures', 'monitors')),
  rationale text not null,
  source_refs_json text not null default '[]',
  created_at integer not null,
  unique(risk_id, thesis_id, relationship),
  foreign key(risk_id) references research_risk_entries(risk_id) on delete restrict,
  foreign key(thesis_id) references research_theses(thesis_id) on delete restrict
);
create index idx_research_risk_thesis_links_risk on research_risk_thesis_links(risk_id, created_at desc);
create index idx_research_risk_thesis_links_thesis on research_risk_thesis_links(thesis_id, created_at desc);

-- A public snapshot freezes exactly the module payload that was visible then.
-- It is separate from per-module differences so later unchanged modules remain
-- reconstructible without rereading present-day research records.
create table research_analysis_snapshot_modules (
  analysis_snapshot_id text not null,
  module_id text not null,
  availability text not null check (availability in ('available', 'empty', 'unavailable')),
  version_id text,
  module_as_of integer,
  payload_json text not null,
  created_at integer not null,
  primary key(analysis_snapshot_id, module_id),
  foreign key(analysis_snapshot_id) references research_analysis_snapshots(analysis_snapshot_id) on delete restrict
);
create index idx_research_snapshot_modules_created on research_analysis_snapshot_modules(analysis_snapshot_id, module_id);

-- Public snapshot propagation must never be wired to a personal thesis.
create trigger if not exists trg_research_risk_thesis_links_reject_personal_thesis_insert
before insert on research_risk_thesis_links
when exists (select 1 from research_theses where thesis_id = new.thesis_id and assessment_type = 'user_decision')
begin
  select raise(abort, 'public risk thesis link cannot reference user decision thesis');
end;
