create table if not exists knowledge_local_content_cache_chunks (
  content_key text not null,
  chunk_index integer not null,
  payload_base64 text not null,
  primary key (content_key, chunk_index),
  foreign key (content_key) references knowledge_local_content_cache(content_key) on delete cascade
);

create index if not exists idx_knowledge_local_content_cache_chunks_content_key
  on knowledge_local_content_cache_chunks(content_key, chunk_index);
