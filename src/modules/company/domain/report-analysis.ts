import companyNewsReportKeywords from "../../../../config/company-news-report-keywords.json";
import {
  type ReportForecastExtraction,
  type SharedReportAnalysis,
  type CompanyReportLlmRawResponse,
  type CompanyReportForecast,
  type CompanyReportAnalysis,
} from "./report-types";
import { positiveNumberOrUndefined, text, parseJsonObjectFromText, numberOrUndefined } from "./report-values";

export function hasReportAnalysisValues(
  value: Pick<ReportForecastExtraction, "forecasts" | "targetPrice"> | SharedReportAnalysis | null | undefined,
): value is Pick<ReportForecastExtraction, "forecasts" | "targetPrice"> {
  return Boolean(value && Array.isArray(value.forecasts)
    && (value.forecasts.length > 0 || positiveNumberOrUndefined(value.targetPrice) !== undefined));
}

export function isSuccessfulReportAnalysis(
  value: Pick<ReportForecastExtraction, "forecasts" | "analysisSucceeded"> | SharedReportAnalysis | null | undefined,
): value is Pick<ReportForecastExtraction, "forecasts" | "analysisSucceeded"> {
  return Boolean(value && Array.isArray(value.forecasts) && value.analysisSucceeded === true);
}

export function normalizeCompanyReportRawResponseText(value: unknown): CompanyReportLlmRawResponse | null {
  const rawResponseText = text(value);
  return rawResponseText ? parseJsonObjectFromText(rawResponseText) || rawResponseText : null;
}

export function formatCompanyReportTextForLlm(content: string): string {
  let formatted = content
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u200b\ufeff]/g, " ");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = formatted.replace(/([\u3400-\u9fff])[\t ]+([\u3400-\u9fff])/g, "$1$2");
    if (next === formatted) {
      break;
    }
    formatted = next;
  }
  return formatted.replace(/\b(20\d?)\s(\d)/g, "$1$2");
}

export function parseCompanyReportForecasts(textBody: string): CompanyReportForecast[] {
  return parseCompanyReportAnalysis(textBody).forecasts;
}

export function parseCompanyReportTargetPrice(value: unknown): number | null {
  return positiveNumberOrUndefined(value) ?? null;
}

export function parseCompanyReportAnalysis(textBody: string): CompanyReportAnalysis {
  const parsed = parseJsonObjectFromText(textBody);
  if (!parsed || !Array.isArray(parsed.forecasts)) {
    throw new Error("LLM forecast response did not contain a forecasts array");
  }
  return {
    forecasts: parseCompanyReportForecastRows(parsed.forecasts),
    targetPrice: parseCompanyReportTargetPrice(parsed.targetPrice),
  };
}

export function isLikelyCompanyNewsReport(title: string, content: string): boolean {
  const haystack = `${title}\n${content}`.toLowerCase();
  return companyNewsReportKeywords.some((keyword) => {
    const normalizedKeyword = String(keyword || "").trim().toLowerCase();
    return normalizedKeyword ? containsPositiveNewsReportKeyword(haystack, normalizedKeyword) : false;
  });
}

function containsPositiveNewsReportKeyword(haystack: string, keyword: string): boolean {
  if (!haystack.includes(keyword)) {
    return false;
  }
  const negatedForms = [
    `没有${keyword}`,
    `无${keyword}`,
    `未提及${keyword}`,
    `不含${keyword}`,
    `并无${keyword}`,
    `未给出${keyword}`,
    `未披露${keyword}`,
    `未提供${keyword}`,
    `并未给出${keyword}`,
  ];
  const stripped = negatedForms.reduce((value, phrase) => value.replaceAll(phrase, ""), haystack);
  return stripped.includes(keyword);
}

export function parseCompanyReportForecastRows(value: unknown[]): CompanyReportForecast[] {
  const forecasts = value
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const row = value as Record<string, unknown>;
      const year = Number(row.year);
      if (!Number.isInteger(year) || year <= 0) {
        return null;
      }
      const revenue = numberOrUndefined(row.revenue);
      const revenueGrowth = numberOrUndefined(row.revenueGrowth);
      const netProfit = numberOrUndefined(row.netProfit);
      const profitGrowth = numberOrUndefined(row.profitGrowth);
      const eps = numberOrUndefined(row.eps);
      const pe = numberOrUndefined(row.pe);
      if (revenue === undefined && netProfit === undefined && eps === undefined && pe === undefined) {
        return null;
      }
      return {
        year,
        ...(revenue !== undefined ? { revenue: revenue } : {}),
        ...(revenueGrowth !== undefined ? { revenueGrowth } : {}),
        ...(netProfit !== undefined ? { netProfit: netProfit } : {}),
        ...(profitGrowth !== undefined ? { profitGrowth } : {}),
        ...(eps !== undefined ? { eps: eps } : {}),
        ...(pe !== undefined ? { pe: pe } : {}),
      };
    })
    .filter((row): row is CompanyReportForecast => Boolean(row));
  forecasts.sort((left, right) => left.year - right.year);
  return forecasts;
}
