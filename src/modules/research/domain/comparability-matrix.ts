/**
 * Comparability matrix: which companies may be compared on which metric.
 *
 * The P1-3 finding from the depreciation work is that a single EV/EBITDA yard
 * stick silently mis-prices capital intensity: 比亚迪 and 中芯国际 carry
 * depreciation ≈ 5.6× EBIT, 中际旭创 0.07×.  Same multiple, opposite meaning.
 *
 * This module turns that into a code-level gate rather than a document note:
 * - every pair of companies is compared only on metrics both are eligible for;
 * - eligibility needs a matching archetype, a matching capital-intensity class,
 *   and a metric the archetype does not forbid;
 * - a comparison that fails any gate is reported with its reason, never
 *   dropped, so a reader can see the expected peer that was refused.
 *
 * No price and no target multiple live here.  The output is a comparability
 * verdict plus the inputs each company would contribute.
 */

import { companyValuationArchetype, valuationProfileFor, type ValuationArchetype } from "./valuation-coverage";

/**
 * Capital-intensity classes.  The thresholds come from the measured
 * depreciation/EBIT ratios in docs/investment-valuation-data-contract.md:
 * light < 0.5 (中际旭创 0.07), medium 0.5–1, heavy > 1 (中远海控 1.44,
 * 比亚迪 / 中芯国际 5.6).
 */
export type CapitalIntensityClass = "light" | "medium" | "heavy";

export const CAPITAL_INTENSITY_THRESHOLDS = { light: 0.5, heavy: 1 } as const;

export type ComparisonMetric = "pe_ttm" | "pe_mid_cycle" | "ev_ebit" | "ev_ebitda" | "ev_revenue" | "pb" | "fcf_yield" | "dividend_yield";

/**
 * Metrics that stay valid across capital-intensity classes.  EBIT already
 * carries depreciation, so EV/EBIT is comparable; EBITDA deliberately strips it
 * out, which is exactly what makes it look cheap for asset-heavy companies.
 */
const CAPITAL_INTENSITY_SENSITIVE = new Set<ComparisonMetric>(["ev_ebitda", "ev_revenue", "pb", "fcf_yield"]);

/**
 * Metrics whose validity depends on the earnings being a through-cycle centre.
 * Two cyclicals may only be compared on the cycle if both centres exist.
 */
const CYCLE_SENSITIVE = new Set<ComparisonMetric>(["pe_ttm", "pe_mid_cycle"]);

export type CompanyComparisonInput = {
  code: string;
  /** Measured annual depreciation / EBIT.  Null when EBITDA is unavailable. */
  depreciationToEbit?: number | null;
  /** Mid-cycle centre availability, only meaningful for cyclicals. */
  midCycleAvailable?: boolean | null;
  /**
   * Which metrics this company can actually support, e.g. `pe_ttm` needs a
   * positive TTM profit.  Absent means "assume the archetype rules only".
   */
  availableMetrics?: ComparisonMetric[] | null;
  /** Reported multiples, used to show magnitude once comparability holds. */
  metrics?: Partial<Record<ComparisonMetric, number | null>>;
};

export type ComparabilityBlock = {
  metric: ComparisonMetric;
  reason: string;
};

export type PeerComparison = {
  peer: string;
  /** Metrics both companies may be compared on. */
  comparableMetrics: ComparisonMetric[];
  /** Metrics refused for this pair, each with the gate that refused it. */
  blocked: ComparabilityBlock[];
};

export type ComparabilityMatrix = {
  code: string;
  archetype: ValuationArchetype;
  capitalIntensity: { ratio: number | null; class: CapitalIntensityClass | "unknown" };
  /** Metrics allowed by the archetype alone, before any pair comparison. */
  archetypeMetrics: ComparisonMetric[];
  /** Metrics the archetype explicitly forbids. */
  forbiddenMetrics: ComparisonMetric[];
  peers: PeerComparison[];
  /** Diagnostic list a reader must see before comparing. */
  notes: string[];
};

const ARCHETYPE_METRICS: Record<ValuationArchetype, { allowed: ComparisonMetric[]; forbidden: ComparisonMetric[] }> = {
  bank: { allowed: ["pb", "pe_ttm", "dividend_yield"], forbidden: ["ev_ebit", "ev_ebitda", "ev_revenue", "fcf_yield"] },
  insurer: { allowed: ["pe_ttm", "dividend_yield"], forbidden: ["pb", "ev_ebit", "ev_ebitda", "ev_revenue", "fcf_yield"] },
  exchange: { allowed: ["pe_ttm", "ev_ebit", "pb"], forbidden: ["ev_ebitda"] },
  payment: { allowed: ["pe_ttm", "ev_ebit", "ev_ebitda", "fcf_yield"], forbidden: [] },
  property_operator: { allowed: ["pb", "dividend_yield", "ev_ebitda"], forbidden: ["pe_ttm"] },
  cyclical_commodity: { allowed: ["pe_mid_cycle", "ev_ebit", "ev_ebitda", "pe_ttm"], forbidden: ["fcf_yield"] },
  stable_cash_dividend: { allowed: ["fcf_yield", "dividend_yield", "pe_ttm", "ev_ebit"], forbidden: ["ev_revenue"] },
  growth_manufacturing: { allowed: ["pe_ttm", "ev_ebit", "ev_ebitda", "fcf_yield", "pb"], forbidden: [] },
  software_platform: { allowed: ["pe_ttm", "ev_ebit", "ev_revenue", "fcf_yield"], forbidden: ["pb"] },
  pre_profit_milestone: { allowed: ["ev_revenue"], forbidden: ["pe_ttm", "pe_mid_cycle", "ev_ebit", "ev_ebitda", "pb", "fcf_yield", "dividend_yield"] },
  healthcare_services: { allowed: ["pe_ttm", "ev_ebit", "ev_ebitda", "pb"], forbidden: ["ev_revenue"] },
  other: { allowed: ["pe_ttm"], forbidden: [] },
};

