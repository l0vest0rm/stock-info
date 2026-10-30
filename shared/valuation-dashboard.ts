import type { InvestmentOpportunity } from './investment-opportunity';
import type { ValuationAssessment } from './valuation-assessment';
import type { ValuationScreenResult } from './valuation-screen';

export const VALUATION_FRESHNESS_MS = 10 * 60_000;

export type ValuationScreenRow = {
  researchVersion?: number;
  assessment?: ValuationAssessment;
  opportunity?: InvestmentOpportunity;
  code: string;
  name: string;
  market: "CN" | "HK" | "US" | "KR";
  /** The archetype the band engine actually used, not the JSON's copy. */
  archetype: string;
  verdict: ValuationScreenResult["verdict"];
  /** Which band carried the verdict, so a reader can see the method. */
  basis: ValuationScreenResult["basis"];
  position: ValuationScreenResult["position"];
  /**
   * Domain reasons, plus the two facts that live one layer below the domain:
   * the quote provider failed, or this row's computation threw.  `valuation-screen`
   * cannot know either — it is given a quote or not — so they are declared here
   * rather than widening the domain union and making two of its members
   * unreachable from its own self-test.
   */
  blockReasons: Array<ValuationScreenResult["blockReasons"][number] | "quote_fetch_failed" | "request_failed" | "financial_refresh_failed" | "stale_quote">;
  note: string;
  /** Growth reading, present even when it changed nothing. */
  growth: ValuationScreenResult["growth"] | null;
  /** Always false; carried on every row so a consumer cannot lose the fact. */
  executable: false;
  /** Why the row could not be computed, phrased as a data fact. */
  unavailableReason?: string;
};

export type DashboardRow = ValuationScreenRow & {
  computation: { id: string; revision: string; computedAt: string };
};

/** Rolling read model, explicitly NOT a point-in-time backtest snapshot. */
export type ValuationDashboard = {
  schemaVersion: 5;
  mode: 'rolling';
  revision: string;
  freshnessMs: number;
  asOf: string;
  generatedAt: string | null;
  oldestComputedAt: string | null;
  companies: number;
  targets: string[];
  rows: DashboardRow[];
  byVerdict: Record<string, number>;
  blockedDetail: Record<string, number>;
  pending: string[];
  stale: boolean;
  warnings: string[];
};
export type DashboardRefresh = { state: 'complete' | 'busy'; row: DashboardRow | null };
