import assert from "node:assert/strict";
import test from "node:test";
import runtimeConfig from "../../config/local-job-runtime.json" with { type: "json" };
import { assembleLowDependencyOperatingAnalysisReport, assembleOperatingAnalysisReport } from "./operating-analysis-report.mjs";
import { runOperatingAnalysisStageWaves, runResearchOperatingAnalysisStageWaves, researchOperatingAnalysisStageWaves } from "./operating-analysis-stage-plan.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("independent operating and financial stages overlap, while valuation waits for both", async () => {
  const events = [];
  let active = 0;
  let maximumActive = 0;
  const stages = {
    baseline: { key: "company_baseline" },
    industry: { key: "industry_validation" },
    operating: { key: "operating_analysis" },
    financial: { key: "financial_analysis" },
    valuation: { key: "valuation_inputs" },
  };
  await runOperatingAnalysisStageWaves([[stages.baseline], [stages.industry], [stages.operating, stages.financial], [stages.valuation]], async (stage) => {
    events.push(`start:${stage.key}`);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(stage.key === "financial_analysis" ? 20 : 5);
    active -= 1;
    events.push(`end:${stage.key}`);
    return { status: "complete" };
  });
  assert.equal(maximumActive, 2);
  assert(events.indexOf("start:valuation_inputs") > events.indexOf("end:operating_analysis"));
  assert(events.indexOf("start:valuation_inputs") > events.indexOf("end:financial_analysis"));
});

test("a failed sibling still lets its parallel sibling settle before propagating the failure", async () => {
  const events = [];
  await assert.rejects(() => runOperatingAnalysisStageWaves([[{ key: "operating_analysis" }, { key: "financial_analysis" }]], async (stage) => {
    if (stage.key === "operating_analysis") {
      await delay(5);
      throw new Error("operating failed");
    }
    await delay(15);
    events.push("financial-settled");
    return { status: "complete" };
  }), /operating failed/);
  assert.deepEqual(events, ["financial-settled"]);
});

test("final report retains inline citations without a detached source index", () => {
  const report = assembleOperatingAnalysisReport({ asOf: "2026-08-09", company: { name: "测试公司" }, security: { securityCode: "000001.SZ" } }, [
    { stageKey: "company_baseline", label: "1. 公司事实基线", status: "complete", output: { sourceIndex: [{ sourceTitle: "不应显示", sourceUrl: "https://example.com/index" }] } },
    { stageKey: "operating_analysis", label: "3. 经营分析", status: "complete", output: "经营结论。[公司公告](https://example.com/filing)" },
    { stageKey: "financial_analysis", label: "4. 财务分析", status: "complete", output: "财务结论。系统结构化财务数据（2026Q1、财务接口）" },
    { stageKey: "valuation_conclusion", label: "6. 最终结论", status: "complete", output: "估值结论。[行业统计](https://example.com/industry)" },
  ]);
  assert.match(report, /\[公司公告\]\(https:\/\/example\.com\/filing\)/);
  assert.match(report, /\[行业统计\]\(https:\/\/example\.com\/industry\)/);
  assert.doesNotMatch(report, /来源索引|example\.com\/index/);
});

test("target registry drives the S0-S7 scope wave and applies a resource cap", async () => {
  const waves = researchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable: true });
  assert.deepEqual(waves[2].map((stage) => stage.key), ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"]);
  let active = 0;
  let maximum = 0;
  const settled = [];
  await runResearchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable: true, resourceCap: 2, onStageSettled: (stage, result) => settled.push([stage.key, result.status]), runStage: async (stage) => {
    active += 1; maximum = Math.max(maximum, active);
    await delay(2);
    active -= 1;
    return { stageKey: stage.key, status: "complete" };
  } });
  assert.equal(maximum, 2);
  assert.equal(settled.length, 14);
});

test("local runtime capacity covers all independent S1-S7 stages while preserving the S8-S12 chain", () => {
  const waves = researchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable: true });
  const independent = waves[2];
  assert.deepEqual(independent.map((stage) => stage.key), ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"]);
  // Independent stages are admitted by the central DB provider ledger; the
  // durable cap intentionally stays below the seven-stage fan-out.
  assert.equal(runtimeConfig.provider.globalConcurrency, 5);
  assert(runtimeConfig.handlers.researchOperatingAnalysis.concurrency >= 1);
  assert.deepEqual(waves.slice(3).map((wave) => wave.map((stage) => stage.key)), [["operating_thesis"], ["scenario_valuation"], ["deterministic_valuation"], ["investment_conclusion"], ["report_assembly"]]);
});

