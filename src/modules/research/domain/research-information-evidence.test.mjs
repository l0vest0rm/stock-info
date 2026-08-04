import assert from "node:assert/strict";
import test from "node:test";

import {
  loadSourceEvidenceReference,
  refreshResearchInformationEvidenceCandidates,
  reviewResearchInformationEvidenceCandidate,
} from "../application/research-information-evidence.ts";

const sourceRecord = {
  informationId: "information:shipment:1",
  entity: "上海某公司",
  informationType: "fact",
  category: "shipment_volume",
  period: "2026Q2",
  statement: "二季度出货量同比增长。",
  resultId: "result:1",
  runId: "run:1",
  versionId: "version:1",
  contentHash: "sha256:document-content",
  docId: "document:1",
  sourceUrl: "https://source.example/research/1",
  contentUrl: "https://content.example/research/1",
  title: "出货量披露",
  sourceName: "已处理来源",
  publishedAt: "2026-08-01",
};

function refreshDb(records = [sourceRecord]) {
  const inserted = [];
  const candidateKeys = new Set();
  const queryCodes = [];
  const sourceQueries = [];
  return {
    inserted,
    queryCodes,
    sourceQueries,
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("from knowledge_information_records")) {
            sourceQueries.push(sql);
            queryCodes.push(values[0]);
            return { all: async () => ({ results: values[0] === "300308.SZ" ? records : [] }) };
          }
          if (sql.includes("insert into research_information_evidence_candidates")) {
            return {
              run: async () => {
                inserted.push({ sql, values });
                const key = [values[1], values[2], values[13], values[14]].join("|");
                const changes = candidateKeys.has(key) ? 0 : 1;
                candidateKeys.add(key);
                return { meta: { changes } };
              },
            };
          }
          throw new Error(`unexpected statement: ${sql}`);
        },
      };
    },
  };
}

function storedCandidate(securityCode = "300308.SZ") {
  return {
    candidate_id: "candidate:shipment:1", security_code: securityCode,
    information_id: sourceRecord.informationId, result_id: sourceRecord.resultId, run_id: sourceRecord.runId,
    version_id: sourceRecord.versionId, content_hash: sourceRecord.contentHash, doc_id: sourceRecord.docId,
    entity: sourceRecord.entity, information_type: sourceRecord.informationType, category: sourceRecord.category,
    period: sourceRecord.period, statement: sourceRecord.statement, target_module: "operating_driver",
    target_field: "segment_volume", required_fields_json: JSON.stringify(["operatingModelId", "operatingSegmentId", "fiscalYear"]),
    source_url: sourceRecord.sourceUrl, content_url: sourceRecord.contentUrl, title: sourceRecord.title,
    source_name: sourceRecord.sourceName, published_at: sourceRecord.publishedAt,
    mapping_config_version: "research-information-evidence-mapping.v1", created_at: 100,
  };
}

function reviewDb(candidate = storedCandidate()) {
  const batches = [];
  return {
    batches,
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("from research_information_evidence_candidates")) {
            return { first: async () => candidate };
          }
          if (sql.includes("insert into research_information_evidence_candidate_reviews") || sql.includes("insert into research_reusable_evidence_references")) {
            return { sql, values };
          }
          throw new Error(`unexpected statement: ${sql}`);
        },
      };
    },
    batch: async (statements) => { batches.push(statements); return []; },
  };
}

function sourceEvidenceRow(overrides = {}) {
  return {
    evidenceReferenceId: "reference:1", referenceCandidateId: "candidate:shipment:1", referenceCandidateReviewId: "review:accepted:1",
    referenceSecurityCode: "300308.SZ", referenceTargetModule: "operating_driver", referenceTargetField: "segment_volume", fieldStatus: "needs_field_entry",
    referenceInformationId: sourceRecord.informationId, referenceResultId: sourceRecord.resultId, referenceRunId: sourceRecord.runId,
    referenceVersionId: sourceRecord.versionId, referenceContentHash: sourceRecord.contentHash, referenceDocId: sourceRecord.docId,
    storedSourceUrl: sourceRecord.sourceUrl, storedContentUrl: sourceRecord.contentUrl, storedTitle: sourceRecord.title,
    storedSourceName: sourceRecord.sourceName, storedPublishedAt: sourceRecord.publishedAt, locator: "p.10", referenceCreatedAt: 200,
    candidateId: "candidate:shipment:1", candidateSecurityCode: "300308.SZ", candidateTargetModule: "operating_driver", candidateTargetField: "segment_volume",
    candidateInformationId: sourceRecord.informationId, candidateResultId: sourceRecord.resultId, candidateRunId: sourceRecord.runId,
    candidateVersionId: sourceRecord.versionId, candidateContentHash: sourceRecord.contentHash, candidateDocId: sourceRecord.docId,
    entity: sourceRecord.entity, informationType: sourceRecord.informationType, category: sourceRecord.category, period: sourceRecord.period, statement: sourceRecord.statement,
    acceptedReviewId: "review:accepted:1", acceptedReviewCandidateId: "candidate:shipment:1", acceptedDecision: "accepted", reviewNote: "核验通过", reviewedBy: "reviewer", reviewedAt: 199,
    latestReviewId: "review:accepted:1", latestDecision: "accepted",
    informationId: sourceRecord.informationId, informationResultId: sourceRecord.resultId,
    resultId: sourceRecord.resultId, resultRunId: sourceRecord.runId, resultVersionId: sourceRecord.versionId, outcome: "extracted",
    runId: sourceRecord.runId, runVersionId: sourceRecord.versionId, model: "local-model", returnedModel: "local-model", promptVersion: "v1", schemaVersion: "v1", ontologyVersion: "v1", inputHash: "sha256:input", runStatus: "succeeded",
    versionId: sourceRecord.versionId, versionDocId: sourceRecord.docId, versionContentHash: sourceRecord.contentHash,
    sourceUrl: sourceRecord.sourceUrl, contentUrl: sourceRecord.contentUrl, publishedAt: sourceRecord.publishedAt, documentId: sourceRecord.docId,
    title: sourceRecord.title, sourceName: sourceRecord.sourceName, currentVersionId: sourceRecord.versionId,
    ...overrides,
  };
}

