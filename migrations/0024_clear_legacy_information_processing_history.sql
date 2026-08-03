-- The prior v1 information-processing history used an assertion/claim model.
-- It is intentionally discarded before the text-first v2 flow is enabled.
-- Original imported documents and their cached source content remain intact.
delete from information_processing_jobs;
delete from knowledge_view_item_claims;
delete from knowledge_view_items;
delete from knowledge_entity_views;
delete from knowledge_claim_state_history;
delete from knowledge_claim_assertions;
delete from knowledge_claims;
delete from knowledge_assertion_evidence;
delete from knowledge_assertions;
delete from knowledge_evidence_spans;
delete from knowledge_document_results;
delete from knowledge_processing_runs;
delete from knowledge_preprocessing_decisions;
delete from knowledge_entity_aliases;
delete from knowledge_entities;
delete from knowledge_document_versions;
