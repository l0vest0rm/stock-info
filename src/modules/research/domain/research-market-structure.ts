import marketStructureConfig from "../../../../config/research-market-structure-requirements.json";
import type { ResearchInstrumentKind, ResearchMarket } from "./research-identity";

type ValueKind = "number" | "text";
export type MarketStructureMeasurementBasis = "period_end_outstanding" | "weighted_average_eps";
export type MarketStructureFactStatus = "verified" | "unavailable" | "not_applicable" | "conflicting";
export type MarketStructureFrequency = "event" | "annual" | "quarterly" | "periodic" | "rule_change";
export type MarketStructureEpistemicType = "observed_fact" | "source_viewpoint";
export type MarketStructureSourceAuthority = "issuer_disclosure" | "exchange_rule" | "regulator_filing" | "regulator_rule" | "depositary_agreement" | "tax_authority_rule" | "broker_rule";

export type MarketStructureFactDefinition = { label: string; valueKind: ValueKind };
export type ResearchMarketStructureFact = {
  marketStructureFactId: string;
  securityCode: string;
  factKey: string;
  factStatus: MarketStructureFactStatus;
  valueKind: ValueKind;
  valueNumber: number | null;
  valueText: string | null;
  unit: string | null;
  measurementBasis: MarketStructureMeasurementBasis | null;
  asOf: string;
  frequency: MarketStructureFrequency;
  epistemicType: MarketStructureEpistemicType;
  sourceAuthority: MarketStructureSourceAuthority;
  sourceUrl: string;
  sourceTitle: string;
  sourceNote: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: number;
};

export type MarketStructureRequirementReason = "source_backed_observed_fact" | "missing_source_bound_record" | "weighted_average_eps_not_period_end" | "source_viewpoint_not_observed_fact" | "source_record_unavailable" | "source_record_not_applicable" | "source_records_conflict";
export type MarketStructureRequirement = MarketStructureFactDefinition & {
  factKey: string;
  state: "verified" | "weighted_average_only" | "missing" | "unavailable" | "not_applicable" | "conflicting" | "source_viewpoint";
  /** Why this requirement does or does not satisfy a security-level gate.
   * Consumers must not turn absence, a source viewpoint, or an EPS denominator
   * into a neutral/usable security fact. */
  reasonCode: MarketStructureRequirementReason;
  fact: ResearchMarketStructureFact | null;
};
export type MarketStructureGate = { status: "ready" | "blocked"; reason: string | null; missingFactKeys: string[] };
export type ResearchMarketStructure = {
  ruleVersion: string;
  profileId: string;
  requirements: MarketStructureRequirement[];
  latestFacts: ResearchMarketStructureFact[];
  auditableFacts: ResearchMarketStructureFact[];
  perShareValuation: MarketStructureGate;
  crossSecurityComparison: MarketStructureGate;
};

const config = marketStructureConfig as {
  version: string;
  facts: Record<string, MarketStructureFactDefinition>;
  profiles: Record<string, string[]>;
  valuationRequired: string[];
  crossSecurityRequired: "all";
};

export function researchMarketStructureConfigVersion(): string { return required(config.version, "market structure config version"); }
export function marketStructureFactDefinitions(): Record<string, MarketStructureFactDefinition> { return Object.fromEntries(Object.entries(config.facts).map(([key, value]) => [key, { ...value }])); }

/** A security uses a configuration profile, never a ticker/name heuristic. */
export function marketStructureProfileId(market: ResearchMarket, instrumentKind: ResearchInstrumentKind): string {
  const kind = instrumentKind === "adr" ? "adr" : "equity";
  const id = `${market}:${kind}`;
  if (!config.profiles[id]) throw new Error(`market structure profile is not configured: ${id}`);
  return id;
}

