-- Financial-entity classification is a company-level, source-bound ledger.
-- A listed-security code/name is never sufficient evidence for the business
-- model.  Rows are append-only so an historic classification can be audited.
create table research_company_financial_profiles (
  financial_profile_id text primary key,
  company_id text not null,
  source_security_code text not null,
  entity_type text not null check (entity_type in ('non_financial', 'bank', 'insurer', 'broker', 'financial_other')),
  as_of text not null,
  source_authority text not null check (source_authority in ('issuer_disclosure', 'exchange_filing', 'regulator_or_court', 'audit_report')),
  source_url text not null,
  source_title text not null,
  source_note text not null,
  recorded_by text not null,
  recorded_at integer not null,
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(source_security_code) references research_listed_securities(security_code) on delete restrict,
  unique(company_id, as_of, entity_type, source_url)
);
create index idx_research_company_financial_profiles_current
  on research_company_financial_profiles(company_id, as_of desc, recorded_at desc, financial_profile_id desc);
create index idx_research_company_financial_profiles_security
  on research_company_financial_profiles(source_security_code, recorded_at desc, financial_profile_id desc);
