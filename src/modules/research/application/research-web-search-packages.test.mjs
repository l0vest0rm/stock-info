import assert from "node:assert/strict";
import test from "node:test";
import { completeResearchWebSearchPackageJob, failResearchWebSearchPackageJob } from "./research-web-search-packages.ts";

function staleAttemptDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          if (/select job_id as jobId/.test(sql)) return { first: async () => ({ jobId: "research-web-search:300308.SZ:industry_market:v3", status: "running", attempt: 2, leaseOwner: "runner-b", leaseUntil: Date.now() + 60_000 }) };
          return { run: async () => ({ meta: { changes: 0 } }) };
        },
      };
    },
  };
}

test("runner A late terminal writes cannot replace runner B's web-search attempt", async () => {
  const db = staleAttemptDb();
  await assert.rejects(
    () => completeResearchWebSearchPackageJob(db, "300308.SZ", "industry_market", { model: "gpt-5.6-luna", text: "late", webSearch: { searched: true, citations: [{ title: "source", url: "https://example.test" }] } }, "runner-a", 1),
    /lease is no longer owned/,
  );
  await assert.rejects(() => failResearchWebSearchPackageJob(db, "300308.SZ", "industry_market", "late failure", "runner-a", 1), /lease is no longer owned/);
});
