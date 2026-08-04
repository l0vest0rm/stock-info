import assert from "node:assert/strict";
import test from "node:test";
import { buildFormalDisclosureCoverageMatrix } from "./formal-disclosure-coverage-matrix.ts";

const fact = (metric, overrides = {}) => ({
  id: `eastmoney:300308.SZ:income:2025-12-31:${metric}`,
  canonicalComparisonKey: `financial-comparison:v1:eastmoney:300308.SZ:income:2025-01-01:2025-12-31:${metric}:CNY-CAS-consolidated-reported`,
  metric,
  value: 100,
  period: { kind: "annual", startDate: "2025-01-01", endDate: "2025-12-31", fiscalYear: 2025 },
  basis: { id: "CNY:CAS:consolidated:reported", currency: "CNY", accountingStandard: "CAS", scope: "consolidated", revision: "reported" },
  provenance: { sourceId: "eastmoney:300308.SZ:income:2025-12-31", sourceType: "eastmoney", locator: metric },
  ...overrides,
});
const verification = (normalizedFact, overrides = {}) => ({
  verificationId: `verification:${normalizedFact.metric}`,
  provider: "cninfo",
  outcome: "match",
  normalizedFact,
  statutoryDisclosure: { provider: "cninfo", documentId: "123", disclosureUrl: "https://www.cninfo.com.cn/123", locator: normalizedFact.metric, publishedAt: "2026-03-01", reportDate: "2025-12-31", value: 100, basis: normalizedFact.basis },
  reasonCodes: [], observedAt: 200, createdAt: 200,
  ...overrides,
});

test("matrix keeps each required fact and report period visible when a primary field is missing", () => {
  const revenue = fact("revenue");
  const matrix = buildFormalDisclosureCoverageMatrix({ market: "a_share", facts: [revenue], verifications: [] });
  assert.equal(matrix.policy.primaryProvider, "eastmoney");
  assert.equal(matrix.policy.statutoryProvider, "cninfo");
  assert.equal(matrix.policy.noAutomaticFallback, true);
  assert.equal(matrix.rows.length, 5);
  const equity = matrix.rows.find((row) => row.requirement.metric === "total_equity");
  assert.equal(equity?.period?.endDate, "2025-12-31");
  assert.equal(equity?.primary.status, "missing");
  assert.deepEqual(equity?.blockers, ["primary_fact_missing_for_report_period", "statutory_verification_not_recorded"]);
});

test("matrix reports conflict, immutable observation count, and accounting revision mismatch without changing providers", () => {
  const revenue = fact("revenue");
  const first = verification(revenue, { verificationId: "verification:old", observedAt: 100, createdAt: 100 });
  const latest = verification(revenue, {
    verificationId: "verification:new", outcome: "conflict", observedAt: 200, createdAt: 200,
    reasonCodes: ["accounting_basis_or_revision_mismatch"],
    statutoryDisclosure: { ...first.statutoryDisclosure, basis: { ...revenue.basis, revision: "restated" } },
  });
  const matrix = buildFormalDisclosureCoverageMatrix({ market: "a_share", facts: [revenue], verifications: [first, latest] });
  const row = matrix.rows.find((item) => item.requirement.metric === "revenue");
  assert.equal(row?.statutory.outcome, "conflict");
  assert.equal(row?.statutory.verificationId, "verification:new");
  assert.equal(row?.statutory.observationCount, 2);
  assert.equal(row?.revisionState, "mismatch");
  assert.ok(row?.blockers.includes("statutory_conflict"));
  assert.ok(row?.blockers.includes("accounting_revision_mismatch"));
});

test("matrix does not call an unrecorded statutory check a match", () => {
  const matrix = buildFormalDisclosureCoverageMatrix({ market: "us_share", facts: [], verifications: [] });
  assert.equal(matrix.availability, "empty");
  assert.equal(matrix.policy.primaryProvider, "yahoo");
  assert.equal(matrix.policy.statutoryProvider, "sec");
  assert.equal(matrix.summary.notRecorded, 5);
  assert.ok(matrix.rows.every((row) => row.statutory.outcome === "not_recorded"));
  assert.ok(matrix.rows.every((row) => row.primary.status === "missing"));
});

test("matrix retains a structured field with no numeric value as an explicit primary-data blocker", () => {
  const shares = fact("diluted_shares", { value: null });
  const matrix = buildFormalDisclosureCoverageMatrix({ market: "a_share", facts: [shares], verifications: [] });
  const row = matrix.rows.find((item) => item.requirement.metric === "diluted_shares");
  assert.equal(row?.primary.status, "available");
  assert.ok(row?.blockers.includes("primary_fact_value_missing"));
});

test("300308 fiscalPeriod display drift retains coverage through the canonical comparison key", () => {
  const observedWhenProviderUsedNoDisplayLabel = fact("revenue", {
    id: "eastmoney:300308.SZ:income:2026-03-31:0:revenue",
    canonicalComparisonKey: "financial-comparison:v1:eastmoney:300308.SZ:income:2026-01-01:2026-03-31:revenue:CNY-CAS-consolidated-reported",
    period: { kind: "quarter", startDate: "2026-01-01", endDate: "2026-03-31", fiscalYear: 2026, fiscalQuarter: 1 },
  });
  const reloadedWithEastmoneyDisplayPeriod = fact("revenue", {
    id: "eastmoney:300308.SZ:income:2026-03-31:一季度:0:revenue",
    canonicalComparisonKey: observedWhenProviderUsedNoDisplayLabel.canonicalComparisonKey,
    period: observedWhenProviderUsedNoDisplayLabel.period,
  });
  const matrix = buildFormalDisclosureCoverageMatrix({
    market: "a_share", facts: [reloadedWithEastmoneyDisplayPeriod], verifications: [verification(observedWhenProviderUsedNoDisplayLabel)],
  });
  const row = matrix.rows.find((item) => item.requirement.metric === "revenue");
  assert.equal(row?.statutory.outcome, "match");
  assert.equal(row?.statutory.verificationId, "verification:revenue");
  assert.equal(row?.primary.facts[0]?.id, "eastmoney:300308.SZ:income:2026-03-31:一季度:0:revenue");
});
