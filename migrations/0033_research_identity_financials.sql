-- Extends the research ledger with auditable company/security identity links,
-- provider identifiers and dated financial-statement availability observations.
-- The selected security remains usable when no company relationship is known;
-- missing identity or financial evidence must be represented as unavailable.

create table research_company_security_relationships (
  relationship_id text primary key,
  company_id text not null,
  security_code text not null,
  relationship_type text not null
    check (relationship_type in ('primary_listing', 'secondary_listing', 'depositary_receipt', 'other_equity_claim')),
  relationship_status text not null
    check (relationship_status in ('confirmed', 'provisional', 'needs_review', 'conflicting')),
  source_url text,
  source_note text,
  effective_from text,
  effective_to text,
  metadata_json text not null default '{}',
  created_at integer not null,
  updated_at integer not null,
  unique(company_id, security_code, relationship_type),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_company_security_relationships_security
  on research_company_security_relationships(security_code, relationship_status, updated_at desc);
create index idx_research_company_security_relationships_company
  on research_company_security_relationships(company_id, relationship_status, security_code);

create table research_provider_identifiers (
  identifier_id text primary key,
  owner_type text not null check (owner_type in ('operating_company', 'listed_security')),
  company_id text,
  security_code text,
  provider text not null,
  identifier_kind text not null,
  identifier_value text not null,
  identifier_status text not null
    check (identifier_status in ('confirmed', 'provisional', 'needs_review', 'conflicting', 'inactive')),
  source_url text,
  source_note text,
  observed_at integer not null,
  metadata_json text not null default '{}',
  created_at integer not null,
  updated_at integer not null,
  check (
    (owner_type = 'operating_company' and company_id is not null and security_code is null)
    or
    (owner_type = 'listed_security' and security_code is not null and company_id is null)
  ),
  unique(owner_type, provider, identifier_kind, identifier_value),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_provider_identifiers_company
  on research_provider_identifiers(company_id, provider, identifier_status);
create index idx_research_provider_identifiers_security
  on research_provider_identifiers(security_code, provider, identifier_status);

create table research_financial_availability_observations (
  observation_id text primary key,
  security_code text not null,
  statement_type text not null check (statement_type in ('income', 'balance', 'cashflow')),
  provider text not null,
  source_role text not null check (source_role in ('primary_structured', 'statutory_verification')),
  availability_status text not null
    check (availability_status in (
      'verified_available', 'partially_available', 'requires_integration',
      'document_only', 'unavailable', 'source_unhealthy'
    )),
  as_of integer not null,
  latest_period text,
  reporting_currency text,
  accounting_basis text,
  source_url text,
  blocking_reason text,
  details_json text not null default '{}',
  created_at integer not null,
  unique(security_code, statement_type, provider, source_role, as_of),
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_financial_availability_latest
  on research_financial_availability_observations(
    security_code, statement_type, provider, source_role, as_of desc
  );
