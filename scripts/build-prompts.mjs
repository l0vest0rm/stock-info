#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");

const promptEntries = [
  {
    exportName: "REPORT_ANALYZE_SYSTEM_PROMPT",
    source: "prompts/company/report-analyze-system.md",
  },
  {
    exportName: "REPORT_ANALYZE_USER_PROMPT",
    source: "prompts/company/report-analyze-user.md",
  },
  {
    exportName: "NEWS_REPORT_ANALYZE_SYSTEM_PROMPT",
    source: "prompts/company/news-report-analyze-system.md",
  },
  {
    exportName: "NEWS_REPORT_ANALYZE_USER_PROMPT",
    source: "prompts/company/news-report-analyze-user.md",
  },
  {
    exportName: "REPORT_DISCOVERY_SYSTEM_PROMPT",
    source: "prompts/company/report-discovery-system.md",
  },
  {
    exportName: "REPORT_DISCOVERY_USER_PROMPT",
    source: "prompts/company/report-discovery-user.md",
  },
  {
    exportName: "KNOWLEDGE_ENRICH_SYSTEM_PROMPT",
    source: "prompts/knowledge/enrich-structured-system.md",
  },
  {
    exportName: "KNOWLEDGE_ENRICH_USER_PROMPT",
    source: "prompts/knowledge/enrich-structured-user.md",
  },
  {
    exportName: "TOPIC_BATCH_SYSTEM_PROMPT",
    source: "prompts/knowledge/topic-batch-system.md",
  },
  {
    exportName: "TOPIC_BATCH_USER_PROMPT",
    source: "prompts/knowledge/topic-batch-user.md",
  },
  {
    exportName: "INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_SYSTEM_PROMPT",
    source: "prompts/information-processing/document-analysis-system.md",
  },
  {
    exportName: "INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_USER_PROMPT",
    source: "prompts/information-processing/document-analysis-user.md",
  },
  {
    exportName: "RESEARCH_FORECAST_SYNTHESIS_SYSTEM_PROMPT",
    source: "prompts/research/forecast-synthesis-system.md",
  },
  {
    exportName: "RESEARCH_FORECAST_SYNTHESIS_USER_PROMPT",
    source: "prompts/research/forecast-synthesis-user.md",
  },
  {
    exportName: "RESEARCH_FINANCIAL_ANALYSIS_SYSTEM_PROMPT",
    source: "prompts/research/financial-analysis-system.md",
  },
  {
    exportName: "RESEARCH_FINANCIAL_ANALYSIS_USER_PROMPT",
    source: "prompts/research/financial-analysis-user.md",
  },
  {
    exportName: "RESEARCH_OPERATING_ANALYSIS_SYSTEM_PROMPT",
    source: "prompts/research/operating-analysis-system.md",
  },
  {
    exportName: "RESEARCH_OPERATING_ANALYSIS_PROMPT",
    source: "prompts/research/operating-analysis.md",
  },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT", source: "prompts/research/operating-analysis/company-baseline.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT", source: "prompts/research/operating-analysis/industry-validation.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_COMPANY_FACTS_PROMPT", source: "prompts/research/operating-analysis/company-facts.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_INDUSTRY_STRUCTURE_PROMPT", source: "prompts/research/operating-analysis/industry-structure.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_SUPPLY_DEMAND_CYCLE_PROMPT", source: "prompts/research/operating-analysis/supply-demand-cycle.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_COMPETITION_PEERS_PROMPT", source: "prompts/research/operating-analysis/competition-peers.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_COMPANY_OPERATING_DRIVERS_PROMPT", source: "prompts/research/operating-analysis/company-operating-drivers.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT", source: "prompts/research/operating-analysis/financial-quality.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT", source: "prompts/research/operating-analysis/market-valuation-facts.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_OPERATING_THESIS_PROMPT", source: "prompts/research/operating-analysis/operating-thesis.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT", source: "prompts/research/operating-analysis/scenario-valuation.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_INVESTMENT_CONCLUSION_PROMPT", source: "prompts/research/operating-analysis/investment-conclusion.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT", source: "prompts/research/operating-analysis/operating-analysis.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT", source: "prompts/research/operating-analysis/financial-analysis.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT", source: "prompts/research/operating-analysis/valuation-inputs.md" },
  { exportName: "RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT", source: "prompts/research/operating-analysis/valuation-conclusion.md" },
];

const generatedTsPath = resolve(PROJECT_ROOT, "src/generated/prompt-text.ts");
const generatedMjsPath = resolve(PROJECT_ROOT, "scripts/generated/prompt-text.mjs");

const lines = [
  "// Generated by scripts/build-prompts.mjs. Do not edit by hand.",
  "",
];

for (const entry of promptEntries) {
  const text = readFileSync(resolve(PROJECT_ROOT, entry.source), "utf8").trim();
  lines.push(`export const ${entry.exportName} = ${JSON.stringify(text)};`);
}

lines.push("");

const output = `${lines.join("\n")}`;

mkdirSync(dirname(generatedTsPath), { recursive: true });
mkdirSync(dirname(generatedMjsPath), { recursive: true });
writeFileSync(generatedTsPath, output);
writeFileSync(generatedMjsPath, output);
