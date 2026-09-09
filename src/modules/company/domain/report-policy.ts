import { type SupportedLlmModel } from "../../../shared/llm-client";

export const REPORT_SOURCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export const REPORT_SOURCE_CACHE_VERSION = "v5";

export const REPORT_PAGE_SIZE = 10;

export const REPORT_SOURCE_POOL_SIZE = 100;

export const REPORT_FORECAST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const REPORT_RECENT_DAYS = 90;

export const REPORT_FORECAST_MAX_CALLS = 10;

export const NEWS_REPORT_CANDIDATE_LIMIT = 40;

export const NEWS_REPORT_ANALYSIS_MAX_CALLS = 5;

export const NEWS_REPORT_ANALYSIS_CACHE_VERSION = "v3";

export const REPORT_LLM_MODEL: SupportedLlmModel = "gpt-5.6-luna";

export const REPORT_DISCOVERY_PROMPT_VERSION = "company-report-discovery.v6";

export const REPORT_DISCOVERY_TASK_TYPE = "webqa.chatgpt.v1";

export const REPORT_DISCOVERY_REASONING_EFFORT = "xhigh";

export const COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS = 60 * 60 * 1000;

export const COMPANY_REPORT_DISCOVERY_NAMESPACE = "company_report_discovery";
