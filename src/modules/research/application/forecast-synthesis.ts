import {
  RESEARCH_FORECAST_SYNTHESIS_SYSTEM_PROMPT,
  RESEARCH_FORECAST_SYNTHESIS_USER_PROMPT,
} from "../../../generated/prompt-text";
import { requestLlmText } from "../../../shared/llm-client";
import type { Bindings } from "../../../types";
import { canWriteResearchLocally } from "../domain/research-capabilities";
import { hasUnsafeMarketConsensusClaim } from "../domain/forecast-synthesis-policy";
import { loadForecastWorkspace } from "./forecast-ledger";

const MODEL = "gpt-5.6-luna" as const;
export const FORECAST_SYNTHESIS_PROMPT_VERSION = "forecast-synthesis.v2";

export async function createForecastSynthesisDraft(
  env: Bindings,
  code: string,
  security: Parameters<typeof loadForecastWorkspace>[2],
) {
  if (!canWriteResearchLocally(env)) throw new Error("forecast synthesis is only available in local LLM runtime");
  const workspace = await loadForecastWorkspace(env.DB, code, security);
  if (!workspace.consolidation) throw new Error("no v4 reviewed source-forecast consolidation is available for synthesis");
  const selectedForecastIds = new Set(workspace.consolidation.members
    .filter((member) => member.membershipStatus === "included" && member.reasonCode === "included")
    .map((member) => String(member.forecastId)));
  const included = workspace.sourceForecasts.filter((item) => selectedForecastIds.has(String(item.forecastId)));
  if (included.length === 0) throw new Error("no independently eligible source forecasts are available for synthesis");
  const sourcePayload = included.map((item) => ({
    forecastId: item.forecastId,
    institution: item.institution,
    forecastDate: item.forecastDate,
    metric: item.metric,
    fiscalYear: item.fiscalYear,
    rawValue: item.rawValue,
    rawUnit: item.rawUnit,
    currency: item.currency,
    accountingBasis: item.accountingBasis,
    ownershipBasis: item.ownershipBasis,
    shareBasis: item.shareBasis,
    sourceStatement: item.sourceStatement,
  }));
  const response = await requestLlmText(env, {
    model: MODEL,
    reasoningEffort: "low",
    maxTokens: 2400,
    cacheEnabled: false,
    messages: [
      { role: "system", content: RESEARCH_FORECAST_SYNTHESIS_SYSTEM_PROMPT },
      { role: "user", content: render(RESEARCH_FORECAST_SYNTHESIS_USER_PROMPT, {
        SECURITY_CODE: code,
        SUBJECT_STATUS: String(workspace.subject.analysisScopeStatus),
        SOURCE_FORECASTS: JSON.stringify(sourcePayload, null, 2),
        CONSOLIDATION: JSON.stringify(workspace.consolidation, null, 2),
      }) },
    ],
  });
  const content = response.text.trim();
  if (!content || hasUnsafeMarketConsensusClaim(content)) {
    throw new Error("forecast synthesis violated the sample-coverage boundary");
  }
  const draftId = `forecast-synthesis-draft:${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(`insert into research_forecast_synthesis_drafts (
    draft_id, security_code, company_id, consolidation_id, model, prompt_version,
    content_markdown, source_forecast_ids_json, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(draftId, code, workspace.subject.operatingCompany?.companyId ?? null,
      String(workspace.consolidation.consolidationId), MODEL, FORECAST_SYNTHESIS_PROMPT_VERSION,
      content, JSON.stringify(included.map((item) => item.forecastId)), now).run();
  return { draftId, model: MODEL, promptVersion: FORECAST_SYNTHESIS_PROMPT_VERSION, contentMarkdown: content,
    sourceForecastIds: included.map((item) => item.forecastId), createdAt: now };
}

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
}