export function assertMarketStructureFact(input: Omit<ResearchMarketStructureFact, "createdAt">): void {
  const definition = config.facts[input.factKey];
  if (!definition) throw new Error("market structure factKey is not configured");
  if (input.valueKind !== definition.valueKind) throw new Error("market structure valueKind does not match configured fact");
  if (!["verified", "unavailable", "not_applicable", "conflicting"].includes(input.factStatus)) throw new Error("market structure factStatus is invalid");
  if (!["event", "annual", "quarterly", "periodic", "rule_change"].includes(input.frequency)) throw new Error("market structure frequency is invalid");
  if (!["observed_fact", "source_viewpoint"].includes(input.epistemicType)) throw new Error("market structure epistemicType is invalid");
  if (!["issuer_disclosure", "exchange_rule", "regulator_filing", "regulator_rule", "depositary_agreement", "tax_authority_rule", "broker_rule"].includes(input.sourceAuthority)) throw new Error("market structure sourceAuthority is invalid");
  required(input.marketStructureFactId, "marketStructureFactId"); required(input.securityCode, "securityCode"); requiredDate(input.asOf, "asOf");
  required(input.sourceTitle, "sourceTitle"); required(input.sourceNote, "sourceNote"); requiredHttps(input.sourceUrl, "sourceUrl");
  if (input.factStatus === "verified") {
    if (input.valueKind === "number" && (!Number.isFinite(input.valueNumber) || input.valueNumber === null || !required(input.unit ?? "", "unit"))) throw new Error("verified numeric market structure fact requires a finite valueNumber and unit");
    if (input.valueKind === "text" && !required(input.valueText ?? "", "valueText")) throw new Error("verified text market structure fact requires valueText");
  }
  if (input.valueKind === "number" && input.valueText !== null) throw new Error("numeric market structure fact cannot carry valueText");
  if (input.valueKind === "text" && input.valueNumber !== null) throw new Error("text market structure fact cannot carry valueNumber");
  const isShareCount = input.factKey === "basic_shares" || input.factKey === "diluted_shares";
  if (isShareCount && !["period_end_outstanding", "weighted_average_eps"].includes(input.measurementBasis ?? "")) throw new Error("share-count market structure fact requires measurementBasis");
  if (!isShareCount && input.measurementBasis !== null) throw new Error("measurementBasis is only allowed for share-count market structure facts");
}

/**
 * No implicit completion: only a source-backed observed fact with a verified
 * status satisfies a configured requirement. A formal "not applicable" still
 * remains visible and blocks comparison unless that profile omits the field.
 */
export function buildResearchMarketStructure(input: { market: ResearchMarket; instrumentKind: ResearchInstrumentKind; facts: ResearchMarketStructureFact[] }): ResearchMarketStructure {
  const profileId = marketStructureProfileId(input.market, input.instrumentKind);
  const requiredKeys = config.profiles[profileId];
  const auditableFacts = [...input.facts].sort((left, right) => right.createdAt - left.createdAt || right.asOf.localeCompare(left.asOf));
  const byKey = new Map<string, ResearchMarketStructureFact[]>();
  for (const fact of auditableFacts) byKey.set(fact.factKey, [...(byKey.get(fact.factKey) ?? []), fact]);
  const requirements = requiredKeys.map((factKey) => {
    const records = byKey.get(factKey) ?? [];
    const shareCount = factKey === "basic_shares" || factKey === "diluted_shares";
    const qualifying = records.find((fact) => fact.factStatus === "verified" && fact.epistemicType === "observed_fact" && (!shareCount || fact.measurementBasis === "period_end_outstanding"));
    const fact = qualifying ?? records[0] ?? null;
    const state: MarketStructureRequirement["state"] = !fact ? "missing"
      : qualifying ? "verified"
      : shareCount && fact.measurementBasis === "weighted_average_eps" ? "weighted_average_only"
      : fact.factStatus === "verified" ? "source_viewpoint" : fact.factStatus;
    const reasonCode: MarketStructureRequirementReason = !fact ? "missing_source_bound_record"
      : qualifying ? "source_backed_observed_fact"
      : shareCount && fact.measurementBasis === "weighted_average_eps" ? "weighted_average_eps_not_period_end"
      : fact.factStatus === "verified" ? "source_viewpoint_not_observed_fact"
      : fact.factStatus === "unavailable" ? "source_record_unavailable"
      : fact.factStatus === "not_applicable" ? "source_record_not_applicable"
      : "source_records_conflict";
    return { factKey, ...(config.facts[factKey] ?? { label: factKey, valueKind: "text" as const }), state, reasonCode, fact };
  });
  const gate = (keys: string[], purpose: string): MarketStructureGate => {
    const missingFactKeys = keys.filter((key) => requirements.find((item) => item.factKey === key)?.state !== "verified");
    return missingFactKeys.length ? { status: "blocked", missingFactKeys, reason: `${purpose} requires source-backed observed facts: ${missingFactKeys.join(", ")}` } : { status: "ready", missingFactKeys: [], reason: null };
  };
  return {
    ruleVersion: researchMarketStructureConfigVersion(), profileId, requirements,
    latestFacts: requirements.flatMap((item) => item.fact ? [item.fact] : []),
    auditableFacts,
    // An ADR's ratio is mathematical input to every ADS-level value; the
    // remaining depositary/VIE facts still block cross-security comparison.
    perShareValuation: gate(input.instrumentKind === "adr" ? [...config.valuationRequired, "adr_ratio"] : config.valuationRequired, "per-share valuation"),
    crossSecurityComparison: gate(requiredKeys, "cross-security comparison"),
  };
}

function required(value: string, label: string): string { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
function requiredDate(value: string, label: string): void { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${label} must be YYYY-MM-DD`); }
function requiredHttps(value: string, label: string): void { let url: URL; try { url = new URL(required(value, label)); } catch { throw new Error(`${label} must be an absolute https URL`); } if (url.protocol !== "https:") throw new Error(`${label} must be an absolute https URL`); }
