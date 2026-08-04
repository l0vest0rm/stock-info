import { assertAsOf, assertSourceReferences, type ResearchEpistemicType, type ResearchSourceReference } from "./research-dossier";

/**
 * Immutable relative-valuation evidence.  This intentionally records a
 * method, its peer universe and its comparability limits, rather than a
 * peer-average target price or a recommendation.
 */
export const RELATIVE_VALUATION_ARCHETYPES = [
  "growth_earnings", "stable_cash_dividend", "cyclical_commodity", "bank",
  "insurer_broker", "asset_utility", "pre_profit_milestone", "conglomerate_sotp", "other",
] as const;
export const RELATIVE_VALUATION_METHODS = [
  "forward_pe", "ev_ebitda", "ev_revenue", "pb_roe", "pb", "fcf_yield",
  "dividend_yield", "nav", "price_to_embedded_value", "other",
] as const;
export const RELATIVE_VALUATION_GATE_KINDS = [
  "accounting_basis", "fiscal_period", "currency", "business_scope", "cycle_position", "security_rights",
] as const;

export type RelativeValuationRole = "primary" | "auxiliary";
export type RelativeValuationArchetype = typeof RELATIVE_VALUATION_ARCHETYPES[number];
export type RelativeValuationMethod = typeof RELATIVE_VALUATION_METHODS[number];
export type RelativeValuationMetricType = "pe" | "ev_ebitda" | "ev_revenue" | "pb" | "fcf_yield" | "dividend_yield" | "nav" | "other";
export type RelativeValuationInputKind = "source_fact" | "forward_input" | "assumption";
export type RelativeValuationSubjectKind = "target" | "peer";
export type RelativeValuationGateKind = typeof RELATIVE_VALUATION_GATE_KINDS[number];
export type RelativeValuationGateStatus = "passed" | "adjustment_required" | "blocked" | "not_assessed";

export type RelativeValuationInput = {
  inputId: string;
  subjectKind: RelativeValuationSubjectKind;
  /** Required for a peer and points to the pre-reviewed peer-universe member. */
  peerMemberId: string | null;
  inputKind: RelativeValuationInputKind;
  key: string;
  label: string;
  value: number;
  unit: string;
  currency: string | null;
  amountScale: string | null;
  fiscalYear: number | null;
  periodLabel: string | null;
  asOf: number;
  epistemicType: Extract<ResearchEpistemicType, "observed_fact" | "management_guidance" | "third_party_forecast" | "analysis_assumption">;
  sourceReferences: ResearchSourceReference[];
};

export type RelativeValuationMetric = {
  metricId: string;
  subjectKind: RelativeValuationSubjectKind;
  peerMemberId: string | null;
  metricType: RelativeValuationMetricType;
  periodBasis: "trailing" | "forward" | "normalized" | "other";
  fiscalYear: number | null;
  definition: string;
  numeratorInputId: string;
  denominatorInputId: string;
  displayUnit: string;
  /** Derived from the frozen input pair; never independently entered. */
  value: number;
};

export type RelativeValuationComparabilityGate = {
  gateId: string;
  gateKind: RelativeValuationGateKind;
  status: RelativeValuationGateStatus;
  rationale: string;
  sourceReferences: ResearchSourceReference[];
};

export type RelativeValuationBlockedReason = {
  code: `comparability_${string}` | "no_peer_metrics" | "no_target_metrics";
  gateKind: RelativeValuationGateKind | null;
  message: string;
};

export type RelativeValuationReadiness = {
  status: "ready" | "requires_adjustment" | "blocked";
  blockedReasons: RelativeValuationBlockedReason[];
};

export type ResearchRelativeValuationLedger = {
  ledgerId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  status: "draft" | "reviewed";
  role: RelativeValuationRole;
  archetype: RelativeValuationArchetype;
  method: RelativeValuationMethod;
  /** A separately versioned, source-bound peer universe (not an implicit list). */
  peerUniverseId: string;
  valuationCurrency: string;
  securityCurrency: string;
  applicabilityRationale: string;
  rationaleSourceReferences: ResearchSourceReference[];
  supersedesLedgerId: string | null;
  inputs: RelativeValuationInput[];
  metrics: RelativeValuationMetric[];
  comparabilityGates: RelativeValuationComparabilityGate[];
  readiness: RelativeValuationReadiness;
  createdAt: number;
};

export type BuildRelativeValuationLedgerInput = Omit<ResearchRelativeValuationLedger, "metrics" | "readiness"> & {
  metrics: Omit<RelativeValuationMetric, "value">[];
};

