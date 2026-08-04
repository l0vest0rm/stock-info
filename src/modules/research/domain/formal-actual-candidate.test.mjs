import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  materializeFormalActualCandidate,
  materializeFormalActualCandidates,
  loadFormalActualCandidates,
  reviewFormalActualCandidate,
  resolveModelReviewItem,
} from "../application/formal-actual-candidates";
import { recordFinancialStatutoryVerification } from "../application/financial-statutory-verification";
import {
  FORMAL_FINANCIAL_FACT_DICTIONARY,
  FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION,
} from "./formal-actual-candidate";

const basis = { id: "ifrs-consolidated-v1", currency: "HKD", accountingStandard: "IFRS", scope: "consolidated", revision: "original" };

function verification(metric) {
  return {
    verificationId: `verification:${metric}`, ruleVersion: "financial-statutory-verification.v1", securityCode: "00700.HK", provider: "hkex", outcome: "match",
    normalizedFact: {
      id: `eastmoney:00700.HK:${metric}`, metric, value: 100, basis,
      canonicalComparisonKey: `financial-comparison:v1:eastmoney:00700.HK:income:2025-01-01:2025-12-31:${metric}:ifrs-consolidated-v1`,
      period: { kind: "annual", startDate: "2025-01-01", endDate: "2025-12-31", fiscalYear: 2025 },
      provenance: { sourceId: "eastmoney:statement", sourceType: "financial_statement" },
    },
    statutoryDisclosure: {
      provider: "hkex", documentId: "hkex:annual:2025", disclosureUrl: "https://www1.hkexnews.hk/example.pdf",
      locator: "p. 20, Consolidated statement", publishedAt: "2026-03-20", reportDate: "2025-12-31", value: 100, basis,
    },
    metadata: {},
  };
}

test("formal fact dictionary exposes only source-forecast-comparable statement facts", () => {
  assert.deepEqual(FORMAL_FINANCIAL_FACT_DICTIONARY.map((entry) => entry.sourceMetric), ["revenue", "net_profit", "operating_cash_flow"]);
  const profit = materializeFormalActualCandidate(verification("net_profit"), 100);
  assert.equal(profit.factDictionaryEntryId, "formal-financial-fact:net-profit");
  assert.equal(profit.factDictionaryVersion, FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION);
  assert.equal(profit.forecastMetric, "net_profit");
  assert.equal(profit.eligibility, "ready_for_review");

  const grossProfit = materializeFormalActualCandidate(verification("gross_profit"), 100);
  assert.equal(grossProfit.eligibility, "blocked");
  assert.equal(grossProfit.blockingReason, "metric_requires_explicit_dictionary_mapping");
});

test("candidate freezes statutory verification, dictionary and period provenance", () => {
  const candidate = materializeFormalActualCandidate(verification("revenue"), 100);
  assert.equal(candidate.canonicalComparisonKey, "financial-comparison:v1:eastmoney:00700.HK:income:2025-01-01:2025-12-31:revenue:ifrs-consolidated-v1");
  assert.deepEqual(candidate.sourceBinding, {
    sourceKind: "financial_statutory_verification",
    verificationId: "verification:revenue",
    verificationRuleVersion: "financial-statutory-verification.v1",
    normalizedFactId: "eastmoney:00700.HK:revenue",
    canonicalComparisonKey: "financial-comparison:v1:eastmoney:00700.HK:income:2025-01-01:2025-12-31:revenue:ifrs-consolidated-v1",
    sourceMetric: "revenue",
    fiscalYear: 2025,
    periodStartDate: "2025-01-01",
    periodEndDate: "2025-12-31",
    statutoryProvider: "hkex",
    statutoryDocumentId: "hkex:annual:2025",
    statutoryPublishedAt: "2026-03-20",
    factDictionaryEntryId: "formal-financial-fact:revenue",
    factDictionaryVersion: FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION,
    knowledgeLedgerBinding: { status: "not_bound_to_knowledge_ledger" },
  });
});

