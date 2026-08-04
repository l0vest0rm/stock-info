-- An operating company and a listed security are deliberately separate research
-- objects.  These append-only records capture security-specific holder rights and
-- explicit relationships between two securities.  They are never inferred from a
-- matching company name or ticker stem.

create table research_security_rights_profiles (
  rights_profile_id text primary key,
  security_code text not null,
  rights_status text not null check (rights_status in ('confirmed', 'provisional', 'needs_review', 'conflicting')),
  holder_structure text not null check (holder_structure in ('direct_registered_holder', 'beneficial_holder', 'depositary_receipt_holder', 'other')),
  legal_issuer_name text,
  voting_rights_note text,
  economic_rights_note text,
  transferability_note text,
  structural_risk_note text,
  depositary_name text,
  depositary_fee_note text,
  effective_from text,
  effective_to text,
  evidence_kind text not null check (evidence_kind in ('securities_regulator_filing', 'official_exchange_disclosure', 'depositary_agreement', 'issuer_official_disclosure')),
  source_url text not null,
  source_title text not null,
  source_note text not null,
  observed_at integer not null,
  metadata_json text not null default '{}',
  created_at integer not null,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_security_rights_profiles_current
  on research_security_rights_profiles(security_code, rights_status, observed_at desc);

create table research_security_rights_links (
  rights_link_id text primary key,
  security_code text not null,
  related_security_code text not null,
  relationship_kind text not null check (relationship_kind in ('same_operating_company_different_security', 'adr_underlying_security', 'other_security_right')),
  relationship_status text not null check (relationship_status in ('confirmed', 'provisional', 'needs_review', 'conflicting')),
  related_shares_per_security real,
  conversion_availability text not null check (conversion_availability in ('available', 'restricted', 'not_available', 'unknown', 'not_applicable')),
  relationship_note text not null,
  effective_from text,
  effective_to text,
  evidence_kind text not null check (evidence_kind in ('securities_regulator_filing', 'official_exchange_disclosure', 'depositary_agreement', 'issuer_official_disclosure')),
  source_url text not null,
  source_title text not null,
  source_note text not null,
  observed_at integer not null,
  metadata_json text not null default '{}',
  created_at integer not null,
  check (security_code <> related_security_code),
  check (related_shares_per_security is null or related_shares_per_security > 0),
  check ((relationship_kind = 'adr_underlying_security' and related_shares_per_security is not null) or relationship_kind <> 'adr_underlying_security'),
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict,
  foreign key(related_security_code) references research_listed_securities(security_code) on delete restrict
);
create unique index idx_research_security_rights_links_version
  on research_security_rights_links(security_code, related_security_code, relationship_kind, observed_at);
create index idx_research_security_rights_links_security
  on research_security_rights_links(security_code, relationship_status, observed_at desc);
create index idx_research_security_rights_links_related
  on research_security_rights_links(related_security_code, relationship_status, observed_at desc);
