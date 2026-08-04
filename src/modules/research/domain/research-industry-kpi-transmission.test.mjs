import assert from "node:assert/strict";
import test from "node:test";
import { projectIndustryKpiDriverTransmission } from "./research-industry-kpi-transmission.ts";
import { insertResearchIndustryKpiDriverBinding } from "../application/research-industry-kpi-transmission.ts";

const refs = [{ sourceKind: "filing", documentId: "filing:annual" }];
const plan = {
  operatingDriverPlanId: "plan:1", operatingModelId: "model:1", scenarioName: "base", asOf: 100, version: 1, status: "reviewed",
  valuationCurrency: "CNY", amountScale: "CNY million", openingRevenue: 100, openingNetWorkingCapital: 10, epistemicType: "analysis_assumption", sourceReferences: refs, createdAt: 100, updatedAt: 100,
  years: [{ operatingDriverPlanYearId: "year:2027", fiscalYear: 2027, taxRate: .25, forecastNetDebt: 20, sortOrder: 1, sourceReferences: refs, segments: [{ operatingDriverSegmentYearId: "driver:2027:segment:1", operatingSegmentId: "segment:1", volume: 50, pricePerUnit: 2, grossMargin: .5, operatingExpenseMargin: .2, depreciationAmortizationMargin: .04, capitalExpenditureMargin: .05, netWorkingCapitalToRevenue: .1, sortOrder: 1, sourceReferences: refs }] }],
};
const valuation = { wacc: .1, terminalGrowth: .03, netDebtAtValuation: 5, dilutedShares: 10, sourceReferences: refs, netDebtSourceReferences: refs, dilutedSharesSourceReferences: refs };
function binding(overrides = {}) { return {
  industryKpiDriverBindingId: "binding:volume", securityCode: "300308.SZ", evidenceReferenceId: "evidence:1", companyTrackExposureId: "exposure:1", industryKpiId: "kpi:shipments", industryKpiName: "shipments", operatingDriverPlanId: "plan:1", operatingDriverSegmentYearId: "driver:2027:segment:1", transmissionRuleId: "direct-segment-volume.v1", mappingConfigVersion: "research-industry-kpi-transmission.v1", inputValue: 60, inputUnit: "ports", mappingNote: "researcher verified the KPI unit and maps it to this segment's FY2027 volume", mappedBy: "local-user", mappedAt: 101, createdAt: 101, sourceReference: { sourceKind: "research_record", sourceId: "evidence:1", informationId: "information:1", versionId: "version:1", documentId: "doc:1", locator: "immutable locator" }, ...overrides,
}; }

test("an explicit accepted KPI binding deterministically replaces only its configured driver field", () => {
  const result = projectIndustryKpiDriverTransmission(plan, [binding()], valuation);
  assert.equal(result.state, "ready");
  assert.equal(result.effectiveDriverPlan.years[0].segments[0].volume, 60);
  assert.equal(result.effectiveDriverPlan.years[0].segments[0].pricePerUnit, 2);
  assert.equal(result.coverage.find((item) => item.field === "volume").state, "bound");
  assert.equal(result.coverage.find((item) => item.field === "pricePerUnit").state, "plan_value");
  assert.equal(result.valuationProjection.annuals[0].revenue, 120);
});

test("a second immutable binding for the same plan field blocks projection rather than picking a source", () => {
  const result = projectIndustryKpiDriverTransmission(plan, [binding(), binding({ industryKpiDriverBindingId: "binding:volume:2", evidenceReferenceId: "evidence:2", mappedAt: 102 })], valuation);
  assert.equal(result.state, "blocked");
  assert.equal(result.valuationProjection, null);
  assert.match(result.reason, /conflicting immutable/);
});

test("the projection rejects a binding aimed at a different driver plan or a non-existent segment", () => {
  assert.throws(() => projectIndustryKpiDriverTransmission(plan, [binding({ operatingDriverPlanId: "plan:other" })], valuation), /does not belong to driver plan/);
  assert.throws(() => projectIndustryKpiDriverTransmission(plan, [binding({ operatingDriverSegmentYearId: "driver:missing" })], valuation), /does not belong to driver plan segment/);
});

test("binding persistence verifies the accepted-evidence/confirmed-security/company/KPI/plan join and never writes a driver plan", async () => {
  const writes = [];
  const db = { prepare(sql) { return { bind(...values) {
    if (sql.includes("from research_reusable_evidence_references evidence")) {
      assert.match(sql, /join research_listed_securities security on security\.security_code=evidence\.security_code/);
      assert.match(sql, /security\.company_id=exposure\.company_id and security\.mapping_status='confirmed'/);
      return { async first() { return { targetModule: "operating_driver", targetField: "segment_volume", industryKpiName: "shipments", informationId: "information:1", versionId: "version:1", documentId: "doc:1", sourceUrl: "https://source.example/1", contentUrl: null, title: "source", sourceName: "source-name", publishedAt: "2026-01-01", locator: "immutable locator" }; } };
    }
    if (sql.includes("insert into research_industry_kpi_driver_bindings")) return { async run() { writes.push({ sql, values }); return { meta: { changes: 1 } }; } };
    throw new Error(`unexpected statement: ${sql}`);
  } }; } };
  const saved = await insertResearchIndustryKpiDriverBinding(db, binding());
  assert.equal(saved.sourceReference.informationId, "information:1");
  assert.equal(saved.mappingConfigVersion, "research-industry-kpi-transmission.v1");
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /research_industry_kpi_driver_bindings/);
  assert.doesNotMatch(writes[0].sql, /update\s+research_operating_driver_plans/i);
});

test("binding persistence rejects accepted evidence when its security is not confirmed for the target company", async () => {
  const db = { prepare(sql) { return { bind() {
    if (sql.includes("from research_reusable_evidence_references evidence")) return { async first() { return null; } };
    throw new Error("insert must not occur for an unrelated security");
  } }; } };
  await assert.rejects(() => insertResearchIndustryKpiDriverBinding(db, binding()), /confirmed security of the matching company/);
});

test("a binding cannot use a configured price rule for a volume evidence candidate", async () => {
  const db = { prepare(sql) { return { bind() {
    if (sql.includes("from research_reusable_evidence_references evidence")) return { async first() { return { targetModule: "operating_driver", targetField: "segment_volume", industryKpiName: "shipments", informationId: "information:1", versionId: "version:1", documentId: "doc:1", sourceUrl: null, contentUrl: null, title: "source", sourceName: "source", publishedAt: null, locator: "immutable locator" }; } };
    throw new Error("insert must not occur for an invalid configured rule");
  } }; } };
  await assert.rejects(() => insertResearchIndustryKpiDriverBinding(db, binding({ transmissionRuleId: "direct-segment-price.v1" })), /does not match the accepted evidence target/);
});
