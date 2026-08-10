import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCompanyReportUrl,
  companyReportDedupKeys,
  companyRoutes,
  COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS,
  findCompanyReportDiscoveryRawReport,
  mergeCompanyReportsPreferPrimary,
  normalizeCompanyReportDiscoveryReasoningEffort,
  normalizeCompanyReportLlmRawResponse,
  parseCompanyReportDiscovery,
  prepareCompanyReportDiscoveryExecution,
  validateCompanyReportDiscoveryWebSearch,
} from "./company.routes.ts";

const citations = [
  { title: "公开研报", url: "https://reports.example.com/acme.pdf?utm_source=search#page=1" },
];

test("keeps only the exact discovery-model report object for a matching source URL", () => {
  const targetUrl = "https://stock.finance.sina.com.cn/stock/go.php/vReport_Show/kind/search/rptid/836910213940/index.phtml";
  const artifactOutput = {
    response: {
      text: JSON.stringify({
        reports: [
          { title: "目标研报", url: targetUrl, revenue_forecast: [327.97, 540.53, 766.89], extraModelField: "keep" },
          { title: "其他研报", url: "https://reports.example.com/other.pdf", revenue_forecast: [1, 2, 3] },
        ],
      }),
    },
    projection: { reportsFound: 2 },
  };
  assert.deepEqual(findCompanyReportDiscoveryRawReport(artifactOutput, { code: "300476.SZ", url: `${targetUrl}#page=1` }), {
    title: "目标研报",
    url: targetUrl,
    revenue_forecast: [327.97, 540.53, 766.89],
    extraModelField: "keep",
  });
  assert.equal(findCompanyReportDiscoveryRawReport(artifactOutput, { code: "300476.SZ", url: "https://reports.example.com/other.pdf" })?.title, "其他研报");
  assert.equal(findCompanyReportDiscoveryRawReport(artifactOutput, { code: "300476.SZ", url: "https://reports.example.com/missing.pdf" }), null);
});

test("normalizes a raw forecast artifact without discarding model fields", () => {
  assert.deepEqual(normalizeCompanyReportLlmRawResponse({
    text: '{"forecasts":[],"revenue_forecast":[327.97],"rating":"买入"}',
  }), {
    forecasts: [],
    revenue_forecast: [327.97],
    rating: "买入",
  });
  assert.equal(normalizeCompanyReportLlmRawResponse({ text: "" }), null);
});

test("hides the discovery capability endpoint outside the local LLM runtime", async () => {
  const response = await companyRoutes.request(
    "http://example.test/company/reports/discovery-capability?code=000001.SZ",
    {},
    { LLM_RUNTIME: "production" },
  );
  assert.equal(response.status, 404);
});

test("projects the last run model and reasoning effort into local discovery status", async () => {
  const taskId = "llm-task:company-report-status";
  const runId = "llm-run:company-report-status";
  const taskRow = {
    taskId,
    taskType: "company_report_discovery",
    targetType: "security",
    targetId: "000001.SZ",
    idempotencyKey: "company-report-discovery:2026-08-10",
    protocolVersion: "llm-task-protocol.v1",
    promptVersion: "company-report-discovery.v3",
    status: "running",
    requestedModel: "gpt-5.6-luna",
    requestedReasoningEffort: "max",
    lastRunId: runId,
    metadataJson: "{}",
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: 1,
    startedAt: 2,
    completedAt: null,
    updatedAt: 3,
  };
  const runRow = {
    runId,
    taskId,
    attempt: 2,
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    promptVersion: "company-report-discovery.v3",
    inputFingerprint: null,
    inputAsOf: null,
    inputJson: null,
    promptJson: null,
    lineageRunId: null,
    status: "running",
    leaseOwner: "runner",
    leaseUntil: Date.now() + 60_000,
    heartbeatAt: Date.now(),
    currentStepKey: null,
    progressJson: null,
    progressUpdatedAt: null,
    terminalMetadataJson: null,
    errorCode: null,
    errorMessage: null,
    startedAt: 2,
    completedAt: null,
    updatedAt: 3,
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => sql.includes("from llm_runs") ? runRow : taskRow,
          };
        },
      };
    },
  };
  const response = await companyRoutes.request(
    `http://example.test/company/reports/discovery-capability?code=000001.SZ&taskId=${encodeURIComponent(taskId)}`,
    {},
    { LLM_RUNTIME: "local", DB: db },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload?.data?.task?.execution, {
    runId,
    attempt: 2,
    status: "running",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  });
});

test("defaults discovery to xhigh reasoning and retains the prior one-hour timeout", () => {
  assert.equal(normalizeCompanyReportDiscoveryReasoningEffort(undefined), "xhigh");
  assert.equal(COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS, 60 * 60 * 1000);
});