function sourceEvidenceDb(row) {
  return {
    prepare(sql) {
      assert.match(sql, /from research_reusable_evidence_references reference/);
      return { bind(evidenceReferenceId) { return { first: async () => evidenceReferenceId === "reference:1" ? row : null }; } };
    },
  };
}

test("refresh uses the exact company-code mapping query and preserves the complete source chain", async () => {
  const db = refreshDb();
  const result = await refreshResearchInformationEvidenceCandidates(db, "300308.sz", 100);

  assert.deepEqual(result, { created: 1, existing: 0 });
  assert.deepEqual(db.queryCodes, ["300308.SZ"]);
  assert.match(db.sourceQueries[0], /mapping\.company_name=record\.entity and mapping\.code=\?/);
  assert.match(db.sourceQueries[0], /result\.outcome in \('extracted', 'needs_review'\)/);
  const values = db.inserted[0].values;
  assert.equal(values[1], "300308.SZ");
  assert.deepEqual(values.slice(2, 8), ["information:shipment:1", "result:1", "run:1", "version:1", "sha256:document-content", "document:1"]);
  assert.equal(values[16], sourceRecord.sourceUrl);
  assert.equal(values[17], sourceRecord.contentUrl);
  assert.equal(values[18], sourceRecord.title);
});

test("unconfigured information categories do not create research evidence candidates", async () => {
  const db = refreshDb([{ ...sourceRecord, category: "unconfigured_category" }]);
  const result = await refreshResearchInformationEvidenceCandidates(db, "300308.SZ", 100);

  assert.deepEqual(result, { created: 0, existing: 0 });
  assert.equal(db.inserted.length, 0);
});

test("a broad investment category only becomes an operating candidate after its configured completion guard matches", async () => {
  const completed = {
    ...sourceRecord,
    informationId: "information:project-completion:1",
    informationType: "event",
    category: "investment",
    statement: "高端光模块产业园三期项目已实施完毕并办理募集资金专项账户注销手续。",
  };
  const mismatched = { ...completed, informationId: "information:investment-plan:1", statement: "公司拟继续投资高端光模块产业园项目。" };

  const accepted = refreshDb([completed]);
  assert.deepEqual(await refreshResearchInformationEvidenceCandidates(accepted, "300308.SZ", 100), { created: 1, existing: 0 });
  assert.equal(accepted.inserted[0].values[13], "operating_model");
  assert.equal(accepted.inserted[0].values[14], "growth_constraint");

  const rejected = refreshDb([mismatched]);
  assert.deepEqual(await refreshResearchInformationEvidenceCandidates(rejected, "300308.SZ", 100), { created: 0, existing: 0 });
  assert.equal(rejected.inserted.length, 0);
});

test("a controlled bank specialty fact creates only a matching specialty evidence candidate", async () => {
  const bankMetric = {
    ...sourceRecord,
    informationId: "information:bank-nim:1",
    entity: "建设银行",
    category: "net_interest_margin",
    period: "2026H1",
    statement: "建设银行2026年上半年净息差为1.40%。",
  };
  const db = refreshDb([bankMetric]);
  assert.deepEqual(await refreshResearchInformationEvidenceCandidates(db, "300308.SZ", 100), { created: 1, existing: 0 });
  assert.equal(db.inserted[0].values[13], "financial_specialty");
  assert.equal(db.inserted[0].values[14], "net_interest_margin");
  assert.deepEqual(db.inserted[0].values[15], JSON.stringify(["financialProfileId", "asOf", "definitionNote", "comparabilityNote"]));
  assert.doesNotMatch(db.inserted[0].sql, /operating_model|valuation|scenario|decision/i);
});

