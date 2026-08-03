-- v2 information organization stores the reader-facing result as text.  The
-- earlier JSON/assertion columns and tables remain for historical compatibility,
-- but new runs do not use them as the semantic data model.
alter table knowledge_document_results add column primary_subjects_text text not null default '';
alter table knowledge_document_results add column organization_text text not null default '';
alter table knowledge_document_results add column evidence_text text not null default '';
alter table knowledge_document_results add column industry_topics_json text not null default '[]';
alter table knowledge_document_results add column information_nature text;

create index if not exists idx_knowledge_document_results_organization on knowledge_document_results(created_at desc);
