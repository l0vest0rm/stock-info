import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { extractCompanyReportAnalysisByLlm } from "../application/analyze-company-report.ts";
import { enqueueCompanyReportDiscovery } from "../application/company-reports.ts";

// Enforce the dependency boundary that lets knowledge and background jobs use
// report analysis without constructing an HTTP request or loading route setup.
test("company application and domain modules do not depend on HTTP routes", () => {
  for (const layer of ["application", "domain"]) {
    const directory = new URL(`../${layer}/`, import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, directory), "utf8");
      assert.doesNotMatch(source, /from\s+["'][^"']*(?:\/api\/|hono)[^"']*["']/, `${layer}/${file}`);
      if (layer === "domain") {
        assert.doesNotMatch(source, /from\s+["'][^"']*\/(?:application|adapters)\//, `${layer}/${file}`);
      }
    }
  }
  const knowledge = readFileSync(new URL("../../knowledge/api/knowledge.routes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(knowledge, /company\/api\//);
});

test("report application entrypoints reject production before accessing dependencies", async () => {
  const env = { LLM_RUNTIME: "production" };
  await assert.rejects(extractCompanyReportAnalysisByLlm(env, "report", "content"), /only available in local Node runtime/);
  await assert.rejects(enqueueCompanyReportDiscovery(env, "000001.SZ"), /only available in local LLM runtime/);
});
