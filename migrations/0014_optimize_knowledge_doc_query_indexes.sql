alter table knowledge_docs add column sort_time text not null default '';
alter table knowledge_docs add column source_name_normalized text not null default '';
alter table knowledge_docs add column target_code_normalized text not null default '';

update knowledge_docs
   set sort_time = trim(coalesce(event_time, published_at, fetched_at, '')),
       source_name_normalized = lower(trim(coalesce(source_name, ''))),
       target_code_normalized = upper(trim(coalesce(target_code, '')));

create table if not exists knowledge_doc_security_links (
  doc_id text not null,
  code text not null,
  primary key (doc_id, code),
  foreign key (doc_id) references knowledge_docs(doc_id) on delete cascade
);

delete from knowledge_doc_security_links;

insert into knowledge_doc_security_links (doc_id, code)
select doc_id, target_code_normalized
  from knowledge_docs
 where target_code_normalized != '';

insert into knowledge_doc_security_links (doc_id, code)
select d.doc_id, upper(trim(coalesce(json_extract(stock_link.value, '$.code'), '')))
  from knowledge_docs d,
       json_each(coalesce(json_extract(d.metadata_json, '$.stockLinks'), '[]')) stock_link
 where upper(trim(coalesce(json_extract(stock_link.value, '$.code'), ''))) != ''
on conflict(doc_id, code) do nothing;

drop index if exists idx_knowledge_docs_source_type;
drop index if exists idx_knowledge_docs_source_name;
drop index if exists idx_knowledge_docs_target_code;
drop index if exists idx_knowledge_docs_rank;
drop index if exists idx_knowledge_docs_time_rank;

create index idx_knowledge_docs_source_type
  on knowledge_docs(source_type, sort_time desc, rank_score desc, doc_id desc);

create index idx_knowledge_docs_source_name
  on knowledge_docs(source_name_normalized, sort_time desc, rank_score desc, doc_id desc);

create index idx_knowledge_docs_target_code
  on knowledge_docs(target_code_normalized, sort_time desc, rank_score desc, doc_id desc);

create index idx_knowledge_docs_time_rank
  on knowledge_docs(sort_time desc, rank_score desc, doc_id desc);

create index idx_knowledge_doc_security_links_code
  on knowledge_doc_security_links(code, doc_id);
