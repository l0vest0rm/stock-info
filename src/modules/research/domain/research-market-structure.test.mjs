import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { assertMarketStructureFact, buildResearchMarketStructure, marketStructureProfileId } from "./research-market-structure.ts";

const source = { sourceAuthority: "exchange_rule", sourceUrl: "https://www.hkex.com.hk/Services/Trading/Securities/Overview/Trading-Mechanism", sourceTitle: "Exchange rule", sourceNote: "Official rule text", asOf: "2026-08-04", frequency: "rule_change", epistemicType: "observed_fact", effectiveFrom: null, effectiveTo: null };
const fact = (factKey, valueKind, valueNumber = null, valueText = null, unit = null, measurementBasis = null) => ({ marketStructureFactId: `fact:${factKey}`, securityCode: "00700.HK", factKey, factStatus: "verified", valueKind, valueNumber, valueText, unit, measurementBasis, createdAt: 1, ...source });

test("market structure keeps per-share and cross-security gates blocked until exact configured facts are sourced", () => {
  const incomplete = buildResearchMarketStructure({ market: "h_share", instrumentKind: "equity", facts: [fact("basic_shares", "number", 100, null, "million shares", "period_end_outstanding")] });
  assert.equal(incomplete.perShareValuation.status, "blocked");
  assert.ok(incomplete.perShareValuation.missingFactKeys.includes("diluted_shares"));
  assert.equal(incomplete.crossSecurityComparison.status, "blocked");

  const complete = buildResearchMarketStructure({ market: "h_share", instrumentKind: "equity", facts: [
    fact("basic_shares", "number", 100, null, "million shares", "period_end_outstanding"), fact("diluted_shares", "number", 101, null, "million shares", "period_end_outstanding"),
    fact("free_float", "number", 70, null, "%"), fact("investor_accessibility", "text", null, "Access terms"),
    fact("dividend_withholding_tax", "text", null, "Tax treatment"), fact("trading_hours", "text", null, "Exchange session"), fact("settlement_cycle", "text", null, "T+2"),
  ] });
  assert.equal(complete.perShareValuation.status, "ready");
  assert.equal(complete.crossSecurityComparison.status, "ready");
});

test("ADR uses its own profile and source viewpoints cannot satisfy a fact", () => {
  assert.equal(marketStructureProfileId("us_share", "adr"), "us_share:adr");
  const structure = buildResearchMarketStructure({ market: "us_share", instrumentKind: "adr", facts: [
    { ...fact("basic_shares", "number", 100, null, "million shares", "period_end_outstanding"), epistemicType: "source_viewpoint" },
  ] });
  assert.equal(structure.perShareValuation.status, "blocked");
  assert.ok(structure.perShareValuation.missingFactKeys.includes("adr_ratio"));
  assert.ok(structure.crossSecurityComparison.missingFactKeys.includes("adr_ratio"));
});

test("facts reject guessed values, absent sources and unconfigured keys", () => {
  assert.throws(() => assertMarketStructureFact({ ...fact("basic_shares", "number", null, null, "shares", "period_end_outstanding"), factStatus: "verified" }), /valueNumber/);
  assert.throws(() => assertMarketStructureFact({ ...fact("not_configured", "text", null, "x"), factKey: "not_configured" }), /not configured/);
  assert.throws(() => assertMarketStructureFact({ ...fact("trading_hours", "text", null, "x"), sourceUrl: "http://example.com/rule" }), /https/);
  assert.throws(() => assertMarketStructureFact(fact("basic_shares", "number", 100, null, "shares")), /measurementBasis/);
  assert.throws(() => assertMarketStructureFact(fact("basic_shares", "number", 100, null, "shares", "not_a_basis")), /measurementBasis/);
  assert.throws(() => assertMarketStructureFact(fact("trading_hours", "text", null, "x", null, "period_end_outstanding")), /only allowed/);
});

test("weighted-average EPS share denominators remain visible but cannot open per-share valuation", () => {
  const structure = buildResearchMarketStructure({ market: "h_share", instrumentKind: "equity", facts: [
    fact("basic_shares", "number", 100, null, "million shares", "weighted_average_eps"),
    fact("diluted_shares", "number", 101, null, "million shares", "weighted_average_eps"),
  ] });
  assert.equal(structure.requirements.find((item) => item.factKey === "basic_shares")?.state, "weighted_average_only");
  assert.equal(structure.perShareValuation.status, "blocked");
  assert.ok(structure.perShareValuation.missingFactKeys.includes("basic_shares"));
  assert.equal(structure.auditableFacts.length, 2);
});

test("requirement reason codes distinguish a missing source from a sourced record that cannot satisfy a gate", () => {
  const missing = buildResearchMarketStructure({ market: "h_share", instrumentKind: "equity", facts: [] });
  assert.equal(missing.requirements.find((item) => item.factKey === "basic_shares")?.reasonCode, "missing_source_bound_record");

  const unavailable = buildResearchMarketStructure({ market: "h_share", instrumentKind: "equity", facts: [
    { ...fact("free_float", "number", null, null, null, null), factStatus: "unavailable", valueNumber: null, sourceNote: "Issuer disclosure does not report a free-float basis." },
    { ...fact("investor_accessibility", "text", null, "Broker commentary", null, null), epistemicType: "source_viewpoint" },
    fact("basic_shares", "number", 100, null, "million shares", "weighted_average_eps"),
  ] });
  assert.equal(unavailable.requirements.find((item) => item.factKey === "free_float")?.reasonCode, "source_record_unavailable");
  assert.equal(unavailable.requirements.find((item) => item.factKey === "investor_accessibility")?.reasonCode, "source_viewpoint_not_observed_fact");
  assert.equal(unavailable.requirements.find((item) => item.factKey === "basic_shares")?.reasonCode, "weighted_average_eps_not_period_end");
});

