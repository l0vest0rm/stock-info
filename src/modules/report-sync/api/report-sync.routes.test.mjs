import assert from "node:assert/strict";
import test from "node:test";
import { reportSyncRoutes } from "./report-sync.routes.ts";
import { publishCompletedReportsToProduction } from "../../../shared/remote-report-sync.ts";

function databaseCapture() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            run: async () => { writes.push({ sql, values }); return {}; },
          };
        },
      };
    },
  };
}

function investmentMarkdown() {
  return Array.from({ length: 12 }, (_, index) => `# ${index + 1}. 章节\n\n${"可核验的投资研究内容。".repeat(12)}`).join("\n\n");
}

test("production report ingress rejects unauthenticated and local requests", async () => {
  const record = { namespace: "research_investment_analysis", key: "300308.SZ", valueJson: JSON.stringify({ markdown: investmentMarkdown(), projectedAt: 1 }), expiresAt: null, updatedAt: 1 };
  const db = databaseCapture();
  const unauthorized = await reportSyncRoutes.request("http://sync.test/internal/report-sync", { method: "POST", body: JSON.stringify({ record }) }, { APP_RUNTIME: "cloudflare", REPORT_SYNC_TOKEN: "secret", DB: db });
  assert.equal(unauthorized.status, 401);
  const local = await reportSyncRoutes.request("http://sync.test/internal/report-sync", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ record }) }, { APP_RUNTIME: "node", REPORT_SYNC_TOKEN: "secret", DB: db });
  assert.equal(local.status, 404);
  assert.equal(db.writes.length, 0);
});

test("production report ingress accepts only a validated completed projection", async () => {
  const db = databaseCapture();
  const record = { namespace: "research_investment_analysis", key: "300308.SZ", valueJson: JSON.stringify({ markdown: investmentMarkdown(), projectedAt: 1 }), expiresAt: null, updatedAt: 2 };
  const response = await reportSyncRoutes.request("http://sync.test/internal/report-sync", {
    method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ record }),
  }, { APP_RUNTIME: "cloudflare", REPORT_SYNC_TOKEN: "secret", DB: db });
  assert.equal(response.status, 200);
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /insert into kv_cache/i);
  assert.deepEqual(db.writes[0].values.slice(0, 2), ["research_investment_analysis", "300308.SZ"]);
  assert.match(db.writes[0].sql, /where excluded\.updated_at >= kv_cache\.updated_at/i);
});

test("local publication transfers only a validated completed read model", async () => {
  const record = {
    namespace: "research_investment_analysis",
    key: "300308.SZ",
    valueJson: JSON.stringify({ markdown: investmentMarkdown(), projectedAt: 1 }),
    expiresAt: null,
    updatedAt: 2,
  };
  const db = {
    prepare(sql) {
      assert.match(sql, /from kv_cache where namespace in/i);
      return { bind() { return this; }, all: async () => ({ results: [record] }) };
    },
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await publishCompletedReportsToProduction({
      LLM_RUNTIME: "local", DB: db, REPORT_SYNC_TOKEN: "sync-token", PRODUCTION_REPORT_SYNC_URL: "https://tinfo.cc/api/internal/report-sync",
    });
    assert.deepEqual(result, { attempted: 1, published: 1, skipped: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://tinfo.cc/api/internal/report-sync");
    assert.equal(calls[0].init.headers.authorization, "Bearer sync-token");
    assert.deepEqual(JSON.parse(calls[0].init.body).record, record);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local publication is inert without an explicit sync secret", async () => {
  const db = { prepare: () => { throw new Error("unconfigured publication must not read local reports"); } };
  assert.deepEqual(
    await publishCompletedReportsToProduction({ LLM_RUNTIME: "local", DB: db, PRODUCTION_REPORT_SYNC_URL: "https://tinfo.cc/api/internal/report-sync" }),
    { attempted: 0, published: 0, skipped: 1 },
  );
});

test("production ingress retains the case-sensitive company source-cache key", async () => {
  const db = databaseCapture();
  const sourceKey = "company-reports-source:v5:300308.SZ";
  const record = {
    namespace: "company_reports_source",
    key: sourceKey,
    valueJson: "[]",
    expiresAt: Date.now() + 60_000,
    updatedAt: 2,
  };
  const response = await reportSyncRoutes.request("http://sync.test/internal/report-sync", {
    method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ record }),
  }, { APP_RUNTIME: "cloudflare", REPORT_SYNC_TOKEN: "secret", DB: db });
  assert.equal(response.status, 200);
  assert.equal(db.writes[0].values[1], sourceKey);
  assert.equal(db.writes[0].values[3], record.expiresAt);
});
