import assert from "node:assert/strict";
import test from "node:test";

import { assertResearchOperatingSourceFact } from "./research-operating-source-facts.ts";
import {
  loadResearchOperatingSourceFacts,
  recordResearchOperatingSourceFact,
} from "../application/research-operating-source-facts.ts";

function fact(patch = {}) {
  return {
    operatingSourceFactId: "operating-source-fact:1", operatingCompanyId: "company:300308", sourceSecurityCode: "300308.SZ",
    evidenceReferenceId: "evidence:shipment:1", candidateId: "candidate:shipment:1", candidateReviewId: "review:shipment:1",
    targetModule: "operating_driver", targetField: "segment_volume", factKind: "segment_volume", subjectLabel: "光模块出货量",
    segmentLabel: "光通信", customerOrChannel: null, periodLabel: "2026Q2", periodKind: "historical", reportedValue: "100 万只",
    numericValue: 100, unit: "万只", currency: null, amountScale: null, scopeDescription: "披露口径仅覆盖光通信分部。",
    comparabilityNote: "与上一季度需确认产品结构一致。", statement: "公司披露 2026Q2 光模块出货量为 100 万只。",
    informationType: "fact", mappingConfigVersion: "research-operating-source-facts.v1", recordedBy: "reviewer", recordedAt: 100, createdAt: 100,
    ...patch,
  };
}

test("operating source facts require a compatible accepted-evidence field schema", () => {
  assert.doesNotThrow(() => assertResearchOperatingSourceFact(fact()));
  assert.throws(() => assertResearchOperatingSourceFact(fact({ unit: null })), /requires a unit/);
  assert.throws(() => assertResearchOperatingSourceFact(fact({ factKind: "contract_commitment" })), /incompatible/);
  assert.throws(() => assertResearchOperatingSourceFact(fact({ targetField: "market_share_bridge" })), /not approved/);
});

function writeDb({ evidence = true, companyMatch = true } = {}) {
  const inserts = [];
  return {
    inserts,
    prepare(sql) {
      return { bind(...values) {
        if (sql.includes("from research_reusable_evidence_references")) {
          assert.match(sql, /join research_listed_securities security on security\.security_code=reference\.security_code/);
          assert.match(sql, /security\.company_id=\? and security\.mapping_status='confirmed'/);
          return { first: async () => evidence && companyMatch ? {
          securityCode: "300308.SZ", candidateId: "candidate:shipment:1", candidateReviewId: "review:shipment:1",
          targetModule: "operating_driver", targetField: "segment_volume", informationType: "fact", statement: "来源账本中的原始出货量表述。", decision: "accepted",
          } : null };
        }
        if (sql.includes("insert into research_operating_source_facts")) return { run: async () => { inserts.push({ sql, values }); return { meta: { changes: 1 } }; } };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
}

test("recording a fieldized operating fact pins the accepted evidence and never writes a model", async () => {
  const db = writeDb();
  const input = fact();
  const result = await recordResearchOperatingSourceFact(db, { ...input, expectedSecurityCode: "300308.SZ" });
  assert.deepEqual(result, { state: "saved", operatingSourceFactId: input.operatingSourceFactId, reason: null });
  assert.equal(db.inserts.length, 1);
  const sql = db.inserts[0].sql;
  assert.match(sql, /research_operating_source_facts/);
  assert.doesNotMatch(sql, /research_operating_models_typed|research_operating_driver_plans|valuation/);
  assert.equal(db.inserts[0].values[3], input.evidenceReferenceId);
  assert.equal(db.inserts[0].values[6], "segment_volume");
  assert.equal(db.inserts[0].values[19], "来源账本中的原始出货量表述。");
});

test("a missing or nonaccepted reusable reference rejects fact writes before insertion", async () => {
  const db = writeDb({ evidence: false });
  await assert.rejects(() => recordResearchOperatingSourceFact(db, { ...fact(), expectedSecurityCode: "300308.SZ" }), /accepted reusable evidence reference/);
  assert.equal(db.inserts.length, 0);
});

test("an accepted evidence reference from another or unresolved company cannot create an operating fact", async () => {
  const db = writeDb({ companyMatch: false });
  await assert.rejects(() => recordResearchOperatingSourceFact(db, { ...fact(), expectedSecurityCode: "300308.SZ" }), /confirmed security of the requested operating company/);
  assert.equal(db.inserts.length, 0);
});

test("facts are loaded by operating company but retain the source security", async () => {
  const source = fact();
  const db = { prepare(sql) { return { bind(...values) {
    assert.match(sql, /where fact\.operating_company_id=\?/);
    assert.deepEqual(values, ["company:300308", 200]);
    return { all: async () => ({ results: [{
      operating_source_fact_id: source.operatingSourceFactId, operating_company_id: source.operatingCompanyId, source_security_code: source.sourceSecurityCode,
      evidence_reference_id: source.evidenceReferenceId, candidate_id: source.candidateId, candidate_review_id: source.candidateReviewId,
      fact_kind: source.factKind, subject_label: source.subjectLabel, segment_label: source.segmentLabel, customer_or_channel: source.customerOrChannel,
      period_label: source.periodLabel, period_kind: source.periodKind, reported_value: source.reportedValue, numeric_value: source.numericValue,
      unit: source.unit, currency: source.currency, amount_scale: source.amountScale, scope_description: source.scopeDescription,
      comparability_note: source.comparabilityNote, statement: source.statement, information_type: source.informationType,
      mapping_config_version: source.mappingConfigVersion, recorded_by: source.recordedBy, recorded_at: source.recordedAt, created_at: source.createdAt,
      targetModule: source.targetModule, targetField: source.targetField,
      sourceUrl: "https://source.example/statutory.pdf", sourceTitle: "法定披露", sourcePublishedAt: "2026-08-01",
    }] }) };
  } }; } };
  const result = await loadResearchOperatingSourceFacts(db, { operatingCompanyId: "company:300308" });
  assert.equal(result.availability, "available");
  assert.equal(result.items[0].sourceSecurityCode, "300308.SZ");
  assert.equal(result.items[0].targetField, "segment_volume");
  assert.equal(result.items[0].sourceUrl, "https://source.example/statutory.pdf");
  assert.equal(result.items[0].sourceTitle, "法定披露");
});
