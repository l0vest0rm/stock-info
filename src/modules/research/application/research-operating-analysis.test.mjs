import assert from "node:assert/strict";
import test from "node:test";
import config from "../../../../config/research-operating-analysis.json" with { type: "json" };
import { RESEARCH_OPERATING_ANALYSIS_PROMPT } from "../../../generated/prompt-text.ts";
import { OPERATING_ANALYSIS_PROMPT_VERSION } from "./research-operating-analysis.ts";

test("operating analysis prompt version and evidence contract stay aligned", () => {
  assert.equal(config.version, OPERATING_ANALYSIS_PROMPT_VERSION);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /独立外部证据/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /未找到已核验的外部证据/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /\[公司披露\].*\[外部证据\].*\[分析判断\]/s);
  assert.match(RESEARCH_OPERATING_ANALYSIS_PROMPT, /\[来源名称\]\(https:\/\/example\.com\/source\)/);
});
