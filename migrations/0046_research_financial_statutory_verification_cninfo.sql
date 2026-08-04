-- CNINFO is the statutory verification provider selected by the A-share
-- source policy.  SQLite cannot extend a CHECK constraint in place, so retain
-- every immutable observation while rebuilding the table with the additional
-- allowed provider.  This migration deliberately changes no rows or values.

pragma foreign_keys = off;

alter table research_financial_statutory_verifications rename to research_financial_statutory_verifications_old;

create table research_financial_statutory_verifications (
  verification_id text primary key,
  security_code text not null,
  normalized_fact_id text not null,
  metric text not null check (metric in (
    'revenue', 'gross_profit', 'operating_profit', 'net_profit',
    'operating_cash_flow', 'capital_expenditure', 'cash', 'total_debt',
    'total_equity', 'diluted_weighted_average_shares', 'diluted_shares'
  )),
  period_kind text not null check (period_kind in ('annual', 'quarter')),
  period_start_date text not null,
  period_end_date text not null,
  fiscal_year integer not null,
  fiscal_quarter integer check (fiscal_quarter in (1, 2, 3, 4)),
  normalized_value real,
  normalized_basis_id text not null,
  normalized_currency text not null,
  normalized_accounting_standard text not null,
  normalized_scope text not null,
  normalized_revision text not null,
  primary_source_id text not null,
  primary_source_type text not null,
  primary_document_id text,
  primary_source_url text,
  primary_locator text,
  primary_published_at text,
  statutory_provider text not null check (statutory_provider in ('cninfo', 'hkex', 'sec')),
  outcome text not null check (outcome in ('match', 'conflict', 'unverified')),
  statutory_value real,
  statutory_basis_id text,
  statutory_currency text,
  statutory_accounting_standard text,
  statutory_scope text,
  statutory_revision text,
  statutory_document_id text,
  statutory_disclosure_url text,
  statutory_locator text,
  statutory_published_at text,
  statutory_report_date text,
  comparison_rule_version text not null,
  absolute_tolerance real not null check (absolute_tolerance >= 0),
  relative_tolerance real not null check (relative_tolerance >= 0),
  absolute_delta real,
  relative_delta real,
  reason_codes_json text not null default '[]',
  metadata_json text not null default '{}',
  observed_at integer not null,
  created_at integer not null,
  check (
    (period_kind = 'annual' and fiscal_quarter is null)
    or (period_kind = 'quarter' and fiscal_quarter is not null)
  ),
  check (
    outcome = 'unverified'
    or (
      statutory_value is not null
      and statutory_basis_id is not null
      and statutory_currency is not null
      and statutory_accounting_standard is not null
      and statutory_scope is not null
      and statutory_revision is not null
      and statutory_document_id is not null
      and statutory_disclosure_url is not null
      and statutory_locator is not null
      and statutory_published_at is not null
      and statutory_report_date is not null
    )
  ),
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);

insert into research_financial_statutory_verifications
select * from research_financial_statutory_verifications_old;

drop table research_financial_statutory_verifications_old;

create index idx_research_financial_statutory_verifications_fact
  on research_financial_statutory_verifications(
    security_code, normalized_fact_id, observed_at desc
  );
create index idx_research_financial_statutory_verifications_provider
  on research_financial_statutory_verifications(
    security_code, statutory_provider, outcome, observed_at desc
  );

pragma foreign_keys = on;
