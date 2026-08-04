import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchDataRequirementCoverage } from "./research-data-requirements";

const NOW = Date.UTC(2026, 7, 4);
const recent = NOW - 3 * 86_400_000;

function signals(overrides = {}) {
  return {
    identity: { mapping: { state: "confirmed", observedAt: recent }, rights: { state: "confirmed", observedAt: recent } },
    financial: {
      primary: { state: "available", observedAt: recent, error: null },
      statutory: { state: "verified", observedAt: recent, conflictCount: 0 },
    },
    operating: { model: { state: "available", observedAt: recent } },
    industry: { evidence: { state: "available", observedAt: recent, conflictCount: 0 } },
    forecast: { samples: { state: "available", observedAt: recent } },
    valuation: { models: { state: "available", observedAt: recent, conflictCount: 0 } },
    governance: { records: { state: "available", observedAt: recent } },
    risk: { review: { state: "available", observedAt: recent, conflictCount: 0 } },
    market: { kline: { state: "available", observedAt: recent, error: null } },
    ...overrides,
  };
}

test("fact requirement dictionary exposes provenance, frequency, epistemic type and missing impact without a completion score", () => {
  const coverage = buildResearchDataRequirementCoverage({ asOf: NOW, signals: signals() });
  assert.equal(coverage.ruleVersion, "research-data-requirements.v1");
  assert.equal("completionRate" in coverage, false);
  const financial = coverage.requirements.find((item) => item.requirementId === "statutory_financial_cross_check");
  assert.equal(financial?.status, "available");
  assert.equal(financial?.epistemicType, "observed_fact");
  assert.match(financial?.frequency || "", /财报期/);
  assert.ok(financial?.primarySources.length);
  assert.ok(financial?.crossSources.length);
  assert.match(financial?.missingImpact || "", /估值/);
});

test("recorded conflicts and source errors outrank nominal presence, while stale data remains distinct from missing", () => {
  const conflict = buildResearchDataRequirementCoverage({ asOf: NOW, signals: signals({
    financial: { primary: { state: "available", observedAt: recent }, statutory: { state: "verified", observedAt: recent, conflictCount: 1 } },
  }) });
  assert.equal(conflict.requirements.find((item) => item.requirementId === "statutory_financial_cross_check")?.status, "conflict");
  assert.equal(conflict.sourceHealth.find((item) => item.sourceId === "financial_statutory")?.status, "conflict");

  const sourceError = buildResearchDataRequirementCoverage({ asOf: NOW, signals: signals({
    financial: { primary: { state: "source_error", observedAt: recent, error: "timeout" }, statutory: { state: "verified", observedAt: recent, conflictCount: 0 } },
  }) });
  assert.equal(sourceError.requirements.find((item) => item.requirementId === "formal_financial_statements")?.status, "source_error");

  const stale = buildResearchDataRequirementCoverage({ asOf: NOW, signals: signals({
    market: { kline: { state: "available", observedAt: NOW - 12 * 86_400_000 } },
  }) });
  assert.equal(stale.requirements.find((item) => item.requirementId === "market_price_context")?.status, "stale");

  const missing = buildResearchDataRequirementCoverage({ asOf: NOW, signals: signals({
    governance: { records: { state: "missing", observedAt: null } },
  }) });
  assert.equal(missing.requirements.find((item) => item.requirementId === "governance_and_capital_allocation")?.status, "missing");
});
