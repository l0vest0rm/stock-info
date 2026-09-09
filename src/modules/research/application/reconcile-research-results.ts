import type { Bindings } from "../../../types";
import { listResearchResultsToReconcile } from "../infrastructure/research-result-repository";
import { reconcileResearchInvestmentAnalysis } from "./research-investment-analysis";
import { reconcileResearchFinancialAnalysis } from "./research-financial-analysis";

/** Observe only locally recorded runs. Never submit or recover provider work. */
export async function reconcileResearchResults(env: Bindings, onError: (code: string, error: unknown) => void = () => {}): Promise<{ inspected: number; failed: number }> {
  if (env.LLM_RUNTIME !== "local") return { inspected: 0, failed: 0 };
  const records = await listResearchResultsToReconcile(env.DB);
  let failed = 0;
  // Bound pressure on taskd/SQLite; one failed artifact cannot block others.
  for (const record of records) {
    try {
      if (record.namespace === "research_investment_analysis") await reconcileResearchInvestmentAnalysis(env, record.code);
      else await reconcileResearchFinancialAnalysis(env, record.code);
    } catch (error) {
      failed += 1;
      onError(record.code, error);
    }
  }
  return { inspected: records.length, failed };
}