test("target registry releases S8-S12 only after their declared valuation dependencies", async () => {
  const waves = researchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable: true });
  assert.deepEqual(waves.slice(3).map((wave) => wave.map((stage) => stage.key)), [
    ["operating_thesis"],
    ["scenario_valuation"],
    ["deterministic_valuation"],
    ["investment_conclusion"],
    ["report_assembly"],
  ]);
  const calls = [];
  const result = await runResearchOperatingAnalysisStageWaves({
    scopeEnvelopeAvailable: true,
    runStage: async (stage) => {
      calls.push(stage.key);
      return { status: stage.key === "scenario_valuation" ? "blocked" : "complete" };
    },
  });
  const byKey = new Map(result.map((item) => [item.stage.key, item.output]));
  assert.equal(byKey.get("scenario_valuation").status, "blocked");
  assert.equal(byKey.get("deterministic_valuation").status, "blocked");
  assert.equal(byKey.get("investment_conclusion").status, "blocked");
  assert.equal(byKey.get("report_assembly").status, "blocked");
  assert(calls.includes("operating_thesis"));
});

test("target fallback wave keeps S2-S5 on the S0 scope projection", () => {
  const waves = researchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable: false });
  assert.deepEqual(waves[2].map((stage) => stage.key), ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"]);
  assert.deepEqual(waves[3].map((stage) => stage.key), ["operating_thesis"]);
});

test("target waves settle siblings and block only their declared dependants", async () => {
  const settled = await runResearchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable: true, runStage: async (stage) => {
    if (stage.key === "industry_structure") throw new Error("industry unavailable");
    return { status: "complete" };
  } });
  const byKey = new Map(settled.map((item) => [item.stage.key, item.output]));
  assert.equal(byKey.get("industry_structure").status, "failed");
  assert.equal(byKey.get("supply_demand_cycle").status, "complete");
  assert.equal(byKey.get("competition_peers").status, "complete");
  assert.equal(byKey.get("operating_thesis").status, "blocked");
  assert.equal(byKey.get("financial_quality").status, "complete");
});

test("S12 assembles all twelve headings from chapter owners and exposes the final gate", () => {
  const stages = [
    { stageKey: "engineering_baseline", artifactId: "llm-artifact:s0", status: "complete", output: { company: { name: "测试公司" }, security: { securityCode: "000001.SZ" }, asOf: "2026-08-10", reportingBoundary: {}, contextVersion: "research-context.v1" } },
    { stageKey: "local_routing_match", artifactId: "llm-artifact:s0-routing", status: "complete", output: {} },
    { stageKey: "company_facts", artifactId: "llm-artifact:s1", status: "complete", output: "公司事实正文" },
    { stageKey: "industry_structure", artifactId: "llm-artifact:s2", status: "complete", output: "行业结构正文" },
    { stageKey: "supply_demand_cycle", artifactId: "llm-artifact:s3", status: "complete", output: "供需周期正文" },
    { stageKey: "competition_peers", artifactId: "llm-artifact:s4", status: "complete", output: "竞争同行正文" },
    { stageKey: "company_operating_drivers", artifactId: "llm-artifact:s5", status: "complete", output: "经营驱动正文" },
    { stageKey: "financial_quality", artifactId: "llm-artifact:s6", status: "complete", output: "财务质量正文" },
    { stageKey: "market_valuation_facts", artifactId: "llm-artifact:s7", status: "complete", output: "市场事实正文" },
    { stageKey: "operating_thesis", artifactId: "llm-artifact:s8", status: "complete", output: "经营论题正文" },
    { stageKey: "scenario_valuation", artifactId: "llm-artifact:s9", status: "complete", output: {} },
    { stageKey: "deterministic_valuation", artifactId: "llm-artifact:s10", status: "complete", output: { calculationTrace: [{ calculationId: "calculation:base:dcf" }] } },
    { stageKey: "investment_conclusion", artifactId: "llm-artifact:s11", status: "complete", output: "## 9. 估值解释\n估值解释\n\n## 10. 风险反证\n风险反证\n\n## 11. 跟踪仪表盘\n跟踪仪表盘\n\n## 12. 最终结论\n最终结论" },
  ];
  const report = assembleLowDependencyOperatingAnalysisReport({ runId: "llm-run:1", context: stages[0].output, stages });
  assert.equal(report.status, "complete");
  for (let chapter = 1; chapter <= 12; chapter += 1) assert.match(report.markdown, new RegExp(`# ${chapter}\\.`));
  assert.match(report.markdown, /最终结论/);
  assert.deepEqual(report.manifest.chapterOwners["12"], ["investment_conclusion"]);
  assert.deepEqual(report.manifest.chapterArtifactIds["12"], ["llm-artifact:s11"]);
  const blocked = assembleLowDependencyOperatingAnalysisReport({ context: stages[0].output, stages: stages.map((stage) => stage.stageKey === "financial_quality" ? { ...stage, status: "partial" } : stage) });
  assert.equal(blocked.status, "partial");
  assert.match(blocked.markdown, /报告状态：partial/);
});
