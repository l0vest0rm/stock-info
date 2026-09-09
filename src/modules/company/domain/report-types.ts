import { type LlmWebSearchMetadata } from "../../../shared/llm-client";
import { text } from "./report-values";

export type CompanyReportForecast = {
  year: number;
  revenue?: number;
  revenueGrowth?: number;
  netProfit?: number;
  profitGrowth?: number;
  eps?: number;
  pe?: number;
  computedNetProfit?: number;
  computedNetProfitAsOf?: number;
  computedPe?: number;
  computedPeAsOf?: number;
};

export type CompanyReportValuation = {
  rating?: string;
  targetPrice?: number;
  targetPriceCurrency?: string;
  targetPe?: number;
  valuationMethod?: string;
};

export type ReportForecastExtraction = {
  reportId: string;
  code: string;
  title: string;
  source: string;
  updatedAt: number;
  forecasts: CompanyReportForecast[];
  targetPrice?: number | null;
  analysisSucceeded?: boolean;
  /** Exact valid model output retained for the report-row hover surface. */
  rawResponseText?: string;
};

export type SharedReportAnalysis = {
  analysisCalled: boolean;
  forecasts: CompanyReportForecast[];
  targetPrice?: number | null;
  updatedAt: number;
  analysisSucceeded?: boolean;
  rawResponseText?: string;
};

export type CompanyNewsReportAnalysis = {
  analysisCalled: true;
  analysisSucceeded: true;
  isCompanyReport: boolean;
  forecasts: CompanyReportForecast[];
  targetPrice: number | null;
  updatedAt: number;
  rawResponseText?: string;
};

type ReportForecastProgress = {
  completed: number;
  total: number;
  title: string;
};

export type ReportForecastStreamEvent = {
  progress?: ReportForecastProgress;
  items?: Array<Record<string, unknown>>;
  delta?: string;
  status?: "queued" | "running" | "completed" | "failed" | "blocked";
  failures?: ReportForecastFailure[];
};

export type ReportForecastFailure = {
  title: string;
  message: string;
};

export type LlmExtractionOptions = { onText?: (delta: string) => Promise<void> | void; onStatus?: (status: "queued" | "running" | "completed" | "failed" | "blocked") => Promise<void> | void; targetId?: string; idempotencyKey?: string };

export type CompanyReportDiscoveryCandidate = {
  title: string;
  institution?: string;
  publishedAt?: string;
  url?: string;
  forecasts: CompanyReportForecast[];
  targetPrice?: number | null;
  valuation?: CompanyReportValuation;
};

export type CompanyReportDiscoveryWebSearchMetadata = LlmWebSearchMetadata & {
  /** The provider reached a terminal `response.completed` event. */
  responseCompleted?: boolean;
  /** Terminal Responses status retained for incomplete-stream diagnostics. */
  responseStatus?: string;
  /** A Web Search tool call reached its completed event/status. */
  webSearchCallCompleted?: boolean;
  /** The local WebQA gateway completed the browser-backed request. */
  transport?: "webqa";
};

export type StoredCompanyReportDiscoveryTask = {
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type StoredCompanyReportDiscoveryReport = {
  response: { text: string };
  projection: {
    securityCode: string;
    reportsFound: number;
    reportsRejected: number;
    sourceRows: number;
    cachedAt: number;
  };
};

export type StoredCompanyReportDiscoveryValue = {
  report: StoredCompanyReportDiscoveryReport | null;
  task: StoredCompanyReportDiscoveryTask | null;
  lastSuccessfulCompletedAt: number | null;
};

export type SinaCompanyReport = {
  title: string;
  url: string;
  orgName: string;
  publishDate: string;
  rating: string;
};

export type KnowledgeNewsReportCandidateRow = {
  doc_id: string;
  source_name: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  fetched_at: string | null;
  event_time: string | null;
  summary: string | null;
  content_preview: string | null;
  content_key: string | null;
  content_url: string | null;
};

export type CompanyReportLlmRawResponse = Record<string, unknown> | string | null;

export type CompanyReportAnalysis = {
  forecasts: CompanyReportForecast[];
  targetPrice: number | null;
};

export type CompanyReportAnalysisWithRaw = {
  analysis: CompanyReportAnalysis;
  rawResponseText: string;
};
