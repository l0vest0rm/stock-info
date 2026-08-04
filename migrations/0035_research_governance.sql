-- Management ability, credibility, governance and capital allocation are
-- separate evidence-backed research dimensions; they must not collapse into
-- a single qualitative score.
create table research_governance_records (
  governance_record_id text primary key,
  company_id text not null,
  as_of integer not null,
  dimension text not null check (dimension in ('management_capability', 'guidance_credibility', 'governance', 'alignment', 'capital_allocation')),
  title text not null,
  statement text not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'source_viewpoint', 'third_party_forecast', 'analysis_assumption', 'system_judgment')),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_governance_company on research_governance_records(company_id, dimension, as_of desc);
