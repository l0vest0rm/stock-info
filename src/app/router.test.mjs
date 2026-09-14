import assert from "node:assert/strict";
import test from "node:test";
import pages from "../../config/page-manifest.json" with { type: "json" };
import { createRouter } from "./router.ts";

test("one page manifest enforces local-only pages before asset access", async () => {
  const app = createRouter();
  for (const runtime of ["node", "cloudflare"]) {
    for (const page of pages.filter((entry) => entry.runtime === "local")) {
      let served = 0;
      const env = { APP_RUNTIME: runtime, LLM_RUNTIME: runtime === "node" ? "local" : "production", ASSETS: { fetch: async () => { served += 1; return new Response("local page"); } } };
      const response = await app.request(page.path, {}, env);
      assert.equal(response.status, runtime === "node" ? 200 : 404, `${runtime} ${page.path}`);
      assert.equal(served, runtime === "node" ? 1 : 0);
    }
  }
});

test("login page is unavailable in local Node and served only by Cloudflare", async () => {
  const app = createRouter();
  let served = 0;
  const assets = { fetch: async () => { served += 1; return new Response("login page"); } };
  assert.equal((await app.request("/login.html", {}, { APP_RUNTIME: "node", ASSETS: assets })).status, 404);
  assert.equal(served, 0);
  assert.equal((await app.request("/login.html", {}, { APP_RUNTIME: "cloudflare", ASSETS: assets })).status, 200);
  assert.equal(served, 1);
});

test("production research GET does not contact taskd or submit a model request", async () => {
  const app = createRouter();
  const env = {
    APP_RUNTIME: "cloudflare", LLM_RUNTIME: "production",
    DB: { prepare: () => ({ bind() { return this; }, first: async () => null }) },
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  };
  for (const path of ["/api/research/company/300750.SZ/investment-analysis/refresh", "/api/research/company/300750.SZ/financial-analysis/refresh"]) {
    assert.equal((await app.request(path, { method: "POST" }, env)).status, 404);
  }
});

test("featured reports require a production session and preserve the report code through login", async () => {
  const app = createRouter();
  const path = "/featured-report.html?code=123456";
  let served = 0;
  const env = { APP_RUNTIME: "cloudflare", ASSETS: { fetch: async () => { served++; return new Response("report"); } } };
  const response = await app.request(path, {}, env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `/login.html?returnTo=${encodeURIComponent(path)}`);
  assert.equal((await app.request("/api/featured-reports/123456", {}, env)).status, 401);
  assert.equal(served, 0);
  const loggedIn = { ...env, DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ id: "user", email: "user@example.com" }) }) } };
  assert.equal((await app.request(path, { headers: { cookie: `tinfo_session=${"a".repeat(43)}` } }, loggedIn)).status, 200);
  assert.equal((await app.request(path, {}, { ...env, APP_RUNTIME: "node" })).status, 200);
});
