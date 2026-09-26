-- Approved existing-table rebuild: documents directly own their current records.
-- Run through the transactional migration runner after backup and writer quiescence.
-- Fail closed BEFORE changing anything if legacy provenance cannot map to a doc.
-- json() intentionally raises on the diagnostic string in an invalid database.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM knowledge_document_results x LEFT JOIN knowledge_docs d ON d.doc_id=x.version_id
  WHERE d.doc_id IS NULL OR x.result_id IS NULL
) THEN json('ABORT: orphan knowledge_document_results') ELSE 1 END;
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM knowledge_information_records r LEFT JOIN knowledge_document_results x ON x.result_id=r.result_id
  WHERE x.result_id IS NULL OR r.information_id IS NULL
) THEN json('ABORT: orphan knowledge_information_records') ELSE 1 END;
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM knowledge_docs d JOIN knowledge_document_results x ON x.version_id=d.doc_id
  WHERE NOT json_valid(d.metadata_json)
) THEN json('ABORT: invalid document metadata') ELSE 1 END;
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM knowledge_docs d JOIN knowledge_document_results x ON x.version_id=d.doc_id
  WHERE json_type(d.metadata_json,'$.informationExtraction') IS NOT NULL
) THEN json('ABORT: conflicting document extraction state') ELSE 1 END;

-- Preserve zero-record outcomes too. Unknown historical hashes/model remain null;
-- the offline backfill computes the row-set digest without inventing provenance.
UPDATE knowledge_docs AS d SET metadata_json=json_set(d.metadata_json,'$.informationExtraction',json_object(
  'storageVersion','information-records-v1','status','complete',
  'current',json_object('storageVersion','information-records-v1',
    'outcome',(SELECT outcome FROM knowledge_document_results WHERE version_id=d.doc_id),
    'completedAt',(SELECT created_at FROM knowledge_document_results WHERE version_id=d.doc_id),
    'inputFingerprint',NULL,'contentSha256',NULL,'contractVersion',NULL,'promptHash',NULL,
    'categoryCatalogHash',NULL,'candidatePolicyHash',NULL,'model',NULL,'recordsDigest',NULL,
    'recordCount',(SELECT count(*) FROM knowledge_information_records r JOIN knowledge_document_results x ON x.result_id=r.result_id WHERE x.version_id=d.doc_id),
    'categoryCandidateCount',NULL,'provenanceStatus','legacy_unverified','title',NULL,'publishedAt',NULL),
  'categoryCandidates',NULL,'lastAttempt',json('{}')))
WHERE EXISTS (SELECT 1 FROM knowledge_document_results WHERE version_id=d.doc_id);

ALTER TABLE knowledge_information_records RENAME TO knowledge_information_records_pre_0142;
CREATE TABLE knowledge_information_records (
  information_id TEXT NOT NULL PRIMARY KEY,
  doc_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_key TEXT,
  information_type TEXT NOT NULL CHECK (information_type IN ('fact','guidance','forecast','opinion','event','relationship')),
  category TEXT NOT NULL,
  period TEXT,
  statement TEXT NOT NULL,
  forecast_measurement_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(forecast_measurement_json) AND json_type(forecast_measurement_json)='object'),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (doc_id,sort_order),
  FOREIGN KEY (doc_id) REFERENCES knowledge_docs(doc_id) ON DELETE CASCADE
);

-- LEFT JOIN deliberately retains bad rows so NOT NULL/FK constraints abort,
-- rather than silently throwing away evidence through an inner join.
INSERT INTO knowledge_information_records
  (information_id,doc_id,entity,entity_key,information_type,category,period,statement,forecast_measurement_json,sort_order,created_at)
SELECT r.information_id,x.version_id,r.entity,NULL,r.information_type,r.category,r.period,r.statement,
  r.forecast_measurement_json,
  row_number() OVER (PARTITION BY x.version_id ORDER BY r.sort_order,r.information_id)-1,r.created_at
FROM knowledge_information_records_pre_0142 r LEFT JOIN knowledge_document_results x ON x.result_id=r.result_id;

SELECT CASE WHEN (SELECT count(*) FROM knowledge_information_records) !=
  (SELECT count(*) FROM knowledge_information_records_pre_0142)
  THEN json('ABORT: information row count mismatch') ELSE 1 END;

DROP TABLE knowledge_information_records_pre_0142;
DROP TABLE knowledge_document_results;
CREATE INDEX idx_knowledge_information_records_entity_key ON knowledge_information_records(entity_key,category,doc_id);
CREATE INDEX idx_knowledge_information_records_entity_category ON knowledge_information_records(entity,category,doc_id);
CREATE INDEX idx_knowledge_information_records_category_type ON knowledge_information_records(category,information_type,doc_id);
