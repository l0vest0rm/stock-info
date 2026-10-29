import type { ExpectationsResult, IndustryVerification } from './observation-research';
/** Public, versioned research contract. No trading decision or weighted score. */
export type OpportunityKind = 'historical_discount' | 'earnings_delivery' | 'forward_gap' | 'drawdown';
export type EvidenceState = 'triggered' | 'not_triggered' | 'insufficient_data' | 'not_applicable';
export type OpportunityMetric = { key: string; label: string; value: number | null; unit: 'ratio' | 'multiple'; period: string; source: string };
export type OpportunitySignal = {
  kind: OpportunityKind; state: EvidenceState; group: 'price' | 'earnings' | 'expectations';
  summary: string; metrics: OpportunityMetric[]; limitations: string[];
};
export type OpportunityGate = { key: 'data' | 'business' | 'valuation'; state: 'pass' | 'fail' | 'unknown'; reasons: string[] };
export type SeasonalComparison = {
  state: 'non_declining' | 'consistent' | 'review' | 'insufficient_data';
  revenue: { current: number | null; median: number | null; samples: Array<{ period: string; value: number }> };
  profit: { current: number | null; median: number | null; samples: Array<{ period: string; value: number }> };
  reason: string;
};
export type ResearchWorkflow = {
  path: 'growth' | 'cash_return' | 'cyclical' | 'financial' | 'milestone';
  pathLabel: string;
  queue: 'repair_data' | 'review_risk' | 'verify_thesis' | 'monitor';
  nextAction: string;
  requiredEvidence: string[];
  thesisStatus: 'not_verified' | 'reviewed' | 'invalidated' | 'review_due';
};
export type InvestmentOpportunity = {
  industry?: IndustryVerification;
  seasonality: SeasonalComparison;
  workflow: ResearchWorkflow;
  policyVersion: string; computedAt: string;
  stage: 'research_candidate' | 'clue' | 'blocked' | 'no_signal' | 'insufficient_data';
  confidence: 'medium' | 'low'; signals: OpportunitySignal[]; gates: OpportunityGate[];
  price: { source: 'xueqiu'; adjustment: 'qfq'; asOf: string | null; samples: number; returns: Array<{ sessions: number; value: number | null }>; drawdown252: number | null; reason: string | null };
  quality: { revenueQoQ: number | null; profitQoQ: number | null; qoqPeriod: string | null; revenueYoY: number | null; profitYoY: number | null; ttmGrowth: number | null; profitCagr2y: number | null; cashConversion: number | null; debtRatio: number | null; cashflowReportDate: string | null; balanceReportDate: string | null };
  review: { marketConcern: string; alternativeView: string; nextChecks: string[]; invalidation: string[] };
  caveats: string[];
  // Future integration must carry dated, sourced assumptions, not a bare growth number.
  future: { model: ExpectationsResult; priceDate: string; profitPeriod: string; currency: string; researchVersion: number } | null;
  executable: false;
};
