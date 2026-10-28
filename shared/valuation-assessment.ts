/** Public valuation dashboard contract; no server/runtime dependencies. */
export type ValuationAssessment = {
  status: 'undervalued' | 'fair_low' | 'fair' | 'expensive' | 'very_expensive' | 'unknown';
  confidence: 'medium' | 'low';
  method: string | null;
  current: number | null;
  unit: 'multiple' | 'percent' | null;
  range: { low: number; high: number } | null;
  conservativeMargin: number | null;
  assumptions: string[];
  limitations: string[];
  quote: { source: string; date: string | null; fetchedAt: string } | null;
  history: { metric: string; windows: Array<{ years: number; percentile: number | null; samples: number; from: string | null; to: string | null }>; note: string };
  operating: { reportDate: string | null; periodLabel: string; revenueYoY: number | null; profitYoY: number | null; ttmGrowth: number | null; provisional: boolean };
  future: null;
  computedAt: string;
};

