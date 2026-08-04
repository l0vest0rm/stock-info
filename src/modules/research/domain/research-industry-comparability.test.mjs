import assert from "node:assert/strict";
import test from "node:test";

import {
  insertResearchCompanyTrackExposure,
  insertResearchIndustryTrackProfile,
  insertResearchPeerComparisonSet,
  loadResearchCompanyTrackExposures,
} from "../application/research-industry-comparability.ts";
import {
  assertResearchIndustryTrackProfile,
  assertResearchPeerComparisonSet,
} from "./research-industry-comparability.ts";

const sourceReferences = [{ sourceKind: "filing", documentId: "filing:annual-report", locator: "p.12" }];
const dbBatches = () => {
  const batches = [];
  return {
    batches,
    prepare(sql) { return { bind(...values) { return { sql, values }; } }; },
    async batch(statements) { batches.push(statements); },
  };
};

function profile() {
  return {
    trackProfileId: "track:networking:v1", industryKey: "networking", taxonomy: "internal", taxonomyVersion: "2026-08", industryName: "网络设备", parentIndustryKey: null,
    asOf: 10, version: 1, status: "reviewed", boundaryIncluded: "交换机和路由器", boundaryExcluded: "通用服务器", demandEquation: "端口数 × ASP", supplyEquation: "产能 × 良率", cyclePosition: "recovery", valuationPrimaryMethod: "DCF", valuationLimitations: "周期价格需要正常化", epistemicType: "observed_fact", sourceReferences, createdAt: 10, updatedAt: 10,
    demandDrivers: [{ driverId: "driver:cloud-capex", driverKind: "customer_capex", label: "云厂商资本开支", definition: "目标客户年度网络资本开支", indicatorName: "capex", indicatorFrequency: "quarterly", leadingLagging: "leading", financialTransmission: "影响设备订单和收入", sortOrder: 1, sourceReferences }],
    supplyConstraints: [{ constraintId: "constraint:asic", constraintKind: "technology", label: "ASIC 供给", description: "关键芯片交付约束", affectedVariable: "交付量", directionWhenBinding: "delays_delivery", sortOrder: 1, sourceReferences }],
    valueChainNodes: [{ valueChainNodeId: "node:customer", nodeRole: "customer", name: "云厂商", description: "采购网络设备", revenueRecognitionRole: "验收后确认收入", sortOrder: 1, sourceReferences }],
    kpis: [{ kpiId: "kpi:ports", name: "高速端口出货", definition: "当期已出货高速端口", unit: "ports", frequency: "quarterly", timingRole: "leading", financialMapping: "销量 × ASP → 收入", sortOrder: 1, sourceReferences }],
  };
}

test("field-typed track profile requires source evidence for every populated component", () => {
  const input = profile();
  input.kpis[0].sourceReferences = [];
  assert.throws(() => assertResearchIndustryTrackProfile(input), /industry kpi requires at least one source reference/);
});

test("track profile persists typed fields and normalized evidence without JSON payloads", async () => {
  const db = dbBatches();
  const result = await insertResearchIndustryTrackProfile(db, profile());
  assert.deepEqual(result, { state: "saved", recordId: "track:networking:v1", reason: null });
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /research_industry_track_demand_drivers/);
  assert.match(sql, /research_industry_comparability_evidence_refs/);
  assert.doesNotMatch(sql, /_json/i);
});

test("company exposure stores explicit business scopes and attributable shares", async () => {
  const db = dbBatches();
  const result = await insertResearchCompanyTrackExposure(db, {
    companyTrackExposureId: "exposure:1", companyId: "company:1", trackProfileId: "track:networking:v1", asOf: 10, version: 1, status: "reviewed", selectionBasis: "primary_business",
    businessSegment: "网络设备", productScope: "数据中心交换机", geographicScope: "全球", customerScope: "云服务商", exposureDescription: "主营收入来自数据中心交换机", epistemicType: "observed_fact", sourceReferences, createdAt: 10, updatedAt: 10,
    shares: [{ exposureShareId: "share:1", measure: "revenue", value: 0.7, unit: "ratio", basisPeriod: "FY2025", denominatorDescription: "合并收入", sortOrder: 1, sourceReferences }],
  });
  assert.equal(result.state, "saved");
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /research_company_track_exposure_shares/);
  assert.doesNotMatch(sql, /exposure_scope_json|exposure_share_json/i);
});

test("peer adjustment is explicit and cannot silently hide a cross-market mismatch", () => {
  const input = {
    peerComparisonSetId: "peers:1", companyId: "company:1", trackProfileId: "track:networking:v1", asOf: 10, version: 1, status: "reviewed", comparisonPurpose: "valuation_context", selectionCriteria: "产品和客户相同", epistemicType: "observed_fact", sourceReferences, createdAt: 10, updatedAt: 10,
    members: [{ peerComparisonMemberId: "peer:1", companyId: null, securityCode: "NVDA.US", peerName: "Peer", relationshipType: "benchmark", membershipStatus: "included", comparabilityStatus: "partially_comparable", exclusionReason: null, sortOrder: 1, sourceReferences,
      dimensions: [{ comparisonDimensionId: "dimension:currency", dimension: "reporting_currency", status: "adjustment_required", targetValue: "CNY", peerValue: "USD", adjustmentNote: null, sortOrder: 1, sourceReferences }],
    }],
  };
  assert.throws(() => assertResearchPeerComparisonSet(input), /adjustment note/);
  input.members[0].dimensions[0].adjustmentNote = "仅用于业务比较，不合并估值倍数";
  assert.doesNotThrow(() => assertResearchPeerComparisonSet(input));
});

test("peer comparison persists each comparability dimension and its evidence as relational rows", async () => {
  const db = dbBatches();
  const input = {
    peerComparisonSetId: "peers:2", companyId: "company:1", trackProfileId: "track:networking:v1", asOf: 10, version: 1, status: "reviewed", comparisonPurpose: "financial_quality", selectionCriteria: "同产品、同客户且财年可对齐", epistemicType: "observed_fact", sourceReferences, createdAt: 10, updatedAt: 10,
    members: [{ peerComparisonMemberId: "peer:2", companyId: null, securityCode: "NVDA.US", peerName: "Peer", relationshipType: "benchmark", membershipStatus: "included", comparabilityStatus: "partially_comparable", exclusionReason: null, sortOrder: 1, sourceReferences,
      dimensions: [{ comparisonDimensionId: "dimension:accounting", dimension: "accounting_basis", status: "adjustment_required", targetValue: "CAS", peerValue: "US GAAP", adjustmentNote: "不合并调整后利润率", sortOrder: 1, sourceReferences }],
    }],
  };
  const result = await insertResearchPeerComparisonSet(db, input);
  assert.equal(result.state, "saved");
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /research_peer_comparison_members/);
  assert.match(sql, /research_peer_comparison_dimensions/);
  assert.match(sql, /research_industry_comparability_evidence_refs/);
});

test("missing typed storage stays visibly unavailable", async () => {
  const db = { prepare() { return { bind() { return { async all() { throw new Error("D1_ERROR: no such table: research_company_track_exposures"); } }; } }; } };
  const result = await loadResearchCompanyTrackExposures(db, { companyId: "company:1", asOf: 10 });
  assert.deepEqual(result, { availability: "unavailable", reason: "storage_not_initialized", items: [] });
});
