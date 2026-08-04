-- A v3 source identity names a provider, but it does not prove which provider
-- authored a particular document version or whether the document merely carries
-- a copy.  These immutable assertions keep the document-version, origin,
-- carrier and model-lineage decisions separately auditable.
create table research_forecast_model_lineages (
  model_lineage_id text primary key,
  origin_source_identity_id text not null,
  lineage_name text not null,
  evidence_url text not null check (evidence_url like 'https://%'),
  evidence_title text not null,
  evidence_doc_id text,
  lineage_status text not null check (lineage_status in ('confirmed', 'needs_review')),
  created_by text not null,
  created_at integer not null,
  unique(origin_source_identity_id, lineage_name),
  foreign key(origin_source_identity_id) references research_forecast_source_identities(source_identity_id) on delete restrict,
  foreign key(evidence_doc_id) references knowledge_docs(doc_id) on delete restrict
);
create index idx_research_forecast_model_lineages_origin
  on research_forecast_model_lineages(origin_source_identity_id, lineage_status, lineage_name);

create table research_forecast_source_identity_assertions (
  source_identity_assertion_id text primary key,
  doc_id text not null,
  version_id text not null,
  content_hash text not null,
  carrier_source_identity_id text not null,
  origin_source_identity_id text,
  model_lineage_id text,
  carrier_relation text not null check (carrier_relation in ('original', 'republication', 'shared', 'unknown')),
  evidence_url text not null check (evidence_url like 'https://%'),
  evidence_title text not null,
  evidence_doc_id text,
  assertion_status text not null check (assertion_status in ('confirmed', 'needs_review')),
  created_by text not null,
  created_at integer not null,
  unique(doc_id, version_id),
  check ((carrier_relation = 'unknown' and origin_source_identity_id is null and model_lineage_id is null)
    or (carrier_relation in ('original', 'republication', 'shared') and origin_source_identity_id is not null and model_lineage_id is not null)),
  foreign key(doc_id) references knowledge_docs(doc_id) on delete restrict,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict,
  foreign key(carrier_source_identity_id) references research_forecast_source_identities(source_identity_id) on delete restrict,
  foreign key(origin_source_identity_id) references research_forecast_source_identities(source_identity_id) on delete restrict,
  foreign key(model_lineage_id) references research_forecast_model_lineages(model_lineage_id) on delete restrict,
  foreign key(evidence_doc_id) references knowledge_docs(doc_id) on delete restrict
);
create index idx_research_forecast_source_identity_assertions_version
  on research_forecast_source_identity_assertions(version_id, assertion_status);
create index idx_research_forecast_source_identity_assertions_origin
  on research_forecast_source_identity_assertions(origin_source_identity_id, model_lineage_id, carrier_relation);

-- An assertion is a fact about one exact imported document version, not a
-- mutable label attached to a document.  The lineage must belong to the
-- asserted origin and an "original" carrier cannot name another publisher.
create trigger validate_research_forecast_source_identity_assertion_insert
before insert on research_forecast_source_identity_assertions
begin
  select case when not exists (
    select 1 from knowledge_document_versions version
    where version.version_id = new.version_id and version.doc_id = new.doc_id and version.content_hash = new.content_hash
  ) then raise(abort, 'forecast source assertion must match exact document version and content hash') end;
  select case when new.carrier_relation = 'original' and new.carrier_source_identity_id <> new.origin_source_identity_id
    then raise(abort, 'original carrier relation requires carrier and origin to match') end;
  select case when new.model_lineage_id is not null and not exists (
    select 1 from research_forecast_model_lineages lineage
    where lineage.model_lineage_id = new.model_lineage_id
      and lineage.origin_source_identity_id = new.origin_source_identity_id
  ) then raise(abort, 'forecast model lineage must belong to asserted origin') end;
end;

-- The frozen columns are intentionally nullable for historical v3 rows.  A
-- legacy row cannot be promoted into a v4 aggregation without a fresh review.
alter table research_source_forecasts add column source_identity_assertion_id text;
alter table research_source_forecasts add column origin_source_identity_id text;
alter table research_source_forecasts add column carrier_source_identity_id text;
alter table research_source_forecasts add column carrier_relation text;
alter table research_source_forecasts add column model_lineage_id text;
alter table research_source_forecasts add column independence_group_id text;
create index idx_research_source_forecasts_assertion
  on research_source_forecasts(source_identity_assertion_id, model_lineage_id, independence_group_id);

create trigger validate_research_source_forecast_assertion_insert
before insert on research_source_forecasts
when new.source_identity_assertion_id is not null
begin
  select case when not exists (
    select 1 from research_forecast_source_identity_assertions assertion
    left join research_forecast_source_identities origin on origin.source_identity_id = assertion.origin_source_identity_id
    left join research_forecast_source_independence_groups source_group on source_group.independence_group_id = origin.independence_group_id
    where assertion.source_identity_assertion_id = new.source_identity_assertion_id
      and assertion.assertion_status = 'confirmed'
      and assertion.doc_id = new.doc_id and assertion.version_id = new.version_id
      and coalesce(assertion.origin_source_identity_id, '') = coalesce(new.origin_source_identity_id, '')
      and coalesce(assertion.carrier_source_identity_id, '') = coalesce(new.carrier_source_identity_id, '')
      and assertion.carrier_relation = new.carrier_relation
      and coalesce(assertion.model_lineage_id, '') = coalesce(new.model_lineage_id, '')
      and coalesce(origin.independence_group_id, '') = coalesce(new.independence_group_id, '')
      and coalesce(new.source_identity_id, '') = coalesce(assertion.origin_source_identity_id, '')
      and (assertion.origin_source_identity_id is null or (origin.identity_status = 'confirmed' and source_group.status = 'confirmed'))
  ) then raise(abort, 'source forecast frozen assertion fields do not match a confirmed document-version assertion') end;
end;

-- A consolidation remains a replayable historical decision even if a later
-- registry row changes.  Freeze every identity decision used by v4 here too.
alter table research_forecast_consolidation_members add column source_identity_assertion_id text;
alter table research_forecast_consolidation_members add column origin_source_identity_id text;
alter table research_forecast_consolidation_members add column carrier_source_identity_id text;
alter table research_forecast_consolidation_members add column carrier_relation text;
alter table research_forecast_consolidation_members add column model_lineage_id text;

create trigger validate_research_forecast_consolidation_member_assertion_insert
before insert on research_forecast_consolidation_members
when new.source_identity_assertion_id is not null
begin
  select case when not exists (
    select 1 from research_source_forecasts forecast
    where forecast.forecast_id = new.forecast_id
      and coalesce(forecast.source_identity_assertion_id, '') = coalesce(new.source_identity_assertion_id, '')
      and coalesce(forecast.origin_source_identity_id, '') = coalesce(new.origin_source_identity_id, '')
      and coalesce(forecast.carrier_source_identity_id, '') = coalesce(new.carrier_source_identity_id, '')
      and coalesce(forecast.carrier_relation, '') = coalesce(new.carrier_relation, '')
      and coalesce(forecast.model_lineage_id, '') = coalesce(new.model_lineage_id, '')
      and coalesce(forecast.independence_group_id, '') = coalesce(new.independence_group_id, '')
  ) then raise(abort, 'consolidation member frozen assertion fields must match source forecast') end;
end;