test("refresh is idempotent and never broadens a candidate to a different security", async () => {
  const db = refreshDb();
  assert.deepEqual(await refreshResearchInformationEvidenceCandidates(db, "300308.SZ", 100), { created: 1, existing: 0 });
  assert.deepEqual(await refreshResearchInformationEvidenceCandidates(db, "300308.SZ", 101), { created: 0, existing: 1 });
  assert.deepEqual(await refreshResearchInformationEvidenceCandidates(db, "000001.SZ", 102), { created: 0, existing: 0 });
  assert.deepEqual(db.queryCodes, ["300308.SZ", "300308.SZ", "000001.SZ"]);
});

test("acceptance appends a review and creates only a reusable research_record source reference", async () => {
  const db = reviewDb();
  const accepted = await reviewResearchInformationEvidenceCandidate(db, {
    candidateReviewId: "review:accepted:1", candidateId: "candidate:shipment:1", decision: "accepted",
    reviewNote: "来源和对象已核对，仍待人工填写经营字段。", reviewedBy: "reviewer", reviewedAt: 200,
    evidenceReferenceId: "reference:1", expectedSecurityCode: "300308.SZ",
  });

  assert.equal(accepted.review.decision, "accepted");
  assert.equal(accepted.reusableEvidenceReference.fieldStatus, "needs_field_entry");
  assert.equal(accepted.reusableEvidenceReference.sourceReference.sourceKind, "research_record");
  assert.equal(accepted.reusableEvidenceReference.sourceReference.informationId, sourceRecord.informationId);
  assert.equal(accepted.reusableEvidenceReference.sourceReference.versionId, sourceRecord.versionId);
  assert.equal(accepted.reusableEvidenceReference.sourceReference.documentId, sourceRecord.docId);
  assert.match(accepted.reusableEvidenceReference.sourceReference.locator, /content_hash=sha256:document-content/);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  const writes = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(writes, /research_information_evidence_candidate_reviews/);
  assert.match(writes, /research_reusable_evidence_references/);
  assert.doesNotMatch(writes, /research_(operating|market|valuation)/);
});

test("reviews are append-only and a cross-security review is rejected before writing", async () => {
  const db = reviewDb();
  await reviewResearchInformationEvidenceCandidate(db, {
    candidateReviewId: "review:needs-evidence", candidateId: "candidate:shipment:1", decision: "needs_evidence",
    reviewNote: "需要补充原文定位。", reviewedBy: "reviewer", reviewedAt: 201, expectedSecurityCode: "300308.SZ",
  });
  await reviewResearchInformationEvidenceCandidate(db, {
    candidateReviewId: "review:rejected", candidateId: "candidate:shipment:1", decision: "rejected",
    reviewNote: "来源无法支持该字段。", reviewedBy: "reviewer", reviewedAt: 202, expectedSecurityCode: "300308.SZ",
  });
  assert.equal(db.batches.length, 2);
  assert.equal(db.batches[0][0].values[0], "review:needs-evidence");
  assert.equal(db.batches[1][0].values[0], "review:rejected");

  const wrongSecurityDb = reviewDb();
  await assert.rejects(() => reviewResearchInformationEvidenceCandidate(wrongSecurityDb, {
    candidateReviewId: "review:wrong-security", candidateId: "candidate:shipment:1", decision: "rejected",
    reviewNote: "不应跨证券审核。", reviewedBy: "reviewer", reviewedAt: 203, expectedSecurityCode: "000001.SZ",
  }), /does not belong to requested security/);
  assert.equal(wrongSecurityDb.batches.length, 0);
});

test("source evidence reader preserves eligible, revoked, superseded, and invalid provenance states", async () => {
  const eligible = await loadSourceEvidenceReference(sourceEvidenceDb(sourceEvidenceRow()), "reference:1");
  assert.deepEqual(eligible.eligibility, { status: "eligible", reasons: [] });
  assert.equal(eligible.document.currentVersionId, sourceRecord.versionId);

  const revoked = await loadSourceEvidenceReference(sourceEvidenceDb(sourceEvidenceRow({ latestReviewId: "review:rejected:2", latestDecision: "rejected" })), "reference:1");
  assert.equal(revoked.eligibility.status, "revoked");
  assert.deepEqual(revoked.eligibility.reasons, ["accepted_review_superseded", "latest_review_not_accepted"]);

  const superseded = await loadSourceEvidenceReference(sourceEvidenceDb(sourceEvidenceRow({ currentVersionId: "version:2" })), "reference:1");
  assert.deepEqual(superseded.eligibility, { status: "superseded", reasons: ["source_version_superseded"] });

  const invalid = await loadSourceEvidenceReference(sourceEvidenceDb(sourceEvidenceRow({ referenceContentHash: "sha256:tampered" })), "reference:1");
  assert.deepEqual(invalid.eligibility, { status: "invalid", reasons: ["source_chain_mismatch"] });
});
