import assert from "node:assert/strict";
import test from "node:test";
import { assembleOperatingAnalysisReport } from "./operating-analysis-report.mjs";
import { runOperatingAnalysisStageWaves } from "./operating-analysis-stage-plan.mjs";

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
