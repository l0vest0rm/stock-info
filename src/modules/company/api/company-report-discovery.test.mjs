import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCompanyReportUrl,
  companyReportDedupKeys,
  companyRoutes,
  COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS,
  companyReportDiscoveryTaskName,
  findCompanyReportDiscoveryRawReport,
  mergeCompanyReportsPreferPrimary,
  normalizeCompanyReportDiscoveryReasoningEffort,
  normalizeCompanyReportLlmRawResponse,
  parseCompanyReportDiscovery,
  prepareCompanyReportDiscoveryExecution,
  readStoredCompanyReportDiscovery,
  validateCompanyReportDiscoveryTerminalEvidence,
  validateCompanyReportDiscoveryWebSearch,
  writeStoredCompanyReportDiscovery,
} from "./company.routes.ts";

const citations = [
  { title: "公开研报", url: "https://reports.example.com/acme.pdf?utm_source=search#page=1" },
];

class FakeD1 {
  constructor() {
    this.kvCache = new Map();
    this.httpCache = new Map();
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      bind: (...args) => ({
        first: async () => {
          if (normalized.includes("from kv_cache")) {
            const row = this.kvCache.get(`${args[0]}|${args[1]}`) ?? null;
            if (!row) return null;
            if (args[2] != null && row.expiresAt != null && row.expiresAt <= args[2]) return null;
            return row;
          }
          if (normalized.includes("from securities")) {
            return null;
          }
          if (normalized.includes("from http_cache")) {
            return this.httpCache.get(args[0]) ?? null;
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
        run: async () => {
          if (normalized.includes("insert into kv_cache")) {
            this.kvCache.set(`${args[0]}|${args[1]}`, {
              namespace: args[0],
              key: args[1],
              valueJson: args[2],
              expiresAt: args[3],
              updatedAt: args[4],
            });
            return { success: true };
          }
          if (normalized.includes("insert into http_cache")) {
            this.httpCache.set(args[0], {
              status: args[3],
              headersJson: args[4],
              bodyText: args[5],
              expiresAt: args[6],
              updatedAt: args[7],
            });
            return { success: true };
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
        all: async () => {
          if (normalized.includes("from knowledge_docs")) return { results: [] };
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      }),
    };
  }
}

test("keeps only the exact discovery-model report object for a matching source URL", () => {
  const targetUrl = "https://stock.finance.sina.com.cn/stock/go.php/vReport_Show/kind/search/rptid/836910213940/index.phtml";
  const artifactOutput = {
    response: {
      text: JSON.stringify([
        { title: "目标研报", url: targetUrl, revenue_forecast: [327.97, 540.53, 766.89], extraModelField: "keep" },
        { title: "其他研报", url: "https://reports.example.com/other.pdf", revenue_forecast: [1, 2, 3] },
      ]),
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

test("uses a stable caller-owned discovery name without a local task id", () => {
  assert.equal(companyReportDiscoveryTaskName("000001.SZ"), "company:report-discovery:000001.SZ");
});

test("requires taskd terminal WebQA completion evidence before projecting reports", () => {
  assert.doesNotThrow(() => validateCompanyReportDiscoveryTerminalEvidence({ schemaVersion: "webqa.completion-evidence.v1", outcome: "succeeded" }));
  assert.throws(() => validateCompanyReportDiscoveryTerminalEvidence({}), /lacks terminal WebQA completion evidence/);
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

test("prepares the structured discovery prompt with the current report identity inventory", async () => {
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
        first: async () => {
          if (sql.includes("from securities")) return { name: "示例公司" };
          if (sql.includes("from kv_cache")) return {
            valueJson: JSON.stringify([{
              title: "示例公司深度报告",
              orgName: "示例证券",
              publishDate: "2026-08-09",
              url: "https://example.test/report",
              forecasts: [{ year: 2026, revenue: 10 }],
            }]),
          };
          return null;
        },
          };
        },
      };
    },
  };
  const prepared = await prepareCompanyReportDiscoveryExecution(db, "000001.SZ", "xhigh");
  assert.equal(prepared.promptVersion, "company-report-discovery.v6");
  assert.match(prepared.prompt, /证券代码：000001\.SZ/);
  assert.match(prepared.prompt, /公司名称：示例公司/);
  assert.match(prepared.prompt, /"forecasts"/);
  assert.match(prepared.prompt, /"targetPrice"/);
  assert.match(prepared.prompt, /示例公司深度报告/);
  assert.match(prepared.prompt, /示例证券/);
  assert.match(prepared.prompt, /https:\/\/example\.test\/report/);
  assert.doesNotMatch(prepared.prompt, /"forecasts":\[\{"year":2026/);
  assert.doesNotMatch(prepared.prompt, /MAX_REPORTS|最多返回报告数|\{\{MAX_REPORTS\}\}/);
});

test("materializes the source pool before discovery submission when the report cache is cold", async () => {
  const db = new FakeD1();
  const originalFetch = globalThis.fetch;
  let discoveryInput = "";
  globalThis.fetch = async (url, init) => {
    const value = String(url);
    if (value.startsWith("https://reportapi.eastmoney.com/report/list")) {
      return new Response('jQuery({"data":[{"title":"缓存尚未写入的既有研报","orgName":"示例证券","publishDate":"2026-08-10","infoCode":"EM-001"}]})');
    }
    if (value.startsWith("https://stock.finance.sina.com.cn/stock/go.php/vReport_List")) {
      return new Response("<table></table>", { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (value.startsWith("https://task.example.test/v1/namespaces/stock-info/tasks")) {
      const request = JSON.parse(String(init?.body || "{}"));
      discoveryInput = String(request.input?.input || "");
      return new Response(JSON.stringify({
        task_id: 42,
        namespace: "stock-info",
        client_task_name: "company:report-discovery:000001.SZ",
        task_type: "webqa.chatgpt.v1",
        input: request.input,
        status: "queued",
        checkpoint: null,
        result: null,
        error_message: null,
        superseded_by_task_id: null,
        created_at: 1_786_517_000_000,
        updated_at: 1_786_517_000_000,
        completed_at: null,
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${value}`);
  };

  try {
    const response = await companyRoutes.request(
      "http://example.test/company/reports/discover?code=000001.SZ",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      {
        LLM_RUNTIME: "local",
        DB: db,
        TASKD_BASE_URL: "https://task.example.test",
        TASKD_NAMESPACE: "stock-info",
        TASKD_CALLER_TOKEN: "token",
      },
    );
    assert.equal(response.status, 200);
    assert.match(discoveryInput, /缓存尚未写入的既有研报/);
    assert.doesNotMatch(discoveryInput, /KNOWN_REPORTS_JSON\s*\n\[\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("discovery capability serves a completed kv_cache snapshot without querying taskd", async () => {
  const db = new FakeD1();
  await writeStoredCompanyReportDiscovery(db, "300308.SZ", {
    report: {
      response: {
        text: JSON.stringify([{ title: "已缓存研报", url: "https://reports.example.com/cached.pdf", forecasts: [] }]),
      },
      projection: {
        securityCode: "300308.SZ",
        reportsFound: 1,
        reportsRejected: 0,
        sourceRows: 8,
        cachedAt: 1_786_517_056_000,
      },
    },
    task: {
      name: "company:report-discovery:300308.SZ",
      status: "completed",
      errorMessage: null,
      createdAt: 1_786_517_000_000,
      updatedAt: 1_786_517_056_000,
      completedAt: 1_786_517_056_000,
    },
    lastSuccessfulCompletedAt: 1_786_517_056_000,
  });

  const response = await companyRoutes.request(
    "http://example.test/company/reports/discovery-capability?code=300308.SZ",
    {},
    { LLM_RUNTIME: "local", DB: db },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data?.task?.status, "completed");
  assert.equal(payload.data?.lastSuccessfulCompletedAt, 1_786_517_056_000);
});

test("discovery capability returns enabled with no task when kv_cache has no snapshot", async () => {
  const db = new FakeD1();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("taskd should not be queried without a cached in-flight task");
  };

  try {
    const response = await companyRoutes.request(
      "http://example.test/company/reports/discovery-capability?code=603986.SH",
      {},
      { LLM_RUNTIME: "local", DB: db },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data?.enabled, true);
    assert.equal(payload.data?.task, null);
    assert.equal(payload.data?.lastSuccessfulCompletedAt, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discovery capability refreshes only pending task state from taskd and persists it", async () => {
  const db = new FakeD1();
  await writeStoredCompanyReportDiscovery(db, "603986.SH", {
    report: null,
    task: {
      name: "company:report-discovery:603986.SH",
      status: "running",
      errorMessage: null,
      createdAt: 1_786_517_000_000,
      updatedAt: 1_786_517_010_000,
      completedAt: null,
    },
    lastSuccessfulCompletedAt: null,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /by-name\/company%3Areport-discovery%3A603986\.SH$/);
    return new Response(JSON.stringify({
      task_id: 7,
      namespace: "stock-info",
      client_task_name: "company:report-discovery:603986.SH",
      task_type: "webqa.chatgpt.v1",
      input: {},
      status: "running",
      checkpoint: null,
      result: null,
      error_message: null,
      superseded_by_task_id: null,
      created_at: 1_786_517_000_000,
      updated_at: 1_786_529_418_000,
      completed_at: null,
    }), { status: 200 });
  };

  try {
    const response = await companyRoutes.request(
      "http://example.test/company/reports/discovery-capability?code=603986.SH",
      {},
      {
        LLM_RUNTIME: "local",
        DB: db,
        TASKD_BASE_URL: "https://task.example.test",
        TASKD_NAMESPACE: "stock-info",
        TASKD_CALLER_TOKEN: "token",
      },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data?.task?.status, "running");
    assert.equal(payload.data?.task?.updatedAt, 1_786_529_418_000);
    const stored = await readStoredCompanyReportDiscovery(db, "603986.SH");
    assert.equal(stored?.task?.status, "running");
    assert.equal(stored?.task?.updatedAt, 1_786_529_418_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parses cited discovery reports with the normal forecast and top-level target price fields", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify([{
    title: "公司深度研究",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf#page=1",
    forecasts: [{ year: 2026, revenue: 12.3, netProfit: 1.1, eps: 0.4, pe: 20 }],
    targetPrice: 18.5,
  }]), "000001.SZ", citations);
  assert.deepEqual(reports, [{
    title: "公司深度研究",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf",
    forecasts: [{ year: 2026, revenue: 12.3, netProfit: 1.1, eps: 0.4, pe: 20 }],
    targetPrice: 18.5,
  }]);
});

test("retains backward compatibility for legacy discovery valuation objects", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify([{
    title: "旧格式研报",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf#page=1",
    forecasts: [{ year: 2026, eps: 0.4 }],
    valuation: { rating: "买入", targetPrice: 18.5, targetPriceCurrency: "人民币", targetPe: 20, valuationMethod: "PE" },
  }]), "000001.SZ", citations);
  assert.deepEqual(reports, [{
    title: "旧格式研报",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf",
    forecasts: [{ year: 2026, eps: 0.4 }],
    targetPrice: 18.5,
    valuation: { rating: "买入", targetPrice: 18.5, targetPriceCurrency: "人民币", targetPe: 20, valuationMethod: "PE" },
  }]);
});

test("normalizes a Markdown-formatted model URL before validating its citation", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify([{
    title: "WebQA 研报",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "[报告来源](https://reports.example.com/acme.pdf?utm_source=chatgpt.com)",
    forecasts: [],
  }]), "000001.SZ", citations);
  assert.deepEqual(reports, [{
    title: "WebQA 研报",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf",
    forecasts: [],
  }]);
});

test("accepts completed Web Search candidates when citation metadata is unavailable", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify([
    { title: "缺机构", publishedAt: "2026-06-20", url: "https://reports.example.com/acme.pdf", forecasts: [] },
    { title: "无 citation", institution: "示例证券", publishedAt: "2026-06-21", url: "https://other.example.com/report.pdf", forecasts: [] },
    { title: "非网页 URL", institution: "示例证券", publishedAt: "2026-06-22", url: "javascript:alert(1)", forecasts: [] },
  ]), "000001.SZ", []);
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
  const reports = parseCompanyReportDiscovery(JSON.stringify([
    { url: "https://reports.example.com/global/acme-q2.pdf" },
    { title: "机构观点摘要" },
    { title: "", url: "" },
    { institution: "没有身份" },
  ]), "000001.SZ", []);
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
  const reports = parseCompanyReportDiscovery(JSON.stringify([{
    title: "全球机构更新",
    url: "https://reports.example.com/global-update",
    forecasts: null,
    targetPrice: null,
    publishedAt: "not-a-date",
  }]), "000001.SZ", []);
  assert.deepEqual(reports, [{
    title: "全球机构更新",
    url: "https://reports.example.com/global-update",
    forecasts: [],
  }]);
});

test("rejects a completely unidentified discovery candidate", () => {
  assert.deepEqual(parseCompanyReportDiscovery(JSON.stringify([
    { forecasts: [{ year: 2026, eps: 0.4 }] }, { institution: "示例证券", publishedAt: "2026-06-20" },
  ]), "000001.SZ", []), []);
});

test("rejects the retired object envelope", () => {
  assert.throws(
    () => parseCompanyReportDiscovery(JSON.stringify({ reports: [] }), "000001.SZ", []),
    /not a JSON array/,
  );
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
