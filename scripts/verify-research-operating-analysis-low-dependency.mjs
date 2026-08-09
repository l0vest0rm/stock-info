#!/usr/bin/env node

/**
 * P7 acceptance workflow. This script is intentionally opt-in: it exercises
 * the local enqueue -> claim/worker -> S0-S12 -> API terminal path only when
 * a caller explicitly runs it against a prepared local runtime. It never
 * targets production and does not treat a partial/blocked report as success.
 */
const baseUrl = String(process.env.RESEARCH_LOW_DEPENDENCY_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const code = String(process.env.RESEARCH_LOW_DEPENDENCY_CODE || "300308.SZ").trim().toUpperCase();
const timeoutMs = Number(process.env.RESEARCH_LOW_DEPENDENCY_TIMEOUT_MS || 1_800_000);
const pollMs = Number(process.env.RESEARCH_LOW_DEPENDENCY_POLL_MS || 5_000);
const expectedKeys = [
  "research_context", "company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts",
  "operating_thesis", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
];

const startedAt = Date.now();
const queued = await api(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency/refresh`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }),
});
assert(queued.data?.protocolVersion === "investment-analysis.low-dependency.v1", "refresh did not return the target protocol");
const result = await waitForTerminal();
assert(result?.task, "low-dependency task read model is missing");
assert(result.stages?.map((stage) => stage.stageKey).join(",") === expectedKeys.join(","), "read model does not expose the exact S0-S12 stage key set");
assert(["completed", "blocked", "failed"].includes(result.task.status), `task did not reach a terminal state: ${result.task.status}`);
if (result.task.status !== "completed") {
  assert(result.report?.status !== "complete", "a blocked/failed task exposed a successful report");
  throw new Error(`low-dependency task reached ${result.task.status}; inspect task.lastError, stage statuses and blockers`);
}
assert(result.report?.status === "complete", "completed task has no complete S12 report");
assert(typeof result.report.markdown === "string" && result.report.markdown.includes("# 12. 最终结论"), "complete task report is missing chapter 12");
const rerunStage = String(process.env.RESEARCH_LOW_DEPENDENCY_RERUN_STAGE || "").trim();
if (rerunStage) {
  const rerun = await api(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency/rerun`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stageKeys: [rerunStage] }),
  });
  assert(rerun.data?.shouldStart === true, "targeted rerun was not queued");
  const recovered = await waitForTerminal();
  assert(recovered.task?.status === "completed", `targeted rerun did not complete: ${recovered.task?.status}`);
  assert(recovered.run?.lineageRunId, "targeted rerun did not record prior run lineage");
  assert(recovered.stages.some((stage) => stage.stageKey === rerunStage && stage.reused !== true), "targeted stage was incorrectly reused");
  assert(recovered.stages.some((stage) => stage.reused === true), "targeted rerun did not preserve any compatible sibling artifact");
}
console.log(JSON.stringify({ code, taskId: result.task.taskId, runId: result.run?.runId, attempt: result.run?.attempt, reportArtifactId: result.finalArtifactId, durationMs: Date.now() - startedAt }));

async function waitForTerminal() {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = (await api(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency`)).data;
    if (["completed", "blocked", "failed"].includes(latest?.task?.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, pollMs)));
  }
  throw new Error(`low-dependency task did not reach terminal state within ${timeoutMs}ms`);
}

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  assert(response.ok && body?.code === 200, `${path}: ${body?.msg || response.status}`);
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