test("candidate materialization executes its INSERT against SQLite and does not accept an actual or write a model", async () => {
  const { db, sqlite } = localD1ForFormalActualCandidates();
  await recordFinancialStatutoryVerification(db, {
    verificationId: "verification:sqlite-revenue", securityCode: "00700.HK", observedAt: 100, createdAt: 101,
    normalizedFact: {
      id: "eastmoney:00700.HK:income:2025-12-31:annual:0:revenue",
      canonicalComparisonKey: "financial-comparison:v1:eastmoney:00700.HK:income:2025-01-01:2025-12-31:revenue:HKD-IFRS-consolidated-original",
      metric: "revenue", value: 100, basis,
      period: { kind: "annual", startDate: "2025-01-01", endDate: "2025-12-31", fiscalYear: 2025 },
      provenance: { sourceId: "eastmoney:00700.HK:income:2025-12-31", sourceType: "eastmoney", locator: "TOTAL_OPERATE_INCOME" },
    },
    statutoryDisclosure: {
      provider: "hkex", documentId: "hkex:2025", disclosureUrl: "https://www1.hkexnews.hk/2025.pdf",
      locator: "p.20/revenue", publishedAt: "2026-03-20", reportDate: "2025-12-31", value: 100, basis,
    },
  });
  await recordFinancialStatutoryVerification(db, {
    verificationId: "verification:sqlite-blocked", securityCode: "00700.HK", observedAt: 100, createdAt: 101,
    normalizedFact: {
      id: "eastmoney:00700.HK:income:2025-12-31:annual:0:gross_profit",
      canonicalComparisonKey: "financial-comparison:v1:eastmoney:00700.HK:income:2025-01-01:2025-12-31:gross_profit:HKD-IFRS-consolidated-original",
      metric: "gross_profit", value: 50, basis,
      period: { kind: "annual", startDate: "2025-01-01", endDate: "2025-12-31", fiscalYear: 2025 },
      provenance: { sourceId: "eastmoney:00700.HK:income:2025-12-31", sourceType: "eastmoney", locator: "GROSS_PROFIT" },
    },
    // An unavailable statutory extraction is immutable health evidence. It
    // must be counted by the scan but never become a review candidate.
    statutoryDisclosure: null,
  });

  const result = await materializeFormalActualCandidates(db, ["00700.HK"], 102);
  assert.deepEqual({ createdCount: result.createdCount, readyForReviewCount: result.readyForReviewCount, blockedCount: result.blockedCount }, {
    createdCount: 1, readyForReviewCount: 1, blockedCount: 1,
  });
  assert.deepEqual(result.blockedByReason, [{ reason: "statutory_unverified", count: 1 }]);
  const replay = await materializeFormalActualCandidates(db, ["00700.HK"], 103);
  assert.deepEqual({ createdCount: replay.createdCount, existingCount: replay.existingCount, readyForReviewCount: replay.readyForReviewCount, blockedCount: replay.blockedCount }, {
    createdCount: 0, existingCount: 1, readyForReviewCount: 1, blockedCount: 1,
  });
  const candidate = sqlite.prepare(`select verification_id, canonical_comparison_key, eligibility, blocking_reason
    from research_formal_actual_candidates where verification_id='verification:sqlite-revenue'`).get();
  assert.deepEqual({ ...candidate }, {
    verification_id: "verification:sqlite-revenue",
    canonical_comparison_key: "financial-comparison:v1:eastmoney:00700.HK:income:2025-01-01:2025-12-31:revenue:HKD-IFRS-consolidated-original",
    eligibility: "ready_for_review",
    blocking_reason: null,
  });
  assert.equal(sqlite.prepare("select count(*) as count from research_formal_actual_candidate_dictionary_bindings").get().count, 1);
  assert.equal(sqlite.prepare("select count(*) as count from research_formal_actual_candidates where verification_id='verification:sqlite-blocked'").get().count, 0);
  assert.deepEqual((await loadFormalActualCandidates(db, "00700.HK")).map((item) => item.verificationId), ["verification:sqlite-revenue"]);
  sqlite.prepare(`insert into research_formal_actual_candidates (
    candidate_id, security_code, verification_id, canonical_comparison_key, metric, forecast_metric, fiscal_year, fiscal_period,
    period_start_date, period_end_date, reported_value, reported_unit, currency, statutory_provider,
    statutory_document_id, statutory_disclosure_url, statutory_locator, statutory_published_at, statutory_report_date,
    source_binding_json, candidate_rule_version, eligibility, blocking_reason, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("candidate:legacy-blocked", "00700.HK", "verification:legacy-blocked", null, "revenue", "revenue", 2025, "2025FY",
      "2025-01-01", "2025-12-31", null, null, null, "hkex", null, null, null, null, null,
      "{}", "formal-actual-candidate.v2", "blocked", "statutory_unverified", 102);
  await assert.rejects(() => reviewFormalActualCandidate(db, "00700.HK", {
    reviewId: "review:legacy-blocked", candidateId: "candidate:legacy-blocked", decision: "needs_evidence", reviewer: "local-user", reason: "not reviewable",
  }), /not eligible for review/);
  assert.equal(sqlite.prepare("select count(*) as count from sqlite_master where name in ('research_formal_actuals', 'research_model_review_items')").get().count, 0);
  sqlite.close();
});

test("conflict, unverified, incomplete basis and invalid period stay blocked with explicit reasons", () => {
  const conflict = verification("revenue"); conflict.outcome = "conflict";
  assert.equal(materializeFormalActualCandidate(conflict, 100).blockingReason, "statutory_conflict");

  const unverified = verification("revenue"); unverified.outcome = "unverified";
  assert.equal(materializeFormalActualCandidate(unverified, 100).blockingReason, "statutory_unverified");

  const incompleteBasis = verification("revenue"); incompleteBasis.statutoryDisclosure.basis = { ...basis, revision: "" };
  assert.equal(materializeFormalActualCandidate(incompleteBasis, 100).blockingReason, "statutory_basis_incomplete");

  const invalidPeriod = verification("revenue"); invalidPeriod.normalizedFact.period.startDate = "not-a-date";
  assert.equal(materializeFormalActualCandidate(invalidPeriod, 100).blockingReason, "normalized_period_invalid");
});

test("an older candidate cannot enter the actual ledger when a later statutory document is already materialized", async () => {
  const storedCandidate = {
    candidate_id: "candidate:old", security_code: "00700.HK", verification_id: "verification:old", metric: "revenue",
    forecast_metric: "revenue", fact_dictionary_entry_id: "formal-financial-fact:revenue",
    fact_dictionary_version: FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION, fiscal_year: 2025, fiscal_period: "2025FY",
    period_start_date: "2025-01-01", period_end_date: "2025-12-31", reported_value: 100, reported_unit: "currency",
    currency: "HKD", statutory_provider: "hkex", statutory_document_id: "hkex:original", statutory_disclosure_url: "https://www1.hkexnews.hk/original.pdf",
    statutory_locator: "p.20 revenue", statutory_published_at: "2026-03-20", statutory_report_date: "2025-12-31",
    source_binding_json: "{}", candidate_rule_version: "formal-actual-candidate.v2", eligibility: "ready_for_review", blocking_reason: null, created_at: 100,
  };
  const db = {
    prepare(sql) {
      return { bind() {
        if (sql.includes("where c.candidate_id")) return { first: async () => storedCandidate };
        if (sql.includes("statutory_published_at>?")) return { first: async () => ({ candidateId: "candidate:amended", statutoryDocumentId: "hkex:amended", statutoryPublishedAt: "2026-05-01" }) };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
  await assert.rejects(() => reviewFormalActualCandidate(db, "00700.HK", {
    reviewId: "review:old", candidateId: "candidate:old", decision: "accepted", reviewer: "local-user", reason: "checked",
    accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified", reviewedAt: 200,
  }), /older than a later statutory document/);
});

test("model review resolution appends an audit action and never writes a model version", async () => {
  const statements = [];
  const item = {
    review_item_id: "review:1", security_code: "00700.HK", trigger_kind: "actual_restatement", trigger_id: "actual:2",
    target_kind: "dcf", target_version_id: "dcf:1", state: "resolved", reason: "review", evidence_json: "{}", created_at: 10,
    reviewed_at: 20, resolution_note: "rebuilt as dcf:2",
  };
  const db = {
    prepare(sql) {
      statements.push(sql);
      return {
        bind() {
          if (sql.startsWith("select state")) return { first: async () => ({ state: "open" }) };
          if (sql.startsWith("select * from research_model_review_items")) return { all: async () => ({ results: [item] }) };
          return { run: async () => ({ meta: { changes: 1 } }) };
        },
      };
    },
    batch: async () => [{ success: true }, { success: true }],
  };
  const saved = await resolveModelReviewItem(db, "00700.HK", "review:1", {
    actionId: "action:1", state: "resolved", resolutionNote: "rebuilt as dcf:2", actedBy: "local-user",
    followUpTargetKind: "dcf", followUpTargetVersionId: "dcf:2", reviewedAt: 20,
  });
  assert.equal(saved.state, "resolved");
  assert.ok(statements.some((sql) => sql.includes("research_model_review_item_actions")));
  assert.ok(!statements.some((sql) => /update research_(valuation_model_versions|reverse_dcf|forecast_scenarios)/.test(sql)));
});

function localD1ForFormalActualCandidates() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    create table research_financial_statutory_verifications (
      verification_id text primary key, security_code text, normalized_fact_id text, canonical_comparison_key text,
      metric text, period_kind text, period_start_date text, period_end_date text, fiscal_year integer, fiscal_quarter integer,
      normalized_value real, normalized_basis_id text, normalized_currency text, normalized_accounting_standard text,
      normalized_scope text, normalized_revision text, primary_source_id text, primary_source_type text,
      primary_document_id text, primary_source_url text, primary_locator text, primary_published_at text,
      statutory_provider text, outcome text, statutory_value real, statutory_basis_id text, statutory_currency text,
      statutory_accounting_standard text, statutory_scope text, statutory_revision text, statutory_document_id text,
      statutory_disclosure_url text, statutory_locator text, statutory_published_at text, statutory_report_date text,
      comparison_rule_version text, absolute_tolerance real, relative_tolerance real, absolute_delta real, relative_delta real,
      reason_codes_json text, metadata_json text, observed_at integer, created_at integer
    );
    create table research_formal_actual_candidates (
      candidate_id text primary key, security_code text, verification_id text unique, canonical_comparison_key text,
      metric text, forecast_metric text, fiscal_year integer, fiscal_period text, period_start_date text, period_end_date text,
      reported_value real, reported_unit text, currency text, statutory_provider text, statutory_document_id text,
      statutory_disclosure_url text, statutory_locator text, statutory_published_at text, statutory_report_date text,
      source_binding_json text, candidate_rule_version text, eligibility text, blocking_reason text, created_at integer
    );
    create table research_formal_actual_candidate_dictionary_bindings (
      candidate_id text primary key, fact_dictionary_entry_id text, fact_dictionary_version text, bound_at integer
    );
  `);
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            run: async () => {
              const result = sqlite.prepare(sql).run(...values);
              return { success: true, meta: { changes: Number(result.changes) } };
            },
            first: async () => sqlite.prepare(sql).get(...values) ?? null,
            all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
          };
        },
      };
    },
  };
  return { db, sqlite };
}