export function capitalIntensityClass(ratio: number | null | undefined): CapitalIntensityClass | "unknown" {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "unknown";
  if (ratio < CAPITAL_INTENSITY_THRESHOLDS.light) return "light";
  if (ratio <= CAPITAL_INTENSITY_THRESHOLDS.heavy) return "medium";
  return "heavy";
}

/** Archetypes whose allowed/forbidden method set is the comparability rule. */
export function comparisonRulesFor(archetype: ValuationArchetype) {
  return ARCHETYPE_METRICS[archetype] ?? ARCHETYPE_METRICS.other;
}

/**
 * Compare one company against an explicit peer list.  Peers come from the
 * caller (a curator's peer set), never from an automatic industry label: the
 * whole point of the archetype system is that industry labels mis-route.
 */
export function buildComparabilityMatrix(input: {
  company: CompanyComparisonInput;
  peers: CompanyComparisonInput[];
}): ComparabilityMatrix {
  const archetype = companyValuationArchetype(input.company.code) ?? "other";
  const rules = comparisonRulesFor(archetype);
  const intensity = capitalIntensityClass(input.company.depreciationToEbit);
  const notes: string[] = [];

  const supported = (item: CompanyComparisonInput, metric: ComparisonMetric) =>
    item.availableMetrics ? item.availableMetrics.includes(metric) : true;

  const peers = input.peers.map((peer): PeerComparison => {
    const peerArchetype = companyValuationArchetype(peer.code) ?? "other";
    const peerIntensity = capitalIntensityClass(peer.depreciationToEbit);
    const comparableMetrics: ComparisonMetric[] = [];
    const blocked: ComparabilityBlock[] = [];

    for (const metric of rules.allowed) {
      const peerRules = comparisonRulesFor(peerArchetype);
      if (peerArchetype !== archetype) {
        blocked.push({ metric, reason: `业务模型不同（${archetype} vs ${peerArchetype}），倍数口径不可互换。` });
        continue;
      }
      if (!peerRules.allowed.includes(metric)) {
        blocked.push({ metric, reason: `对方原型禁用 ${metric}。` });
        continue;
      }
      if (CAPITAL_INTENSITY_SENSITIVE.has(metric) && intensity !== "unknown" && peerIntensity !== "unknown" && intensity !== peerIntensity) {
        blocked.push({ metric, reason: `资本密度不同（${intensity} vs ${peerIntensity}），${metric} 会系统性偏移。` });
        continue;
      }
      if (CYCLE_SENSITIVE.has(metric) && archetype === "cyclical_commodity" && (!input.company.midCycleAvailable || !peer.midCycleAvailable)) {
        blocked.push({ metric, reason: "周期股缺少一方或双方的中枢利润，利润类倍数不可比。" });
        continue;
      }
      if (!supported(input.company, metric) || !supported(peer, metric)) {
        blocked.push({ metric, reason: "一方缺少该口径的分母。" });
        continue;
      }
      comparableMetrics.push(metric);
    }
    return { peer: peer.code, comparableMetrics, blocked };
  });

  if (intensity === "unknown") {
    notes.push("本公司缺少折旧摊销，无法判定资本密度；带资本密度门槛的倍数对比默认不可用。");
  }
  if (archetype === "cyclical_commodity") {
    notes.push("周期股只能与同为周期型、且双方中枢利润都成立的公司比较利润倍数；TTM 倍数在周期两端都失真。");
  }
  if (peers.length === 0) {
    notes.push("未提供可比公司；矩阵为空不表示可自由套用任何倍数。");
  }
  const profile = valuationProfileFor(archetype);
  notes.push(`原型 ${archetype} 的主方法：${profile.methods.filter((method) => method.role === "primary").map((method) => method.label).join("、") || "无"}`);

  return {
    code: input.company.code,
    archetype,
    capitalIntensity: { ratio: input.company.depreciationToEbit ?? null, class: intensity },
    archetypeMetrics: rules.allowed,
    forbiddenMetrics: rules.forbidden,
    peers,
    notes,
  };
}
