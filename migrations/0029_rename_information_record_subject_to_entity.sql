-- The record's concrete object is named entity.  This avoids the ambiguity of
-- “subject” as either a grammatical subject or an article topic.
drop index if exists idx_knowledge_information_records_subject_category;
alter table knowledge_information_records rename column subject to entity;
create index idx_knowledge_information_records_entity_category on knowledge_information_records(entity, category);
