#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const inputPath = new URL("../config/research-eastmoney-em2016-top300.json", import.meta.url);
const rulesPath = new URL("../config/research-eastmoney-em2016-template-rules.json", import.meta.url);
const outputPath = new URL("../config/research-eastmoney-em2016-template-mappings.json", import.meta.url);
const input = JSON.parse(await readFile(inputPath, "utf8"));
const rulesConfig = JSON.parse(await readFile(rulesPath, "utf8"));
const industries = Array.isArray(input.industries) ? input.industries : [];
const rules = Array.isArray(rulesConfig.rules) ? rulesConfig.rules : [];
const mappings = industries.map((industry) => {
  const levels = Array.isArray(industry.levels) ? industry.levels.map(String) : String(industry.em2016 ?? "").split("-");
  const rule = rules.find((item) => matchesRule(levels, item));
  if (!rule?.templateId) throw new Error(`no template rule for EM2016 ${industry.em2016}`);
  return {
    em2016: String(industry.em2016),
    levels,
    templateId: String(rule.templateId),
    mappingRule: { level1: rule.level1 ?? null, level2: rule.level2 ?? null, level3: rule.level3 ?? null },
    securityCodes: Array.isArray(industry.securityCodes) ? industry.securityCodes.map(String).sort() : [],
  };
}).sort((left, right) => left.em2016.localeCompare(right.em2016, "zh-CN"));
const output = {
  schemaVersion: "research-eastmoney-em2016-template-mappings.v1",
  source: { aggregation: "config/research-eastmoney-em2016-top300.json", coverage: input.coverage ?? null, rules: "config/research-eastmoney-em2016-template-rules.json" },
  mappings,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath.pathname, mappings: mappings.length, templateIds: [...new Set(mappings.map((item) => item.templateId))].sort() }, null, 2));

function matchesRule(levels, rule) {
  return ["level1", "level2", "level3"].every((key, index) => rule[key] === undefined || rule[key] === levels[index]);
}
