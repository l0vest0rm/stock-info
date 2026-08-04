import assert from "node:assert/strict";
import test from "node:test";
import { classifyStatutoryDisclosureRevisionCandidate } from "../application/statutory-disclosure-revision-candidates.ts";

test("official report correction titles become review candidates while similarly dated notices do not", () => {
  const candidate = classifyStatutoryDisclosureRevisionCandidate({ registry: "cninfo", securityCode: "300308.SZ", documentId: "correction:1", title: "2025年年度报告（更正后）", publishedAt: "2026-04-17", documentUrl: "https://static.cninfo.com.cn/correction.pdf", sourceLocator: "CNINFO announcementId=correction:1" });
  assert.deepEqual(candidate && { reportPeriod: candidate.reportPeriod, signals: candidate.candidateSignals }, { reportPeriod: "2025FY", signals: ["更正后"] });
  assert.equal(classifyStatutoryDisclosureRevisionCandidate({ registry: "cninfo", securityCode: "300308.SZ", documentId: "notice:1", title: "2025年年度报告披露的提示性公告", publishedAt: "2026-04-17", documentUrl: "https://static.cninfo.com.cn/notice.pdf", sourceLocator: "CNINFO announcementId=notice:1" }), null);
  assert.equal(classifyStatutoryDisclosureRevisionCandidate({ registry: "cninfo", securityCode: "300308.SZ", documentId: "charter:1", title: "公司章程修订版", publishedAt: "2026-04-17", documentUrl: "https://static.cninfo.com.cn/charter.pdf", sourceLocator: "CNINFO announcementId=charter:1" }), null);
});
