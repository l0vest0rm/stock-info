import assert from "node:assert/strict";
import test from "node:test";
import {
  assertResearchFinancialSpecialtyFactVersion,
  resolveResearchFinancialSpecialtyLedger,
} from "./research-financial-specialty-metrics.ts";
import { recordResearchFinancialSpecialtyFact } from "../application/research-financial-specialty-metrics.ts";

function profile(overrides = {}) { return { availability: "available", status: "confirmed", entityType: "bank", qualityEntityType: "financial", asOf: "2026-06-30", reason: "confirmed", records: [], ...overrides }; }
function fact(overrides = {}) { return {
  financialSpecialtyFactId: "specialty:1", financialProfileId: "profile:bank", companyId: "company:1", securityCode: "601939.SH",
  evidenceReferenceId: "evidence:1", candidateId: "candidate:1", candidateReviewId: "review:1", entityType: "bank", metricKey: "net_interest_margin",
  reportedLabel: "净利息收益率", reportedValue: "1.40%", valueNumber: 1.4, unit: "%", currency: null, amountScale: null, asOf: "2026-06-30", periodLabel: "2026年上半年", definitionNote: "按平均生息资产年化，集团口径。", comparabilityNote: "仅记录来源披露，尚未与其他银行比较。", statement: "净息差为1.40%。", sourceUrl: "https://example.com/filing", contentUrl: null, sourceTitle: "半年报", sourceName: "发行人", publishedAt: "2026-08-01", sourceLocator: "information_id=i1", metricConfigVersion: "research-financial-specialty-metrics.v1", recordedBy: "local-user", recordedAt: 1, createdAt: 1, ...overrides,
}; }

test("bank specialty fact requires the configured normalized unit and financial profile source chain", () => {
  assert.doesNotThrow(() => assertResearchFinancialSpecialtyFactVersion(fact()));
  assert.throws(() => assertResearchFinancialSpecialtyFactVersion(fact({ unit: "bp" })), /unit/);
  assert.throws(() => assertResearchFinancialSpecialtyFactVersion(fact({ currency: "CNY" })), /cannot carry currency/);
  assert.throws(() => assertResearchFinancialSpecialtyFactVersion(fact({ metricKey: "combined_ratio" })), /incompatible/);
});

test("unknown or conflicting entity profile blocks specialty dictionary instead of guessing", () => {
  const unknown = resolveResearchFinancialSpecialtyLedger(profile({ status: "unknown", entityType: null }), [fact()]);
  const conflict = resolveResearchFinancialSpecialtyLedger(profile({ status: "conflicting", entityType: null }), [fact()]);
  assert.equal(unknown.status, "blocked_entity_profile"); assert.equal(unknown.metrics.length, 0);
  assert.equal(conflict.status, "blocked_entity_profile");
});

test("non-financial and unconfigured financial-other profiles show not-applicable rather than industrial fallback", () => {
  assert.equal(resolveResearchFinancialSpecialtyLedger(profile({ entityType: "non_financial" }), []).status, "not_applicable");
  assert.equal(resolveResearchFinancialSpecialtyLedger(profile({ entityType: "financial_other" }), []).status, "not_applicable");
});

test("latest-date disagreement stays conflicting and no source wins by insertion time", () => {
  const ledger = resolveResearchFinancialSpecialtyLedger(profile(), [fact(), fact({ financialSpecialtyFactId: "specialty:2", valueNumber: 1.5, reportedValue: "1.50%", recordedAt: 999, createdAt: 999 })]);
  const nim = ledger.metrics.find((item) => item.metricKey === "net_interest_margin");
  assert.equal(ledger.status, "conflicting"); assert.equal(nim?.state, "conflicting"); assert.equal(nim?.fact, null);
});

test("an amount metric requires reported currency and scale and remains only a sourced observation", () => {
  const amount = fact({ entityType: "broker", metricKey: "assets_under_management", reportedLabel: "资产管理规模", reportedValue: "1,200亿元", valueNumber: 1200, unit: "reported_currency", currency: "CNY", amountScale: "亿元", definitionNote: "期末受托资产管理规模，集团口径。" });
  assert.doesNotThrow(() => assertResearchFinancialSpecialtyFactVersion(amount));
  assert.throws(() => assertResearchFinancialSpecialtyFactVersion({ ...amount, amountScale: null }), /amountScale/);
});

