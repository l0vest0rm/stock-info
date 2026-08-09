export type Bindings = {
  /** Explicit platform identity. Never infer the local runtime from nodejs_compat. */
  APP_RUNTIME?: "node" | "cloudflare";
  ASSETS: Fetcher;
  DB: D1Database;
  MARKET_DATA_BUCKET: R2Bucket;
  RAW_BUCKET?: R2Bucket;
  KNOWLEDGE_CONTENT_BUCKET?: R2Bucket;
  APP_VERSION?: string;
  MARKET_DATA_PUBLIC_BASE_URL?: string;
  KNOWLEDGE_CONTENT_PUBLIC_BASE_URL?: string;
  KNOWLEDGE_CONTENT_LOCAL_DIR?: string;
  KNOWLEDGE_REPORT_CONVERTER_URL?: string;
  KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY?: string;
  KNOWLEDGE_ALLOW_TEXT_SEARCH?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_RUNTIME?: string;
  LLM_DAILY_LIMIT?: string;
  HTTP_PROXY_URL?: string;
  HTTP_PROXY_RELAY_URL?: string;
  HTTP_PROXY_DOMAINS?: string;
  HTTP_DOMAIN_CONCURRENCY?: string;
  HTTP_REQUEST_TIMEOUT_MS?: string;
  XUEQIU_COOKIE?: string;
  FRED_API_KEY?: string;
  BLS_API_KEY?: string;
  BOK_ECOS_API_KEY?: string;
  KOSIS_API_KEY?: string;
};

export type AppEnv = {
  Bindings: Bindings;
};

export type ApiSuccess<T> = {
  code: 200;
  msg: "OK";
  data: T;
};

export type ApiFailure = {
  code: number;
  msg: string;
  data: null;
};

export type SecurityRecord = {
  code: string;
  market: string;
  type: string;
  name: string;
  currency?: string | null;
  exchangeName?: string | null;
  source?: string | null;
  updatedAt: number;
};

export type KlineBar = {
  code: string;
  period: string;
  fq: string;
  date: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  amount: number | null;
  amplitude: number | null;
  pctChange: number | null;
  changeAmount: number | null;
  turnover: number | null;
  peTtm: number | null;
  pb: number | null;
  ps: number | null;
  pcf: number | null;
  marketCapital: number | null;
  balance: number | null;
  source: string;
  updatedAt: number;
};

export type FundNavRow = {
  code: string;
  date: string;
  nav: number | null;
  accumNav: number | null;
  dailyReturn: number | null;
  subscriptionStatus: string | null;
  redemptionStatus: string | null;
  updatedAt: number;
};

export type StatementType = "income" | "balance" | "cashflow";

export type FinancialStatement = {
  code: string;
  statementType: StatementType;
  reportDate: string;
  fiscalPeriod: string | null;
  payload: unknown;
  source: string;
  rawR2Key: string | null;
  updatedAt: number;
};

export type CompanyOverview = {
  code: string;
  name: string;
  market: string;
  type: string;
  marketDate: string | null;
  latestPrice: number | null;
  pctChange: number | null;
  changeAmount: number | null;
  turnover: number | null;
  marketCapYi: number | null;
  peTtm: number | null;
  pb: number | null;
  psTtm: number | null;
  pcfTtm: number | null;
  source: string;
  updatedAt: number;
};

export type CompanyNotice = {
  artCode: string;
  title: string;
  noticeDate: string;
  noticeType: string;
  pdfUrl: string;
};
