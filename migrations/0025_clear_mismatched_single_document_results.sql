-- Five local results were produced while the v3 code still referenced the
-- generated prompt containing historical-comparison instructions. They are
-- discarded so every future result follows the single-document contract.
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
