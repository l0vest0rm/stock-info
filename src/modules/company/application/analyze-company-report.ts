import { requestLocalDirectLlmText } from "../../../shared/local-direct-llm";
import { REPORT_ANALYZE_SYSTEM_PROMPT, REPORT_ANALYZE_USER_PROMPT } from "../../../generated/prompt-text";
import { type AppEnv } from "../../../types";
import {
  type LlmExtractionOptions,
  type CompanyReportAnalysisWithRaw,
  type CompanyReportAnalysis,
  type CompanyReportForecast,
  type CompanyNewsReportAnalysis,
} from "../domain/report-types";
import { REPORT_LLM_MODEL } from "../domain/report-policy";
import {
  parseCompanyReportAnalysis,
  formatCompanyReportTextForLlm,
  isLikelyCompanyNewsReport,
} from "../domain/report-analysis";
import { trimText } from "../domain/report-values";

async function requestCompanyReportAnalysisByLlm(
  env: AppEnv["Bindings"],
  title: string,
  trimmedContent: string,
  options: Pick<LlmExtractionOptions, "onText"> = {},
): Promise<CompanyReportAnalysisWithRaw> {
  const prompt = REPORT_ANALYZE_USER_PROMPT
    .replace("{{TITLE}}", title)
    .replace("{{CONTENT}}", trimmedContent);
  const response = await requestLocalDirectLlmText(env, {
    model: REPORT_LLM_MODEL,
    instructions: REPORT_ANALYZE_SYSTEM_PROMPT,
    input: [
      { role: "user", content: [{ type: "input_text", text: prompt }] },
    ],
    maxTokens: 4096,
    onText: options.onText,
  });
  return { analysis: parseCompanyReportAnalysis(response.text), rawResponseText: response.text };
}

export async function extractCompanyReportAnalysisWithRawByLlm(
  env: AppEnv["Bindings"],
  title: string,
  content: string,
  options: Pick<LlmExtractionOptions, "onText"> = {},
): Promise<CompanyReportAnalysisWithRaw> {
  if (env.LLM_RUNTIME !== "local") throw new Error("company report LLM extraction is only available in local Node runtime");
  const trimmed = trimText(formatCompanyReportTextForLlm(content), 12000);
  if (!trimmed) {
    return { analysis: { forecasts: [], targetPrice: null }, rawResponseText: '{"forecasts":[],"targetPrice":null}' };
  }
  return requestCompanyReportAnalysisByLlm(env, title, trimmed, options);
}

export async function extractCompanyReportAnalysisByLlm(
  env: AppEnv["Bindings"],
  title: string,
  content: string,
  options: LlmExtractionOptions = {},
): Promise<CompanyReportAnalysis> {
  return (await extractCompanyReportAnalysisWithRawByLlm(env, title, content, options)).analysis;
}

/** Backward-compatible forecast-only helper used by knowledge processing. */
export async function extractCompanyReportByLlm(
  env: AppEnv["Bindings"],
  title: string,
  content: string,
  options: LlmExtractionOptions = {},
): Promise<CompanyReportForecast[]> {
  const analysis = await extractCompanyReportAnalysisByLlm(env, title, content, options);
  return analysis.forecasts;
}

export async function extractCompanyNewsReportByLlm(
  env: AppEnv["Bindings"],
  title: string,
  content: string,
  options: LlmExtractionOptions = {},
): Promise<Omit<CompanyNewsReportAnalysis, "analysisCalled" | "analysisSucceeded" | "updatedAt">> {
  if (env.LLM_RUNTIME !== "local") throw new Error("company news report LLM extraction is only available in local Node runtime");
  const trimmed = trimText(formatCompanyReportTextForLlm(content), 12000);
  if (!trimmed || !isLikelyCompanyNewsReport(title, trimmed)) {
    return {
      isCompanyReport: false,
      forecasts: [],
      targetPrice: null,
    };
  }
  const result = await requestCompanyReportAnalysisByLlm(env, title, trimmed, options);
  return {
    isCompanyReport: true,
    forecasts: result.analysis.forecasts,
    targetPrice: result.analysis.targetPrice,
    rawResponseText: result.rawResponseText,
  };
}
