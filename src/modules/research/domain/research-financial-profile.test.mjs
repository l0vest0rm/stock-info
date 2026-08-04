import assert from "node:assert/strict";
import test from "node:test";
import { assertResearchFinancialProfileRecord, resolveResearchFinancialProfile } from "./research-financial-profile.ts";
import { appendResearchFinancialProfile } from "../application/research-financial-profile.ts";

function profile(overrides = {}) { return { financialProfileId: "profile:1", companyId: "company:1", sourceSecurityCode: "601939.SH", entityType: "bank", asOf: "2026-06-30", sourceAuthority: "issuer_disclosure", sourceUrl: "https://example.com/report", sourceTitle: "半年度报告", sourceNote: "主营业务为商业银行", recordedBy: "local-user", recordedAt: 1, createdAt: 1, ...overrides }; }

test("financial entity profile is source-bound and does not accept an unsecured URL", () => {
  assert.doesNotThrow(() => assertResearchFinancialProfileRecord(profile()));
  assert.throws(() => assertResearchFinancialProfileRecord(profile({ sourceUrl: "http://example.com/report" })), /https/);
});

test("missing company profile stays unknown and latest-date type conflict stays blocked", () => {
  assert.equal(resolveResearchFinancialProfile([]).qualityEntityType, "unknown");
  const conflict = resolveResearchFinancialProfile([profile(), profile({ financialProfileId: "profile:2", entityType: "non_financial", sourceUrl: "https://example.com/other" })]);
  assert.equal(conflict.status, "conflicting"); assert.equal(conflict.qualityEntityType, "unknown");
});

test("a sourced bank profile routes quality logic to financial without name inference", () => {
  const resolved = resolveResearchFinancialProfile([profile()]);
  assert.equal(resolved.status, "confirmed"); assert.equal(resolved.entityType, "bank"); assert.equal(resolved.qualityEntityType, "financial");
});

test("financial company profile requires a confirmed security-to-company mapping before it writes", async () => {
  const writes = [];
  const db = {
    prepare(sql) {
      return { bind(...values) {
        if (sql.includes("from research_listed_securities")) return { first: async () => null };
        return { run: async () => writes.push({ sql, values }) };
      } };
    },
  };
  await assert.rejects(() => appendResearchFinancialProfile(db, {
    financialProfileId: "profile:unconfirmed", securityCode: "601939.SH", entityType: "bank", asOf: "2026-06-30",
    sourceAuthority: "issuer_disclosure", sourceUrl: "https://example.com/report", sourceTitle: "半年度报告", sourceNote: "主营业务为商业银行", recordedAt: 1,
  }), /confirmed security-to-operating-company mapping/);
  assert.equal(writes.length, 0);
});
