-- Local knowledge content is stored in KNOWLEDGE_CONTENT_BUCKET (filesystem in
-- Node development, R2 in production). These tables were a duplicate SQLite
-- payload cache and must not become a second content source.
drop table if exists knowledge_local_content_cache_chunks;
drop table if exists knowledge_local_content_cache;
