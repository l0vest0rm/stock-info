import assert from "node:assert/strict";
import test from "node:test";

import { produceResearchStatutoryOperatingEvidenceCandidates } from "./research-statutory-operating-candidates.ts";

const indexedDocument = {
  registry: "cninfo", documentId: "AN202601010001", documentUrl: "https://static.cninfo.com.cn/finalpage/2026-01-01/AN202601010001.PDF",
  sourceLocator: "CNINFO announcementId=AN202601010001",
};
const informationRecord = {
  informationId: "information:capacity:1", entity: "上海某公司", informationType: "fact", category: "production_capacity",
  period: "2026Q1", statement: "上海某公司一期产能已投入运行。", resultId: "result:1", runId: "run:1", versionId: "version:1",
  contentHash: "sha256:filing", docId: "document:1", sourceUrl: indexedDocument.documentUrl, contentUrl: "https://local.test/content/1",
  title: "2025年年度报告", sourceName: "上海某公司", publishedAt: "2026-03-31", ...indexedDocument,
};

function database({ records = [informationRecord], candidateChanges = 1 } = {}) {
  const queries = [];
  const writes = [];
  return {
    queries, writes,
    prepare(sql) {
      return { bind(...values) {
        if (sql.startsWith("select registry, document_id")) {
          queries.push({ sql, values }); return { all: async () => ({ results: [indexedDocument] }) };
        }
        if (sql.includes("from research_statutory_disclosure_documents statutory")) {
          queries.push({ sql, values }); return { all: async () => ({ results: records }) };
        }
        if (sql.includes("insert into research_information_evidence_candidates")) {
          writes.push({ sql, values }); return { run: async () => ({ meta: { changes: candidateChanges } }) };
        }
        if (sql.includes("select candidate_id as candidateId from research_information_evidence_candidates")) {
          return { first: async () => ({ candidateId: "candidate:existing" }) };
        }
        if (sql.includes("insert into research_statutory_operating_candidate_provenance")) {
          writes.push({ sql, values }); return { run: async () => ({ meta: { changes: 1 } }) };
        }
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
}

test("public statutory candidate producer requires exact indexed URL and retains the full information-processing chain", async () => {
  const db = database();
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.sz", 100);

  assert.deepEqual({ created: output.created, existing: output.existing, provenanceCreated: output.provenanceCreated, rejectionReasons: output.rejectionReasons }, { created: 1, existing: 0, provenanceCreated: 1, rejectionReasons: [] });
  assert.equal(db.queries[1].values[0], "300308.SZ");
  assert.match(db.queries[1].sql, /join knowledge_docs doc on doc\.url=statutory\.document_url/);
  assert.match(db.queries[1].sql, /coalesce\(version\.source_url, doc\.url\)=statutory\.document_url/);
  assert.match(db.queries[1].sql, /result\.outcome='extracted'/);
  assert.match(db.queries[1].sql, /mapping\.company_name=record\.entity and mapping\.code=statutory\.security_code/);
  const allWrites = db.writes.map((write) => write.sql).join("\n");
  assert.match(allWrites, /research_information_evidence_candidates/);
  assert.match(allWrites, /research_statutory_operating_candidate_provenance/);
  assert.doesNotMatch(allWrites, /research_(operating_model|operating_driver|market_space|valuation)/);
  const provenance = db.writes.find((write) => write.sql.includes("research_statutory_operating_candidate_provenance")).values;
  assert.deepEqual(provenance.slice(1, 12), ["cninfo", "300308.SZ", indexedDocument.documentId, indexedDocument.documentUrl, indexedDocument.sourceLocator, "document:1", "result:1", "run:1", "version:1", "sha256:filing", 100]);
});

test("unconfigured statutory information stays absent and reports the narrow rejection reason", async () => {
  const db = database({ records: [{ ...informationRecord, category: "unconfigured_category" }] });
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.SZ", 100);
  assert.deepEqual({ created: output.created, provenanceCreated: output.provenanceCreated, rejectionReasons: output.rejectionReasons }, { created: 0, provenanceCreated: 0, rejectionReasons: ["no_configured_operating_mapping_for_statutory_records"] });
  assert.equal(db.writes.length, 0);
});

test("an existing generic candidate can receive its missing statutory authority binding without being rewritten", async () => {
  const db = database({ candidateChanges: 0 });
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.SZ", 100);
  assert.deepEqual({ created: output.created, existing: output.existing, provenanceCreated: output.provenanceCreated }, { created: 0, existing: 1, provenanceCreated: 1 });
  const provenance = db.writes.find((write) => write.sql.includes("research_statutory_operating_candidate_provenance"));
  assert.equal(provenance.values[0], "candidate:existing");
});

test("missing statutory index is visible instead of widening to arbitrary processed documents", async () => {
  const db = {
    prepare(sql) { return { bind() {
      if (sql.startsWith("select registry, document_id")) return { all: async () => ({ results: [] }) };
      throw new Error(`unexpected statement: ${sql}`);
    } }; },
  };
  const output = await produceResearchStatutoryOperatingEvidenceCandidates(db, "300308.SZ", 100);
  assert.deepEqual({ indexedDocumentCount: output.indexedDocumentCount, rejectionReasons: output.rejectionReasons }, { indexedDocumentCount: 0, rejectionReasons: ["statutory_documents_not_indexed"] });
});