/** Validates and deterministically replays a frozen relative-valuation record. */
export function buildRelativeValuationLedger(input: BuildRelativeValuationLedgerInput): ResearchRelativeValuationLedger {
  assertAsOf(input.asOf); assertAsOf(input.createdAt);
  required(input.ledgerId, "relative valuation ledger id"); required(input.securityCode, "relative valuation security code");
  required(input.peerUniverseId, "relative valuation peer universe id"); required(input.applicabilityRationale, "relative valuation applicability rationale");
  currency(input.valuationCurrency, "relative valuation currency"); currency(input.securityCurrency, "relative valuation security currency");
  enumValue(input.role, ["primary", "auxiliary"], "relative valuation role");
  enumValue(input.archetype, RELATIVE_VALUATION_ARCHETYPES, "relative valuation archetype");
  enumValue(input.method, RELATIVE_VALUATION_METHODS, "relative valuation method");
  requireEvidence(input.rationaleSourceReferences, "relative valuation applicability rationale");
  if (!input.inputs.length) throw new Error("relative valuation requires source facts, forward inputs, or assumptions");
  const inputs = new Map<string, RelativeValuationInput>();
  for (const item of input.inputs) {
    assertInput(item);
    if (inputs.has(item.inputId)) throw new Error(`duplicate relative valuation input id ${item.inputId}`);
    if ([...inputs.values()].some((previous) => previous.key === item.key && previous.subjectKind === item.subjectKind && previous.peerMemberId === item.peerMemberId)) {
      throw new Error(`duplicate relative valuation input key ${item.key} for the same subject`);
    }
    inputs.set(item.inputId, { ...item, currency: item.currency === null ? null : currency(item.currency, "relative valuation input currency") });
  }
  if (!input.metrics.length) throw new Error("relative valuation requires at least one deterministic metric");
  const metrics = input.metrics.map((item) => calculateMetric(item, inputs));
  if (!metrics.some((item) => item.subjectKind === "target")) throw new Error("relative valuation requires a target metric");
  if (!metrics.some((item) => item.subjectKind === "peer")) throw new Error("relative valuation requires at least one peer metric");
  const gates = assertGates(input.comparabilityGates);
  return {
    ...input,
    valuationCurrency: currency(input.valuationCurrency, "relative valuation currency"),
    securityCurrency: currency(input.securityCurrency, "relative valuation security currency"),
    inputs: [...inputs.values()], metrics, comparabilityGates: gates,
    readiness: assessRelativeValuationReadiness(metrics, gates),
  };
}

/** No peer aggregation is performed here: unresolved gates remain unresolved. */
export function assessRelativeValuationReadiness(
  metrics: RelativeValuationMetric[],
  gates: RelativeValuationComparabilityGate[],
): RelativeValuationReadiness {
  const blockedReasons: RelativeValuationBlockedReason[] = [];
  if (!metrics.some((metric) => metric.subjectKind === "target")) blockedReasons.push({ code: "no_target_metrics", gateKind: null, message: "缺少目标证券的可重放估值指标。" });
  if (!metrics.some((metric) => metric.subjectKind === "peer")) blockedReasons.push({ code: "no_peer_metrics", gateKind: null, message: "缺少已绑定同行成员的估值指标。" });
  for (const gate of gates) {
    if (gate.status === "passed") continue;
    blockedReasons.push({
      code: `comparability_${gate.gateKind}_${gate.status}`,
      gateKind: gate.gateKind,
      message: gate.status === "adjustment_required"
        ? `${gate.gateKind} requires the stated adjustment before a direct comparison.`
        : `${gate.gateKind} is ${gate.status}; direct comparison is blocked.`,
    });
  }
  if (blockedReasons.some((reason) => reason.code !== "no_target_metrics" && reason.code !== "no_peer_metrics" && !reason.code.endsWith("_adjustment_required")) || blockedReasons.some((reason) => reason.code === "no_target_metrics" || reason.code === "no_peer_metrics")) {
    return { status: "blocked", blockedReasons };
  }
  return { status: blockedReasons.length ? "requires_adjustment" : "ready", blockedReasons };
}

function assertInput(input: RelativeValuationInput): void {
  required(input.inputId, "relative valuation input id"); required(input.key, "relative valuation input key"); required(input.label, "relative valuation input label"); required(input.unit, "relative valuation input unit");
  if (!Number.isFinite(input.value)) throw new Error(`relative valuation input ${input.key} must be finite`);
  assertAsOf(input.asOf); subject(input.subjectKind, input.peerMemberId, "relative valuation input");
  enumValue(input.inputKind, ["source_fact", "forward_input", "assumption"], "relative valuation input kind");
  const expected = input.inputKind === "source_fact" ? ["observed_fact"] : input.inputKind === "assumption" ? ["analysis_assumption"] : ["management_guidance", "third_party_forecast", "analysis_assumption"];
  enumValue(input.epistemicType, expected, `relative valuation ${input.inputKind} epistemic type`);
  if (input.inputKind === "forward_input") {
    if (!Number.isInteger(input.fiscalYear) || input.fiscalYear! < 1900 || input.fiscalYear! > 2200) throw new Error("relative valuation forward input requires a fiscal year");
  } else if (input.fiscalYear !== null) throw new Error("only relative valuation forward inputs may carry a fiscal year");
  requireEvidence(input.sourceReferences, `relative valuation input ${input.key}`);
  assertSourceReferences(input.epistemicType, input.sourceReferences);
}

