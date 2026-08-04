import assert from "node:assert/strict";
import test from "node:test";

import {
  insertResearchCompanyIndustryExposure,
  insertResearchPeerUniverse,
  loadResearchCompanyIndustryExposures,
} from "../application/research-industry-profile.ts";
import { assertPeerMember, assertResearchIndustryRecord } from "./research-industry-profile.ts";

const sourceReferences = [{ sourceKind: "filing", documentId: "filing:annual-report" }];

test("industry tracks require versioned, source-bound research inputs", () => {
  assert.throws(() => assertResearchIndustryRecord({ asOf: 1, version: 1, epistemicType: "analysis_assumption", sourceReferences: [] }, "industry profile"), /requires at least one source reference/);
  assert.throws(() => assertResearchIndustryRecord({ asOf: 1, version: 0, epistemicType: "observed_fact", sourceReferences }, "industry profile"), /version must be a positive integer/);
  assert.doesNotThrow(() => assertResearchIndustryRecord({ asOf: 1, version: 1, epistemicType: "observed_fact", sourceReferences }, "industry profile"));
});

test("excluded peers require an explicit reason and every peer has a source", () => {
  const base = { peerMemberId: "peer:1", companyId: null, securityCode: "9988.HK", peerName: "Peer", relationshipType: "direct", membershipStatus: "excluded", comparabilityStatus: "not_comparable", exclusionReason: null, comparisonDimensions: {}, crossMarketMetadata: {}, sourceReferences, sortOrder: 0 };
  assert.throws(() => assertPeerMember(base), /exclusion reason/);
  assert.doesNotThrow(() => assertPeerMember({ ...base, exclusionReason: "收入结构不可比" }));
  assert.throws(() => assertPeerMember({ ...base, exclusionReason: "收入结构不可比", sourceReferences: [] }), /at least one source reference/);
});

test("company exposure writes are anchored to primary business and retain source references", async () => {
  const batches = [];
  const db = { prepare(sql) { return { bind(...values) { return { sql, values }; } }; }, async batch(statements) { batches.push(statements); } };
  const result = await insertResearchCompanyIndustryExposure(db, {
    exposureId: "exposure:1", companyId: "company:1", industryProfileId: "industry:cloud", asOf: 10, version: 1, status: "reviewed", selectionBasis: "primary_business", primaryBusinessDescription: "云服务是主要收入来源", exposureScope: { products: ["cloud"] }, exposureShare: { revenue: { value: 0.7, unit: "ratio", basis: "FY2025" } }, epistemicType: "observed_fact", sourceReferences, createdAt: 10, updatedAt: 10,
  });
  assert.deepEqual(result, { state: "saved", recordId: "exposure:1", reason: null });
  assert.match(batches[0][0].sql, /insert into research_company_industry_exposures/i);
  assert.ok(batches[0][0].values.includes(JSON.stringify(sourceReferences)));
});

test("peer universe retains excluded candidates and cross-market comparability metadata", async () => {
  const batches = [];
  const db = { prepare(sql) { return { bind(...values) { return { sql, values }; } }; }, async batch(statements) { batches.push(statements); } };
  await insertResearchPeerUniverse(db, {
    peerUniverseId: "peers:1", companyId: "company:1", industryProfileId: "industry:cloud", asOf: 10, version: 1, status: "reviewed", comparisonPurpose: "financial_quality", selectionCriteria: "主营业务和披露口径相近", crossMarketPolicy: { require: ["reportingCurrency", "accountingBasis", "fiscalPeriod"] }, epistemicType: "observed_fact", sourceReferences, createdAt: 10, updatedAt: 10,
    members: [{ peerMemberId: "peer:1", companyId: null, securityCode: "9988.HK", peerName: "Peer", relationshipType: "direct", membershipStatus: "excluded", comparabilityStatus: "not_comparable", exclusionReason: "收入结构不可比", comparisonDimensions: { business: "different" }, crossMarketMetadata: { reportingCurrency: "HKD", accountingBasis: "IFRS", fiscalPeriod: "Dec" }, sourceReferences, sortOrder: 0 }],
  });
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][1].sql, /insert into research_peer_universe_members/i);
  assert.ok(batches[0][1].values.includes(JSON.stringify({ reportingCurrency: "HKD", accountingBasis: "IFRS", fiscalPeriod: "Dec" })));
});

test("missing exposure storage remains visibly unavailable", async () => {
  const db = { prepare() { return { bind() { return { async all() { throw new Error("D1_ERROR: no such table: research_company_industry_exposures"); } }; } }; } };
  const result = await loadResearchCompanyIndustryExposures(db, { companyId: "company:1", asOf: 10 });
  assert.deepEqual(result, { availability: "unavailable", reason: "storage_not_initialized", items: [] });
});
