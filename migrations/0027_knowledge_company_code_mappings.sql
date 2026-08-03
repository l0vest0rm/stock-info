-- Confirmed local links from a model-identified company name to one or more securities.
-- Only exact matches from the existing security search are persisted here.
create table if not exists knowledge_company_code_mappings (
  company_name text not null,
  code text not null,
  security_name text not null,
  source text not null,
  matched_at integer not null,
  updated_at integer not null,
  primary key (company_name, code)
);

create index if not exists idx_knowledge_company_code_mappings_company
  on knowledge_company_code_mappings (company_name, code);
