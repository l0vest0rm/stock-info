import assert from "node:assert/strict";
import test from "node:test";

import { buildRelativeValuationLedger } from "./relative-valuation-ledger";
import { createResearchRelativeValuationLedger } from "../application/relative-valuation-ledger";

const refs = [{ sourceKind: "filing", documentId: "filing:annual", locator: "p.10" }];
const gateKinds = ["accounting_basis", "fiscal_period", "currency", "business_scope", "cycle_position", "security_rights"];
const gates = () => gateKinds.map((gateKind) => ({ gateId: `gate:${gateKind}`, gateKind, status: "passed", rationale: `${gateKind} reviewed`, sourceReferences: refs }));

function ledger() {
  return {
    ledgerId: "relative:target:2026", companyId: "company:target", securityCode: "TARGET.US", asOf: 100, createdAt: 101,
    status: "draft", role: "primary", archetype: "growth_earnings", method: "forward_pe", peerUniverseId: "peers:target:v1",
    valuationCurrency: "USD", securityCurrency: "USD", applicabilityRationale: "盈利和增长是主要估值驱动，PE 只作为有条件的相对比较。",
    rationaleSourceReferences: refs, supersedesLedgerId: null,
    inputs: [
      { inputId: "input:target:price", subjectKind: "target", peerMemberId: null, inputKind: "source_fact", key: "target_price", label: "目标价", value: 200, unit: "USD/share", currency: "USD", amountScale: "per share", fiscalYear: null, periodLabel: "valuation date", asOf: 100, epistemicType: "observed_fact", sourceReferences: refs },
      { inputId: "input:target:eps", subjectKind: "target", peerMemberId: null, inputKind: "forward_input", key: "target_fy2027_eps", label: "FY2027 EPS", value: 20, unit: "USD/share", currency: "USD", amountScale: "per share", fiscalYear: 2027, periodLabel: "FY2027E", asOf: 100, epistemicType: "third_party_forecast", sourceReferences: refs },
      { inputId: "input:peer:price", subjectKind: "peer", peerMemberId: "peer:nvda", inputKind: "source_fact", key: "peer_price", label: "同行价", value: 180, unit: "USD/share", currency: "USD", amountScale: "per share", fiscalYear: null, periodLabel: "valuation date", asOf: 100, epistemicType: "observed_fact", sourceReferences: refs },
      { inputId: "input:peer:eps", subjectKind: "peer", peerMemberId: "peer:nvda", inputKind: "forward_input", key: "peer_fy2027_eps", label: "同行 FY2027 EPS", value: 15, unit: "USD/share", currency: "USD", amountScale: "per share", fiscalYear: 2027, periodLabel: "FY2027E", asOf: 100, epistemicType: "third_party_forecast", sourceReferences: refs },
    ],
    metrics: [
      { metricId: "metric:target:pe", subjectKind: "target", peerMemberId: null, metricType: "pe", periodBasis: "forward", fiscalYear: 2027, definition: "valuation-date price / FY2027E diluted EPS", numeratorInputId: "input:target:price", denominatorInputId: "input:target:eps", displayUnit: "x" },
      { metricId: "metric:peer:pe", subjectKind: "peer", peerMemberId: "peer:nvda", metricType: "pe", periodBasis: "forward", fiscalYear: 2027, definition: "valuation-date price / FY2027E diluted EPS", numeratorInputId: "input:peer:price", denominatorInputId: "input:peer:eps", displayUnit: "x" },
    ],
    comparabilityGates: gates(),
  };
}

test("relative valuation freezes primary/auxiliary rationale, source-bound inputs and deterministic multiples", () => {
  const result = buildRelativeValuationLedger(ledger());
  assert.equal(result.readiness.status, "ready");
  assert.equal(result.metrics.find((item) => item.metricId === "metric:target:pe").value, 10);
  assert.equal(result.metrics.find((item) => item.metricId === "metric:peer:pe").value, 12);
  assert.equal(result.role, "primary");
});

test("two peers may retain the same semantic input key without being collapsed", () => {
  const input = ledger();
  input.inputs.push(
    { ...input.inputs.find((item) => item.inputId === "input:peer:price"), inputId: "input:peer2:price", peerMemberId: "peer:amd" },
    { ...input.inputs.find((item) => item.inputId === "input:peer:eps"), inputId: "input:peer2:eps", peerMemberId: "peer:amd", value: 10 },
  );
  input.metrics.push({ metricId: "metric:peer2:pe", subjectKind: "peer", peerMemberId: "peer:amd", metricType: "pe", periodBasis: "forward", fiscalYear: 2027, definition: "valuation-date price / FY2027E diluted EPS", numeratorInputId: "input:peer2:price", denominatorInputId: "input:peer2:eps", displayUnit: "x" });
  const result = buildRelativeValuationLedger(input);
  assert.equal(result.metrics.find((item) => item.metricId === "metric:peer2:pe").value, 18);
});

test("all six comparability gates are mandatory and unresolved gates block a direct comparison", () => {
  const incomplete = ledger(); incomplete.comparabilityGates.pop();
  assert.throws(() => buildRelativeValuationLedger(incomplete), /requires all comparability gates/);
  const blocked = ledger(); blocked.comparabilityGates.find((item) => item.gateKind === "security_rights").status = "not_assessed";
  const result = buildRelativeValuationLedger(blocked);
  assert.equal(result.readiness.status, "blocked");
  assert.equal(result.readiness.blockedReasons[0].code, "comparability_security_rights_not_assessed");
});

test("relative ratios cannot silently mix currencies or use non-forward denominators", () => {
  const wrongCurrency = ledger(); wrongCurrency.inputs.find((item) => item.inputId === "input:peer:eps").currency = "HKD";
  assert.throws(() => buildRelativeValuationLedger(wrongCurrency), /different currencies/);
  const nonForward = ledger(); nonForward.inputs.find((item) => item.inputId === "input:peer:eps").inputKind = "source_fact"; nonForward.inputs.find((item) => item.inputId === "input:peer:eps").fiscalYear = null; nonForward.inputs.find((item) => item.inputId === "input:peer:eps").epistemicType = "observed_fact";
  assert.throws(() => buildRelativeValuationLedger(nonForward), /forward-year denominator/);
});

test("relative valuation storage persists source inputs, replayable metrics and gates as separate immutable rows", async () => {
  const batches = [];
  const db = { prepare(sql) { return { bind(...values) { return { sql, values }; } }; }, async batch(statements) { batches.push(statements); } };
  const result = await createResearchRelativeValuationLedger(db, ledger());
  assert.deepEqual(result, { state: "saved", recordId: "relative:target:2026", reason: null });
  const sql = batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /research_relative_valuation_inputs/);
  assert.match(sql, /research_relative_valuation_metrics/);
  assert.match(sql, /research_relative_valuation_comparability_gates/);
  assert.doesNotMatch(sql, /peer average|target price|consensus/i);
});

test("missing relative-valuation storage is a visible unavailable state", async () => {
  const db = { prepare() { return { bind() { return { async all() { throw new Error("D1_ERROR: no such table: research_relative_valuation_ledgers"); } }; } }; } };
  const { loadResearchRelativeValuationLedgers } = await import("../application/relative-valuation-ledger");
  const result = await loadResearchRelativeValuationLedgers(db, { securityCode: "TARGET.US", asOf: 100 });
  assert.deepEqual(result, { availability: "unavailable", reason: "storage_not_initialized", items: [] });
});