test("accepts explicit provider reasoning values without an enum whitelist", () => {
  assert.equal(normalizeCompanyReportDiscoveryReasoningEffort("none"), "none");
  assert.equal(normalizeCompanyReportDiscoveryReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeCompanyReportDiscoveryReasoningEffort("diagnostic-custom"), "diagnostic-custom");
  assert.throws(() => normalizeCompanyReportDiscoveryReasoningEffort(""), /must be a non-empty string/);
  assert.throws(() => normalizeCompanyReportDiscoveryReasoningEffort(null), /must be a non-empty string/);
});

test("prepares the structured discovery prompt without a report-count placeholder", async () => {
  const taskId = "llm-task:company-report-prompt";
  const taskRow = {
    taskId,
    taskType: "company_report_discovery",
    targetType: "security",
    targetId: "000001.SZ",
    idempotencyKey: "company-report-discovery:2026-08-10",
    protocolVersion: "llm-task-protocol.v1",
    promptVersion: "company-report-discovery.v3",
    status: "queued",
    requestedModel: "gpt-5.6-luna",
    requestedReasoningEffort: "max",
    metadataJson: "{}",
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => sql.includes("from securities") ? { name: "示例公司" } : taskRow,
          };
        },
      };
    },
  };
  const prepared = await prepareCompanyReportDiscoveryExecution(db, "000001.SZ", taskId);
  assert.equal(prepared.promptVersion, "company-report-discovery.v3");
  assert.match(prepared.input, /证券代码：000001\.SZ/);
  assert.match(prepared.input, /公司名称：示例公司/);
  assert.match(prepared.input, /"forecasts"/);
  assert.match(prepared.input, /"valuation"/);
  assert.doesNotMatch(prepared.input, /MAX_REPORTS|最多返回报告数|\{\{MAX_REPORTS\}\}/);
});

test("rejects only an empty reasoningEffort at the local discovery API boundary", async () => {
  const response = await companyRoutes.request(
    "http://example.test/company/reports/discover?code=300308.SZ",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoningEffort: "" }),
    },
    { LLM_RUNTIME: "local", DB: {} },
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(String(payload?.msg || ""), /must be a non-empty string/);
});

test("parses cited discovery reports with the normal forecast and valuation fields", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify({
    reports: [{
      title: "公司深度研究",
      institution: "示例证券",
      publishedAt: "2026-06-20",
      url: "https://reports.example.com/acme.pdf#page=1",
      forecasts: [{ year: 2026, revenue: 12.3, netProfit: 1.1, eps: 0.4, pe: 20 }],
      valuation: { rating: "买入", targetPrice: 18.5, targetPriceCurrency: "人民币", targetPe: 20, valuationMethod: "PE" },
    }],
  }), "000001.SZ", citations);
  assert.deepEqual(reports, [{
    title: "公司深度研究",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf",
    forecasts: [{ year: 2026, revenue: 12.3, netProfit: 1.1, eps: 0.4, pe: 20 }],
    valuation: { rating: "买入", targetPrice: 18.5, targetPriceCurrency: "人民币", targetPe: 20, valuationMethod: "PE" },
  }]);
});

test("normalizes a Markdown-formatted model URL before validating its citation", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify({
    reports: [{
      title: "WebQA 研报",
      institution: "示例证券",
      publishedAt: "2026-06-20",
      url: "[报告来源](https://reports.example.com/acme.pdf?utm_source=chatgpt.com)",
      forecasts: [],
    }],
  }), "000001.SZ", citations);
  assert.deepEqual(reports, [{
    title: "WebQA 研报",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf",
    forecasts: [],
  }]);
});

test("accepts completed Web Search candidates when citation metadata is unavailable", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify({
    reports: [
      { title: "缺机构", publishedAt: "2026-06-20", url: "https://reports.example.com/acme.pdf", forecasts: [] },
      { title: "无 citation", institution: "示例证券", publishedAt: "2026-06-21", url: "https://other.example.com/report.pdf", forecasts: [] },
      { title: "非网页 URL", institution: "示例证券", publishedAt: "2026-06-22", url: "javascript:alert(1)", forecasts: [] },
    ],
  }), "000001.SZ", []);
  assert.deepEqual(reports, [
    {
      title: "缺机构",
      publishedAt: "2026-06-20",
      url: "https://reports.example.com/acme.pdf",
      forecasts: [],
    },
    {
      title: "无 citation",
      institution: "示例证券",
      publishedAt: "2026-06-21",
      url: "https://other.example.com/report.pdf",
      forecasts: [],
    },
    {
      title: "非网页 URL",
      institution: "示例证券",
      publishedAt: "2026-06-22",
      forecasts: [],
    },
  ]);
});

