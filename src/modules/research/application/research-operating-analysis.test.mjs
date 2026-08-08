import assert from "node:assert/strict";
import test from "node:test";
import config from "../../../../config/research-operating-analysis.json" with { type: "json" };
import { RESEARCH_OPERATING_ANALYSIS_PROMPT } from "../../../generated/prompt-text.ts";
import { completeResearchOperatingAnalysisJob, enqueueResearchOperatingAnalysis, loadResearchOperatingAnalysis, OPERATING_ANALYSIS_PROMPT_VERSION, OPERATING_ANALYSIS_REQUIRED_HEADINGS } from "./research-operating-analysis.ts";

const completeReport = OPERATING_ANALYSIS_REQUIRED_HEADINGS.map((heading) => `# ${heading}`).join("\n");

test("operating analysis prompt version and evidence contract stay aligned", () => {
  assert.equal(config.version, OPERATING_ANALYSIS_PROMPT_VERSION);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /独立外部证据/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /未找到已核验的外部证据/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /\[公司披露\].*\[外部证据\].*\[分析判断\]/s);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /\[来源名称\]\(https:\/\/example\.com\/source\)/);
});

test("forced regeneration clears the previous run start before it is queued again", async () => {
  let resetSql = "";
  const db = {
    prepare(sql) {
      return { bind(...values) {
        if (/select status from research_operating_analysis_jobs/.test(sql)) return { first: async () => ({ status: "completed" }) };
        if (/update research_operating_analysis_jobs set status='queued'/.test(sql)) return { run: async () => { resetSql = sql; return { meta: { changes: 1 } }; } };
        return { first: async () => null, all: async () => ({ results: [] }) };
      } };
    },
  };
  await enqueueResearchOperatingAnalysis(db, "300308.SZ", true);
  assert.match(resetSql, /started_at=null/);
});

test("completed duration starts at this run claim, not durable job creation", async () => {
  let insertedDuration = null;
  const statements = [];
  const db = {
    prepare(sql) {
      statements.push(sql);
      return { bind(...values) {
        if (/select started_at as startedAt from research_operating_analysis_jobs/.test(sql)) return { first: async () => ({ startedAt: 2_000 }) };
        if (/insert into research_operating_analysis_runs/.test(sql)) return { run: async () => { insertedDuration = values[8]; return { meta: { changes: 1 } }; } };
        if (/update research_operating_analysis_jobs set status='completed'/.test(sql)) return { run: async () => ({ meta: { changes: 1 } }) };
        return { first: async () => null, all: async () => ({ results: [] }) };
      } };
    },
  };
  const originalNow = Date.now;
  Date.now = () => 5_500;
  try {
    await completeResearchOperatingAnalysisJob(db, "300308.SZ", {}, { instructions: "system", userPrompt: "user" }, completeReport, "推理", "fingerprint", "runner");
  } finally {
    Date.now = originalNow;
  }
  assert.equal(insertedDuration, 3_500);
  assert.equal(statements.some((sql) => /where security_code=\? and prompt_version=\? and input_fingerprint=\?/.test(sql)), false);
});

test("incomplete reports are rejected before they can be marked completed", async () => {
  await assert.rejects(
    completeResearchOperatingAnalysisJob(
      { prepare() { throw new Error("database must not be touched"); } },
      "300308.SZ",
      {},
      { instructions: "system", userPrompt: "user" },
      "# 只有一节",
      "推理",
      "fingerprint",
      "runner",
    ),
    /operating analysis report is incomplete; missing sections:/,
  );
});

test("operating analysis read model exposes lightweight newest-first version choices", async () => {
  const db = {
    prepare(sql) {
      return { bind() {
        if (/input_json as inputJson/.test(sql)) return { first: async () => ({ runId: "newest", reportMarkdown: "# 最新", inputJson: "{}", promptJson: "", streamStatsJson: "" }) };
        if (/from research_operating_analysis_jobs/.test(sql)) return { first: async () => null };
        if (/total_duration_ms as totalDurationMs from research_operating_analysis_runs/.test(sql)) return { all: async () => ({ results: [
          { runId: "newest", generatedAt: 2_000, totalDurationMs: 100 }, { runId: "older", generatedAt: 1_000, totalDurationMs: 90 },
        ] }) };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
  const result = await loadResearchOperatingAnalysis(db, "300308.SZ");
  assert.equal(result.run?.runId, "newest");
  assert.deepEqual(result.versions.map((item) => item.runId), ["newest", "older"]);
  assert.equal("reportMarkdown" in result.versions[0], false);
});
