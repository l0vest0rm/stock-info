-- Yahoo's timeseries can use a calendar-month display date for a non-calendar
-- fiscal period.  This ledger records a human-reviewed equivalence to one
-- exact SEC XBRL period.  It is append-only: a later review supersedes only
-- by adding another record, never by rewriting a prior audit decision.
create table research_us_financial_period_equivalences (
  period_equivalence_id text primary key,
  security_code text not null,
  primary_comparison_key text not null,
  primary_statement_type text not null check (primary_statement_type in ('income', 'balance', 'cashflow')),
  metric text not null,
  primary_period_kind text not null check (primary_period_kind in ('annual', 'quarter')),
  primary_period_start_date text not null,
  primary_period_end_date text not null,
  primary_currency text not null,
  sec_cik text not null,
  sec_accession text not null,
  sec_namespace text not null check (sec_namespace in ('us-gaap', 'ifrs-full')),
  sec_concept text not null,
  sec_unit text not null,
  sec_period_start_date text,
  sec_period_end_date text not null,
  sec_form text not null check (sec_form in ('10-K', '10-Q', '20-F', '6-K')),
  evidence_url text not null check (evidence_url like 'https://www.sec.gov/Archives/edgar/data/%'),
  evidence_title text not null,
  review_decision text not null check (review_decision in ('accepted', 'rejected')),
  review_reason text not null,
  reviewed_by text not null,
  reviewed_at integer not null,
  created_at integer not null,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_us_financial_period_equivalences_lookup
  on research_us_financial_period_equivalences(security_code, primary_comparison_key, review_decision, reviewed_at desc);
create unique index idx_research_us_financial_period_equivalences_immutable
  on research_us_financial_period_equivalences(period_equivalence_id);
