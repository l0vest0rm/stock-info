-- Company focus is deliberately split into a private selection ledger and a
-- public, immutable reference graph.  It must never duplicate research facts,
-- capture holdings/reasons, or turn a focus selection into a conclusion.
create table research_company_focus_memberships (
  membership_id text primary key,
  owner_key text not null,
  company_id text not null,
  status text not null check (status in ('active', 'removed')),
  supersedes_membership_id text,
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(supersedes_membership_id) references research_company_focus_memberships(membership_id) on delete restrict
);
create index idx_research_focus_membership_current on research_company_focus_memberships(owner_key, company_id, created_at desc, membership_id desc);

create table research_company_focus_profile_versions (
  focus_profile_id text primary key,
  company_id text not null,
  version integer not null check (version > 0),
  supersedes_focus_profile_id text,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  title text not null,
  review_by integer,
  epistemic_type text not null check (epistemic_type = 'system_judgment'),
  created_at integer not null,
  unique(company_id, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(supersedes_focus_profile_id) references research_company_focus_profile_versions(focus_profile_id) on delete restrict
);
create index idx_research_focus_profile_current on research_company_focus_profile_versions(company_id, as_of desc, version desc, created_at desc);

create table research_company_focus_profile_items (
  focus_item_id text primary key,
  focus_profile_id text not null,
  role text not null,
  target_kind text not null,
  target_id text not null,
  security_code text,
  sort_order integer not null default 0,
  created_at integer not null,
  unique(focus_profile_id, role, target_kind, target_id),
  foreign key(focus_profile_id) references research_company_focus_profile_versions(focus_profile_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_focus_profile_items_profile on research_company_focus_profile_items(focus_profile_id, role, sort_order, focus_item_id);
