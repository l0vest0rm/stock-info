drop index if exists idx_knowledge_docs_rank;

create index if not exists idx_knowledge_docs_time_rank
  on knowledge_docs(coalesce(event_time, published_at, fetched_at) desc, rank_score desc, doc_id desc);