function specialtyDb({ accepted = true, currentProfile = true, targetModule = "financial_specialty", targetField = "net_interest_margin", scopeCompanyId = "company:1", profileCompanyId = "company:1" } = {}) {
  const inserts = [];
  return { inserts, prepare(sql) { return { bind(...values) {
    if (sql.includes("from research_reusable_evidence_references")) return { first: async () => accepted ? { evidenceReferenceId: "evidence:1", candidateId: "candidate:1", candidateReviewId: "review:1", securityCode: "601939.SH", statement: "披露净息差为1.40%。", targetModule, targetField, sourceUrl: "https://example.com/filing", contentUrl: null, sourceTitle: "半年报", sourceName: "发行人", publishedAt: "2026-08-01", sourceLocator: "information_id=i1", reviewDecision: "accepted" } : null };
    if (sql.includes("from research_company_financial_profiles")) return { all: async () => ({ results: currentProfile ? [{ financialProfileId: "profile:bank", companyId: profileCompanyId, sourceSecurityCode: "601939.SH", entityType: "bank", asOf: "2026-06-30", sourceAuthority: "issuer_disclosure", sourceUrl: "https://example.com/profile", sourceTitle: "半年报", sourceNote: "商业银行", recordedBy: "local-user", recordedAt: 1, createdAt: 1 }] : [] }) };
    if (sql.includes("from research_auto_filing_financial_profiles")) return { all: async () => ({ results: [] }) };
    if (sql.includes("from research_listed_securities")) return { first: async () => scopeCompanyId ? { securityCode: "601939.SH", companyId: scopeCompanyId } : null };
    if (sql.includes("insert into research_financial_specialty_fact_versions")) return { run: async () => { inserts.push({ sql, values }); return { meta: { changes: 1 } }; } };
    throw new Error(`unexpected statement: ${sql}`);
  } }; } };
}

test("specialty source fact is pinned to accepted evidence and current confirmed profile, never a model", async () => {
  const db = specialtyDb();
  const result = await recordResearchFinancialSpecialtyFact(db, { expectedSecurityCode: "601939.SH", financialSpecialtyFactId: "specialty:write", financialProfileId: "profile:bank", evidenceReferenceId: "evidence:1", metricKey: "net_interest_margin", reportedLabel: "净息差", reportedValue: "1.40%", valueNumber: 1.4, unit: "%", asOf: "2026-06-30", periodLabel: "2026年上半年", definitionNote: "按平均生息资产年化，集团口径。", comparabilityNote: "未与其他主体或期间合并。", recordedBy: "local-user", recordedAt: 100 });
  assert.equal(result.entityType, "bank"); assert.equal(db.inserts.length, 1);
  assert.match(db.inserts[0].sql, /research_financial_specialty_fact_versions/);
  assert.doesNotMatch(db.inserts[0].sql, /operating_model|valuation|scenario|decision/i);
  assert.equal(db.inserts[0].values[4], "evidence:1"); assert.equal(db.inserts[0].values[1], "profile:bank");
});

test("specialty fact rejects missing evidence or a profile that is not current and confirmed", async () => {
  const input = { expectedSecurityCode: "601939.SH", financialProfileId: "profile:bank", evidenceReferenceId: "evidence:1", metricKey: "net_interest_margin", reportedLabel: "净息差", reportedValue: "1.40%", valueNumber: 1.4, unit: "%", asOf: "2026-06-30", periodLabel: "2026年上半年", definitionNote: "按平均生息资产年化，集团口径。", comparabilityNote: "未与其他主体或期间合并。", recordedAt: 100 };
  await assert.rejects(() => recordResearchFinancialSpecialtyFact(specialtyDb({ accepted: false }), input), /accepted reusable evidence/);
  await assert.rejects(() => recordResearchFinancialSpecialtyFact(specialtyDb({ currentProfile: false }), input), /confirmed bank, insurer, or broker/);
});

test("specialty fact rejects an accepted evidence reference for another target", async () => {
  const input = { expectedSecurityCode: "601939.SH", financialProfileId: "profile:bank", evidenceReferenceId: "evidence:1", metricKey: "net_interest_margin", reportedLabel: "净息差", reportedValue: "1.40%", valueNumber: 1.4, unit: "%", asOf: "2026-06-30", periodLabel: "2026年上半年", definitionNote: "按平均生息资产年化，集团口径。", comparabilityNote: "未与其他主体或期间合并。", recordedAt: 100 };
  await assert.rejects(() => recordResearchFinancialSpecialtyFact(specialtyDb({ targetModule: "operating_driver", targetField: "segment_volume" }), input), /must match the requested financial specialty metric/);
  await assert.rejects(() => recordResearchFinancialSpecialtyFact(specialtyDb({ targetField: "non_performing_loan_ratio" }), input), /must match the requested financial specialty metric/);
});

test("specialty fact rejects an unconfirmed security or a profile from another company before it writes", async () => {
  const input = { expectedSecurityCode: "601939.SH", financialProfileId: "profile:bank", evidenceReferenceId: "evidence:1", metricKey: "net_interest_margin", reportedLabel: "净息差", reportedValue: "1.40%", valueNumber: 1.4, unit: "%", asOf: "2026-06-30", periodLabel: "2026年上半年", definitionNote: "按平均生息资产年化，集团口径。", comparabilityNote: "未与其他主体或期间合并。", recordedAt: 100 };
  const unconfirmed = specialtyDb({ scopeCompanyId: null });
  await assert.rejects(() => recordResearchFinancialSpecialtyFact(unconfirmed, input), /confirmed security-to-operating-company mapping/);
  assert.equal(unconfirmed.inserts.length, 0);
  const crossCompany = specialtyDb({ scopeCompanyId: "company:2", profileCompanyId: "company:1" });
  await assert.rejects(() => recordResearchFinancialSpecialtyFact(crossCompany, input), /profile company does not match/);
  assert.equal(crossCompany.inserts.length, 0);
});