function calculateMetric(input: Omit<RelativeValuationMetric, "value">, inputs: Map<string, RelativeValuationInput>): RelativeValuationMetric {
  required(input.metricId, "relative valuation metric id"); required(input.definition, "relative valuation metric definition"); required(input.displayUnit, "relative valuation metric display unit");
  subject(input.subjectKind, input.peerMemberId, "relative valuation metric");
  enumValue(input.metricType, ["pe", "ev_ebitda", "ev_revenue", "pb", "fcf_yield", "dividend_yield", "nav", "other"], "relative valuation metric type");
  enumValue(input.periodBasis, ["trailing", "forward", "normalized", "other"], "relative valuation metric period basis");
  if (input.periodBasis === "forward") {
    if (!Number.isInteger(input.fiscalYear) || input.fiscalYear! < 1900 || input.fiscalYear! > 2200) throw new Error("forward relative valuation metrics require a fiscal year");
  } else if (input.fiscalYear !== null) throw new Error("only forward relative valuation metrics may carry a fiscal year");
  const numerator = inputs.get(input.numeratorInputId); const denominator = inputs.get(input.denominatorInputId);
  if (!numerator || !denominator) throw new Error("relative valuation metric references an unknown input");
  if (numerator.subjectKind !== input.subjectKind || denominator.subjectKind !== input.subjectKind || numerator.peerMemberId !== input.peerMemberId || denominator.peerMemberId !== input.peerMemberId) throw new Error("relative valuation metric inputs must belong to its target or peer subject");
  // A forward multiple commonly divides an observed valuation-date price or
  // EV by a forward earnings measure.  The denominator, rather than both
  // sides of the ratio, therefore has to retain the forward-year basis.
  if (input.periodBasis === "forward" && !isForwardInput(denominator)) throw new Error("forward relative valuation metrics require a forward-year denominator input");
  if (numerator.currency !== null && denominator.currency !== null && numerator.currency !== denominator.currency) throw new Error("relative valuation metric cannot divide different currencies without an explicit converted input");
  if (numerator.amountScale !== null && denominator.amountScale !== null && numerator.amountScale !== denominator.amountScale) throw new Error("relative valuation metric cannot divide different amount scales without an explicit converted input");
  if (denominator.value === 0) throw new Error("relative valuation metric denominator cannot be zero");
  return { ...input, value: numerator.value / denominator.value };
}

function assertGates(gates: RelativeValuationComparabilityGate[]): RelativeValuationComparabilityGate[] {
  if (gates.length !== RELATIVE_VALUATION_GATE_KINDS.length) throw new Error("relative valuation requires all comparability gates");
  const seen = new Set<RelativeValuationGateKind>();
  for (const gate of gates) {
    required(gate.gateId, "relative valuation comparability gate id"); required(gate.rationale, "relative valuation comparability gate rationale");
    enumValue(gate.gateKind, RELATIVE_VALUATION_GATE_KINDS, "relative valuation comparability gate"); enumValue(gate.status, ["passed", "adjustment_required", "blocked", "not_assessed"], "relative valuation comparability gate status");
    if (seen.has(gate.gateKind)) throw new Error(`duplicate relative valuation comparability gate ${gate.gateKind}`);
    seen.add(gate.gateKind); requireEvidence(gate.sourceReferences, `relative valuation ${gate.gateKind} gate`); assertSourceReferences("observed_fact", gate.sourceReferences);
  }
  for (const kind of RELATIVE_VALUATION_GATE_KINDS) if (!seen.has(kind)) throw new Error(`missing relative valuation comparability gate ${kind}`);
  return gates;
}

function isForwardInput(input: RelativeValuationInput): boolean { return input.inputKind === "forward_input" && input.fiscalYear !== null; }
function subject(kind: RelativeValuationSubjectKind, peerMemberId: string | null, label: string): void { if (kind === "target" && peerMemberId !== null) throw new Error(`${label} target must not carry a peer member id`); if (kind === "peer" && !peerMemberId?.trim()) throw new Error(`${label} peer requires a peer member id`); }
function requireEvidence(references: ResearchSourceReference[], label: string): void { if (!references.length) throw new Error(`${label} requires at least one source reference`); }
function required(value: string, label: string): string { if (!String(value ?? "").trim()) throw new Error(`${label} is required`); return value; }
function currency(value: string, label: string): string { return required(value, label).toUpperCase(); }
function enumValue<T extends string>(value: string, values: readonly T[], label: string): asserts value is T { if (!values.includes(value as T)) throw new Error(`${label} is invalid`); }
