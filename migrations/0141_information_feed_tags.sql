-- Reuse the shared tag table. Legacy knowledge tags retain their defaults;
-- feed tags are namespaced company:/theme: and carry their own contract data.
alter table knowledge_doc_tags add column weight integer not null default 0;
alter table knowledge_doc_tags add column tagging_input_fingerprint text;
alter table knowledge_doc_tags add column contract_version text;

create index if not exists idx_knowledge_docs_feed_sort
  on knowledge_docs(json_extract(metadata_json, '$.feed.version'), sort_time desc, doc_id desc);
