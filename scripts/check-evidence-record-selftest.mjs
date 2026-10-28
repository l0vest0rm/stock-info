/**
 * Deterministic check for the watchlist evidence contract.
 * Run: node scripts/check-evidence-record-selftest.mjs
 *
 * The invariants that matter: secondary sources are refused outright, a filing
 * only verifies the security it was filed for, a quote page never verifies
 * identity, and `lastEvidenceDate` is derived rather than typed.
 */
import assert from "node:assert/strict";
import {
  canVerifyIdentity,
  evidenceCoverage,
  identityReport,
  latestEvidenceDate,
  validateEvidenceRecord,
} from "../src/modules/research/domain/evidence-record.ts";

const filing = (overrides = {}) => ({
  source: "cninfo_filing",
  kind: "primary",
  security: "600036.SH",
  documentId: "1218000001",
  title: "招商银行 2026 年半年度报告",
  publishedAt: "2026-08-22",
  url: "https://static.cninfo.com.cn/finalpage/2026-08-22/1218000001.PDF",
  ...overrides,
});

// 1. A well-formed primary filing passes.
assert.deepEqual(validateEvidenceRecord(filing()), { ok: true, problems: [] });

// 2. News is refused outright — the honest place for it is outside the array.
const news = validateEvidenceRecord(filing({ source: "issuer_ir", kind: "secondary", url: "https://news.example.com/a" }));
assert.equal(news.ok, false);
assert.ok(news.problems.includes("secondary_source_rejected"));

// 3. Every primary field is required.
for (const [patch, problem] of [
  [{ documentId: "" }, "missing_document_id"],
  [{ title: "  " }, "missing_title"],
  [{ publishedAt: "2026/08/22" }, "invalid_published_at"],
  [{ url: "http://static.cninfo.com.cn/x.pdf" }, "invalid_url"],
  [{ source: "wechat_post" }, "unknown_source"],
  [{ security: "" }, "missing_security"],
]) {
  const result = validateEvidenceRecord(filing(patch));
  assert.equal(result.ok, false, `rejects ${problem}`);
  assert.ok(result.problems.includes(problem), `reports ${problem}, got ${result.problems}`);
}

// 4. The URL must belong to the source's registry: a cninfo record pointing at
//    another host is a mislabelled source, not a valid reference.
const wrongHost = validateEvidenceRecord(filing({ url: "https://example.com/fake.pdf" }));
assert.equal(wrongHost.ok, false);
assert.ok(wrongHost.problems.includes("url_host_mismatch"));

// 5. A filing verifies only the security it was filed for.
const records = [filing()];
assert.equal(canVerifyIdentity("600036.SH", records).ok, true);
const hShare = canVerifyIdentity("03968.HK", records);
assert.equal(hShare.ok, false, "an A-share filing does not verify the H-share line");
assert.ok(hShare.problems.includes("no_evidence_for_security"));

// 6. A quote page proves the ticker trades, not which entity it is.
const quoteOnly = [{ ...filing({ source: "exchange_quote", url: "https://quote.example.com/600036" }) }];
const quoteResult = canVerifyIdentity("600036.SH", quoteOnly);
assert.equal(quoteResult.ok, false);
assert.ok(quoteResult.problems.includes("no_identity_source"));

// 7. A multi-listed company reports each line separately.
const multi = identityReport(["688981.SH", "00981.HK"], [filing({ security: "688981.SH", title: "中芯国际年报", url: "https://static.cninfo.com.cn/finalpage/2026-08-22/1218000001.PDF" })]);
assert.deepEqual(multi.map((item) => [item.security, item.verified]), [["688981.SH", true], ["00981.HK", false]]);

// 8. lastEvidenceDate is derived from valid records only.
assert.equal(latestEvidenceDate([filing(), filing({ publishedAt: "2026-09-30", documentId: "2" })]), "2026-09-30");
assert.equal(latestEvidenceDate([filing({ kind: "secondary" })]), null, "an invalid record contributes no date");
assert.equal(latestEvidenceDate([]), null);

// 9. Coverage names what is missing instead of rounding up.
const coverage = evidenceCoverage(["688981.SH", "00981.HK"], [filing({ security: "688981.SH" })]);
assert.deepEqual(coverage.covered, ["688981.SH"]);
assert.deepEqual(coverage.missing, ["00981.HK"]);
assert.equal(coverage.total, 2);

// 10. HKEX and SEC records must point at their own registries.
assert.equal(validateEvidenceRecord(filing({ source: "hkex_filing", url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0822/2026082200001.pdf" })).ok, true);
assert.equal(validateEvidenceRecord(filing({ source: "sec_filing", url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000001/x.htm" })).ok, true);
assert.equal(validateEvidenceRecord(filing({ source: "sec_filing", security: "NVDA", url: "https://www1.hkexnews.hk/x.pdf" })).ok, false);

console.log("evidence-record self-test: ok", {
  primaryOk: validateEvidenceRecord(filing()).ok,
  newsRejected: news.problems,
  multiListed: multi,
});
