/**
 * Assemble a comparability matrix for one security from measured inputs.
 *
 * Capital intensity is measured, not assumed: the ratio comes from the same
 * depreciation/EBIT pair the valuation inputs already derive, so a company is
 * grouped by the figure its own cash-flow supplement discloses.  When EBITDA is
 * unavailable the class is `unknown` and the intensity-sensitive metrics are
 * refused rather than guessed.
 */
import { normalizeSecurityCode } from "../../../shared/codes";
import { externalHttpOptions, type ExternalHttpOptions } from "../../../shared/http";
import type { Bindings } from "../../../types";
import { buildComparabilityMatrix, type ComparabilityMatrix, type CompanyComparisonInput } from "../domain/comparability-matrix";
import { companyValuationArchetype } from "../domain/valuation-coverage";
import { loadValuationInputs } from "../../finance/application/load-valuation-inputs";
import { loadMidCycleHistory } from "../../finance/application/load-mid-cycle-history";

type Environment = Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">;

export async function loadComparabilityMatrix(
  env: Environment,
  rawCode: string,
  peerCodes: string[],
  options?: { httpOptions?: ExternalHttpOptions },
): Promise<ComparabilityMatrix> {
  const code = normalizeSecurityCode(rawCode);
  const httpOptions = options?.httpOptions ?? externalHttpOptions(env);
  const peers = peerCodes.map((peer) => normalizeSecurityCode(peer)).filter((peer) => peer && peer !== code);
  const [company, ...peerInputs] = await Promise.all([code, ...peers].map((item) => measure(env, item, httpOptions)));
  return buildComparabilityMatrix({ company, peers: peerInputs });
}

async function measure(env: Environment, code: string, httpOptions: ExternalHttpOptions): Promise<CompanyComparisonInput> {
  const archetype = companyValuationArchetype(code);
  const [inputs, midCycle] = await Promise.all([
    loadValuationInputs(env, code, { httpOptions }).catch(() => null),
    archetype === "cyclical_commodity"
      ? loadMidCycleHistory(env, code, { httpOptions }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const value = (key: string) => inputs?.lines.find((line) => line.key === key)?.value ?? null;
  const ebit = value("ebit");
  const ebitda = value("ebitda");
  const availableMetrics: CompanyComparisonInput["availableMetrics"] = [];
  if ((value("netProfit") ?? null) !== null) availableMetrics.push("pe_ttm");
  if (ebit !== null) availableMetrics.push("ev_ebit");
  if (ebitda !== null) availableMetrics.push("ev_ebitda");
  if (value("parentEquity") !== null) availableMetrics.push("pb");
  if (midCycle?.earnings.status === "available" && midCycle.earnings.median !== null) availableMetrics.push("pe_mid_cycle");
  return {
    code,
    depreciationToEbit: ebit !== null && ebit > 0 && ebitda !== null ? (ebitda - ebit) / ebit : null,
    midCycleAvailable: midCycle ? midCycle.earnings.status === "available" : null,
    availableMetrics,
  };
}
