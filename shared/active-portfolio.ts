/** Private local workspace contract. Never embed account data in public research. */
export type PortfolioPosition = {
  account: string; code: string; quantity: number; price: number | null;
  currency: string; fxToBase: number | null;
};
export type PortfolioCash = { account: string; currency: string; amount: number; fxToBase: number | null };
export type PortfolioDraft = {
  strategy: 'diversified_active'; baseCurrency: string; asOf: string; source: string;
  rules: { maxHoldings: 39; maxCompanyWeight: number | null; maxSectorWeight: number | null; benchmark: string };
  positions: PortfolioPosition[]; cash: PortfolioCash[];
};
export type PortfolioTask = {
  id: string; kind: 'setup' | 'data' | 'risk' | 'research'; subject: string;
  title: string; reason: string; evidence: string[]; action: string;
  decision: PortfolioDecision | null;
};
export type PortfolioDecision = {
  taskId: string; choice: 'keep' | 'reviewed' | 'defer'; reason: string;
  until: string | null; recordedAt: string; task: Omit<PortfolioTask, 'decision'>;
};
export type PortfolioVersion = {
  version: number; snapshotVersion: number; recordedAt: string;
  draft: PortfolioDraft; decisions: PortfolioDecision[]; proposals?: PortfolioProposal[];
};
export type PortfolioAssessment = {
  nav: number | null; equityValue: number | null; cashValue: number | null;
  securityCount: number; companyCount: number;
  companies: Array<{ id: string; name: string; value: number | null; weight: number | null }>;
  sectors: Array<{ id: string; name: string; value: number | null; weight: number | null }>;
  tasks: PortfolioTask[]; limitations: string[]; executable: false;
};
export type PortfolioRead = {
  current: PortfolioVersion | null; template: PortfolioDraft; assessment: PortfolioAssessment;
  history: Array<{ version: number; snapshotVersion: number; recordedAt: string }>;
};

/** Match the observation dashboard API convention; US tickers are bare in the universe. */
export function portfolioSecurityCode(security: { ticker: string; market: string }): string {
  return security.market === 'US' && !security.ticker.endsWith('.US') ? security.ticker + '.US' : security.ticker;
}

export type PortfolioProposalInput = {
  title: string; rationale: string; target: PortfolioDraft;
  /** Costs and new cash are in base currency. Never infer from price changes. */
  estimatedCosts: number | null; externalCashFlow: number;
};
export type PortfolioProposal = PortfolioProposalInput & {
  id: string; basedOnSnapshot: number; createdAt: string;
  status: 'draft' | 'confirmed' | 'rejected'; reviewReason: string | null;
  before: PortfolioAssessment; after: PortfolioAssessment;
  comparison: { turnover: number | null; fundingGap: number | null; issues: string[];
    changes: Array<{ account: string; code: string; beforeQuantity: number; afterQuantity: number; valueChange: number | null }> };
  executable: false;
};