test("accepts URL-only and title-only partial reports without forecasts", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify({
    reports: [
      { url: "https://reports.example.com/global/acme-q2.pdf" },
      { title: "机构观点摘要" },
      { title: "", url: "" },
      { institution: "没有身份" },
    ],
  }), "000001.SZ", []);
  assert.deepEqual(reports, [
    {
      title: "reports.example.com/global/acme-q2.pdf",
      url: "https://reports.example.com/global/acme-q2.pdf",
      forecasts: [],
    },
    {
      title: "机构观点摘要",
      forecasts: [],
    },
  ]);
});

test("keeps missing forecasts and metadata on an otherwise identified candidate", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify({
    reports: [{
      title: "全球机构更新",
      url: "https://reports.example.com/global-update",
      forecasts: null,
      valuation: null,
      publishedAt: "not-a-date",
    }],
  }), "000001.SZ", []);
  assert.deepEqual(reports, [{
    title: "全球机构更新",
    url: "https://reports.example.com/global-update",
    forecasts: [],
  }]);
});

test("rejects a completely unidentified discovery candidate", () => {
  assert.deepEqual(parseCompanyReportDiscovery(JSON.stringify({
    reports: [{ forecasts: [{ year: 2026, eps: 0.4 }] }, { institution: "示例证券", publishedAt: "2026-06-20" }],
  }), "000001.SZ", []), []);
});

test("retains a discovered row when deterministic identity fields are unavailable", () => {
  const merged = mergeCompanyReportsPreferPrimary([], [{
    code: "000001.SZ",
    title: "无日期机构的全球更新",
    forecasts: [],
    provenance: "web_search",
  }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "无日期机构的全球更新");
});

test("requires a completed Web Search response and tool call", () => {
  const base = { searched: true, queries: ["中际旭创 研报"], citations: [] };
  assert.deepEqual(
    validateCompanyReportDiscoveryWebSearch({ ...base, responseCompleted: true, responseStatus: "completed", webSearchCallCompleted: true }),
    [],
  );
  assert.throws(
    () => validateCompanyReportDiscoveryWebSearch({ ...base, responseCompleted: false, responseStatus: "in_progress", webSearchCallCompleted: false }),
    /response was incomplete/,
  );
  assert.throws(
    () => validateCompanyReportDiscoveryWebSearch({ ...base, responseCompleted: true, responseStatus: "completed", webSearchCallCompleted: false }),
    /Web Search call did not complete/,
  );
});

test("canonicalizes tracking URL variants and keeps same-title different-date reports", () => {
  assert.equal(
    canonicalCompanyReportUrl("HTTPS://Reports.Example.com/acme.pdf?utm_source=x&b=2&a=1#fragment"),
    "https://reports.example.com/acme.pdf?a=1&b=2",
  );
  const merged = mergeCompanyReportsPreferPrimary([
    { code: "000001.SZ", title: "公司深度研究", orgName: "示例证券", publishDate: "2026-06-20", url: "https://reports.example.com/acme.pdf?utm_source=x", provenance: "existing" },
  ], [
    { code: "000001.SZ", title: "公司深度研究", orgName: "示例证券", publishDate: "2026-06-20", url: "https://reports.example.com/acme.pdf#page=2", forecasts: [{ year: 2026, eps: 0.4 }], provenance: "web_search" },
    { code: "000001.SZ", title: "公司深度研究", orgName: "示例证券", publishDate: "2026-06-21", url: "https://reports.example.com/acme-2.pdf", provenance: "web_search" },
  ]);
  assert.equal(merged.length, 2);
  const duplicate = merged.find((item) => item.publishDate === "2026-06-20");
  assert.equal(duplicate?.provenance, "existing");
  assert.deepEqual(duplicate?.forecasts, [{ year: 2026, eps: 0.4 }]);
});

test("does not use title-only fallback when one date is missing", () => {
  const dated = { code: "000001.SZ", title: "同名研报", orgName: "示例证券", publishDate: "2026-06-20" };
  const undated = { code: "000001.SZ", title: "同名研报", orgName: "示例证券" };
  assert.notDeepEqual(companyReportDedupKeys(dated), companyReportDedupKeys(undated));
  assert.equal(mergeCompanyReportsPreferPrimary([dated], [undated]).length, 2);
});

test("uses code/title/institution fallback only when both dates are unavailable", () => {
  const first = { code: "000001.SZ", title: "同名研报", orgName: "示例证券" };
  const second = { code: "000001.SZ", title: "同名研报", orgName: "示例证券", forecasts: [{ year: 2027, eps: 0.5 }] };
  assert.equal(mergeCompanyReportsPreferPrimary([first], [second]).length, 1);
});
