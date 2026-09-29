-- Small imported text is canonical in D1; larger content remains in R2.
alter table knowledge_docs add column inline_content text;
alter table knowledge_docs add column inline_content_sha256 text;
