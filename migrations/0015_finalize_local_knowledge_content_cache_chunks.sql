pragma foreign_keys = off;

drop index if exists idx_knowledge_local_content_cache_updated_at;
drop index if exists idx_knowledge_local_content_cache_chunks_content_key;

with recursive chunk_source(content_key, chunk_index, payload_base64) as (
  select c.content_key, 0, c.payload_base64
    from knowledge_local_content_cache c
   where length(c.payload_base64) > 0
     and not exists (
       select 1
         from knowledge_local_content_cache_chunks k
        where k.content_key = c.content_key
     )
  union all
  select content_key, chunk_index + 1, substr(payload_base64, 20001)
    from chunk_source
   where length(payload_base64) > 20000
)
insert into knowledge_local_content_cache_chunks (content_key, chunk_index, payload_base64)
select content_key, chunk_index, substr(payload_base64, 1, 20000)
  from chunk_source
 where length(payload_base64) > 0
on conflict(content_key, chunk_index) do update set
  payload_base64 = excluded.payload_base64;

alter table knowledge_local_content_cache rename to knowledge_local_content_cache_old;
alter table knowledge_local_content_cache_chunks rename to knowledge_local_content_cache_chunks_old;

create table knowledge_local_content_cache (
  content_key text primary key,
  content_type text not null,
  content_encoding text not null,
  content_sha256 text not null,
  content_bytes integer not null default 0,
  updated_at integer not null
);

create index idx_knowledge_local_content_cache_updated_at
  on knowledge_local_content_cache(updated_at desc);

insert into knowledge_local_content_cache (
  content_key, content_type, content_encoding, content_sha256, content_bytes, updated_at
)
select
  content_key, content_type, content_encoding, content_sha256, content_bytes, updated_at
from knowledge_local_content_cache_old;

create table knowledge_local_content_cache_chunks (
  content_key text not null,
  chunk_index integer not null,
  payload_base64 text not null,
  primary key (content_key, chunk_index),
  foreign key (content_key) references knowledge_local_content_cache(content_key) on delete cascade
);

create index idx_knowledge_local_content_cache_chunks_content_key
  on knowledge_local_content_cache_chunks(content_key, chunk_index);

insert into knowledge_local_content_cache_chunks (content_key, chunk_index, payload_base64)
select content_key, chunk_index, payload_base64
  from knowledge_local_content_cache_chunks_old;

drop table knowledge_local_content_cache_chunks_old;
drop table knowledge_local_content_cache_old;

pragma foreign_keys = on;
