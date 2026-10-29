/** Durable research contracts. No positions, account balances, or trade execution. */
export type ResearchSource = { url: string; publishedAt: string; checkedAt: string; note: string };
export type IndustryFact = { key: string; value: number; period: string; source: ResearchSource };
export type IndustryCheck = { key: string; label: string; rule: string; state: 'pass' | 'fail' | 'unknown'; value: number | null; reason: string };
export type IndustryVerification = { version: string; archetype: string; state: 'pass' | 'fail' | 'unknown'; checks: IndustryCheck[]; caveat: string };
export type ResearchScenario = { name: 'bear' | 'base' | 'bull'; growth: number; terminalMultiple: number; payoutRatio: number; rationale: string };
export type ExpectationsInput = {
  /** Earnings and market cap must use the same currency and amount scale. */
  marketCap: number; normalizedProfit: number; currency: string; amountScale: 'base_units';
  priceDate: string; profitPeriod: string; years: number; requiredReturn: number; annualDilution: number;
  sources: { marketCap: ResearchSource; profit: ResearchSource; assumptions: ResearchSource };
  scenarios: ResearchScenario[];
};
export type ExpectationsResult = {
  status: 'available' | 'unavailable'; reasons: string[];
  impliedGrowth: number | null;
  scenarios: Array<{ name: string; presentEquityValue: number; annualizedReturn: number; margin: number }>;
  method: string; caveats: string[];
};
export type ObservationThesis = {
  status: 'draft' | 'reviewed' | 'invalidated';
  business: string; marketConcern: string; variantView: string; counterEvidence: string;
  nextReview: string; invalidation: string; changeReason: string;
  changeType: 'facts' | 'price' | 'model' | 'data_repair';
  evidence: ResearchSource[];
  indicators: Array<{ name: string; baseline: string; condition: string; source: ResearchSource }>;
};
export type ObservationResearchDraft = { thesis: ObservationThesis; industryFacts: IndustryFact[]; expectations: ExpectationsInput | null };
export type ObservationResearchVersion = ObservationResearchDraft & { version: number; code: string; recordedAt: string; industry: IndustryVerification; expectationResult: ExpectationsResult };
export type ObservationResearchRead = {
  canWrite: boolean; code: string; archetype: string; current: ObservationResearchVersion | null;
  versions: Array<{ version: number; recordedAt: string; status: ObservationThesis['status']; changeType: string; changeReason: string }>;
  industry: IndustryVerification; expectationResult: ExpectationsResult;
  template: ObservationResearchDraft;
};
export type ObservationCohort = {
  id: string; code: string; recordedAt: string; quoteDate: string | null; stage: string;
  policyVersion: string; dependencyRevision: string; computationId: string;
  gates: unknown[]; signals: unknown[]; researchVersion: number | null;
};
export type ObservationOutcome = { evidence?: { source: 'xueqiu_qfq'; entryDate: string; entryClose: number; exitClose: number; benchmarkCode: string | null; benchmarkEntryClose: number | null; benchmarkExitClose: number | null }; id: string; horizon: number; state: 'matured' | 'pending' | 'unavailable'; return: number | null; benchmarkReturn: number | null; excessReturn: number | null; endDate: string | null; reason: string; evaluatedAt: string };
export type ObservationHistoryRead = { cohorts: ObservationCohort[]; outcomes: ObservationOutcome[]; summary: Array<{ policyVersion: string; dependencyRevision: string; group: 'candidate' | 'excluded'; horizon: number; samples: number; pending: number; unavailable: number; meanReturn: number | null; meanExcessReturn: number | null }>; limitations: string[] };