test("official sample config only imports source-backed market observations and keeps T+1 as a regulator rule", () => {
  const samples = JSON.parse(readFileSync(resolve(process.cwd(), "config/research-market-structure-official-samples.json"), "utf8"));
  for (const item of samples.facts) assertMarketStructureFact({ ...item, measurementBasis: item.measurementBasis ?? null, createdAt: 1 });

  const byId = new Map(samples.facts.map((item) => [item.marketStructureFactId, item]));
  const babaTrading = byId.get("official-sample:BABA:trading-hours:2026-08-04");
  const babaSettlement = byId.get("official-sample:BABA:settlement-cycle:2026-08-04");
  assert.equal(babaTrading?.sourceAuthority, "exchange_rule");
  assert.match(babaTrading?.sourceUrl || "", /^https:\/\/www\.nyse\.com\//);
  assert.equal(babaSettlement?.sourceAuthority, "regulator_rule");
  assert.match(babaSettlement?.sourceUrl || "", /^https:\/\/www\.finra\.org\//);

  const chinaRailwayFacts = samples.facts.filter((item) => item.securityCode === "601390.SH");
  assert.deepEqual(chinaRailwayFacts.map((item) => item.factKey).sort(), ["basic_shares", "investor_accessibility", "price_limit", "settlement_cycle", "trading_hours"]);
  assert.ok(chinaRailwayFacts.every((item) => item.factKey !== "free_float" && item.factKey !== "dividend_withholding_tax" && item.factKey !== "diluted_shares"));
});

test("300308 official annual-report share count remains a basic period-end fact and cannot open valuation", () => {
  const samples = JSON.parse(readFileSync(resolve(process.cwd(), "config/research-market-structure-official-samples.json"), "utf8"));
  const record = samples.facts.find((item) => item.marketStructureFactId === "official:300308:basic-shares:2025-12-31:cninfo-1225056459");
  assert.deepEqual(record && {
    securityCode: record.securityCode,
    factKey: record.factKey,
    valueNumber: record.valueNumber,
    unit: record.unit,
    measurementBasis: record.measurementBasis,
    sourceAuthority: record.sourceAuthority,
  }, {
    securityCode: "300308.SZ",
    factKey: "basic_shares",
    valueNumber: 1111118334,
    unit: "A shares / RMB ordinary shares",
    measurementBasis: "period_end_outstanding",
    sourceAuthority: "issuer_disclosure",
  });
  assert.match(record?.sourceUrl ?? "", /static\.cninfo\.com\.cn\/finalpage\/2026-03-31\/1225056459\.PDF$/);

  const structure = buildResearchMarketStructure({ market: "a_share", instrumentKind: "equity", facts: [{ ...record, createdAt: 1 }] });
  assert.equal(structure.requirements.find((item) => item.factKey === "basic_shares")?.state, "verified");
  assert.equal(structure.perShareValuation.status, "blocked");
  assert.deepEqual(structure.perShareValuation.missingFactKeys, ["diluted_shares"]);
  assert.ok(structure.crossSecurityComparison.missingFactKeys.includes("diluted_shares"));
});

test("China Railway A/H source slice records only supplied share and market-rule facts", () => {
  const chinaRailwayA = buildResearchMarketStructure({
    market: "a_share",
    instrumentKind: "equity",
    facts: [
      { ...fact("basic_shares", "number", 20478895629, null, "A shares / RMB ordinary shares", "period_end_outstanding"), securityCode: "601390.SH" },
      { ...fact("trading_hours", "text", null, "SSE auction and continuous sessions"), securityCode: "601390.SH" },
      { ...fact("settlement_cycle", "text", null, "SSE pre-settlement resale rule"), securityCode: "601390.SH" },
    ],
  });
  assert.equal(chinaRailwayA.requirements.find((item) => item.factKey === "basic_shares")?.state, "verified");
  assert.equal(chinaRailwayA.perShareValuation.status, "blocked");
  assert.deepEqual(chinaRailwayA.perShareValuation.missingFactKeys, ["diluted_shares"]);
  assert.deepEqual(chinaRailwayA.crossSecurityComparison.missingFactKeys, [
    "diluted_shares", "free_float", "investor_accessibility", "dividend_withholding_tax", "price_limit",
  ]);

  const chinaRailwayH = buildResearchMarketStructure({
    market: "h_share",
    instrumentKind: "equity",
    facts: [
      { ...fact("basic_shares", "number", 4207390000, null, "H shares / overseas listed foreign shares", "period_end_outstanding"), securityCode: "00390.HK" },
      { ...fact("trading_hours", "text", null, "HKEX sessions"), securityCode: "00390.HK" },
      { ...fact("settlement_cycle", "text", null, "HKEX T+2"), securityCode: "00390.HK" },
    ],
  });
  assert.equal(chinaRailwayH.requirements.find((item) => item.factKey === "basic_shares")?.state, "verified");
  assert.equal(chinaRailwayH.perShareValuation.status, "blocked");
  assert.deepEqual(chinaRailwayH.perShareValuation.missingFactKeys, ["diluted_shares"]);
  assert.deepEqual(chinaRailwayH.crossSecurityComparison.missingFactKeys, [
    "diluted_shares", "free_float", "investor_accessibility", "dividend_withholding_tax",
  ]);
});
