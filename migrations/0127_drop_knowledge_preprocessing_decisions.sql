-- Preprocessing is deterministic and only needed while a document is being
-- prepared. Do not retain an independent decision history or skip ledger.
drop table knowledge_preprocessing_decisions;
