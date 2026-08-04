import type { SelfBuiltOperatingScenario, SelfBuiltOperatingScenarioYear } from "../application/operating-scenario-valuation";
import { assertAsOf, assertSourceReferences, type ResearchEpistemicType, type ResearchSourceReference } from "./research-dossier";

export type ResearchTypedStatus = "draft" | "reviewed" | "superseded";
export type ResearchPublicEpistemicType = Exclude<ResearchEpistemicType, "user_decision">;
export type ResearchOperatingModel = {
  operatingModelId: string; companyId: string; asOf: number; version: number; status: ResearchTypedStatus;
  modelType: "product" | "project" | "subscription" | "platform" | "resource" | "financial" | "mixed" | "other";
  primaryEarningDriver: string; revenueRecognition: string; summary: string; epistemicType: ResearchPublicEpistemicType;
  sourceReferences: ResearchSourceReference[]; segments: ResearchOperatingSegment[]; growthConstraints: ResearchGrowthConstraint[]; createdAt: number; updatedAt: number;
};
export type ResearchOperatingSegment = {
  operatingSegmentId: string; name: string; productScope: string; customerScope: string; geographicScope: string; revenueFormula: string; revenueRecognition: string; sortOrder: number;
  sourceReferences: ResearchSourceReference[]; contracts: ResearchContractDriver[]; unitEconomics: ResearchUnitEconomic[];
};
export type ResearchContractDriver = { contractDriverId: string; contractType: "subscription" | "usage" | "project" | "framework" | "spot" | "regulated_tariff" | "other"; customerOrChannel: string; commitmentDescription: string; pricingBasis: string; renewalOrDeliveryConstraint: string; startPeriod: string | null; endPeriod: string | null; sortOrder: number; sourceReferences: ResearchSourceReference[]; };
export type ResearchUnitEconomic = { unitEconomicId: string; unitName: string; pricePerUnit: number | null; variableCostPerUnit: number | null; currency: string | null; amountScale: string | null; periodBasis: string; contributionDescription: string; sortOrder: number; sourceReferences: ResearchSourceReference[]; };
export type ResearchGrowthConstraint = { growthConstraintId: string; operatingSegmentId: string | null; constraintKind: "capacity" | "customer_concentration" | "certification" | "regulation" | "working_capital" | "technology" | "competition" | "supply_chain" | "capital" | "other"; description: string; affectedStatement: "income" | "balance" | "cashflow" | "multiple"; affectedDriver: string; invalidationOrReleaseCondition: string; sortOrder: number; sourceReferences: ResearchSourceReference[]; };

export type ResearchOperatingDriverPlan = {
  operatingDriverPlanId: string; operatingModelId: string; scenarioName: "downside" | "base" | "upside"; asOf: number; version: number; status: ResearchTypedStatus; valuationCurrency: string; amountScale: string; openingRevenue: number; openingNetWorkingCapital: number; epistemicType: "analysis_assumption" | "system_judgment"; sourceReferences: ResearchSourceReference[]; years: ResearchOperatingDriverPlanYear[]; createdAt: number; updatedAt: number;
};
export type ResearchOperatingDriverPlanYear = { operatingDriverPlanYearId: string; fiscalYear: number; taxRate: number; forecastNetDebt: number; sortOrder: number; sourceReferences: ResearchSourceReference[]; segments: ResearchOperatingDriverSegmentYear[]; };
export type ResearchOperatingDriverSegmentYear = { operatingDriverSegmentYearId: string; operatingSegmentId: string; volume: number; pricePerUnit: number; grossMargin: number; operatingExpenseMargin: number; depreciationAmortizationMargin: number; capitalExpenditureMargin: number; netWorkingCapitalToRevenue: number; sortOrder: number; sourceReferences: ResearchSourceReference[]; };
export type DriverPlanValuationBridge = { wacc: number; terminalGrowth: number; netDebtAtValuation: number; dilutedShares: number; sourceReferences: ResearchSourceReference[]; };

export type ResearchMarketSpaceAssessment = {
  marketSpaceAssessmentId: string; companyId: string; operatingModelId: string | null; asOf: number; version: number; status: ResearchTypedStatus; marketDefinition: string; productBoundary: string; geographicBoundary: string; customerBoundary: string; measurementDefinition: string; epistemicType: ResearchPublicEpistemicType; sourceReferences: ResearchSourceReference[]; estimates: ResearchMarketSpaceEstimate[]; shareBridges: ResearchMarketShareBridge[]; profitPools: ResearchMarketProfitPool[]; createdAt: number; updatedAt: number;
};
export type ResearchMarketSpaceEstimate = { marketSpaceEstimateId: string; layer: "tam" | "sam" | "som"; method: "top_down" | "bottom_up"; methodBasis: "terminal_demand" | "unit_value" | "customer_budget" | "supplier_sum" | "supply_capacity" | "company_capacity" | "customer_purchase" | "other"; amount: number; currency: string; amountScale: string; periodLabel: string; periodKind: "annual_flow" | "cumulative_stock" | "point_in_time" | "other"; calculationDescription: string; status: "available" | "incomplete" | "incomparable"; sortOrder: number; sourceReferences: ResearchSourceReference[]; };
export type ResearchMarketShareBridge = { marketShareBridgeId: string; shareType: "revenue" | "shipment" | "customer_wallet" | "new_market" | "profit_pool" | "capacity"; periodLabel: string; startingShare: number; endingShare: number; unit: "ratio" | "percent"; status: ResearchTypedStatus; sourceReferences: ResearchSourceReference[]; steps: ResearchMarketShareBridgeStep[]; createdAt: number; updatedAt: number; };
export type ResearchMarketShareBridgeStep = { marketShareBridgeStepId: string; stepKind: "new_customer" | "customer_expansion" | "new_product" | "customer_loss" | "product_retirement" | "capacity_constraint" | "competition" | "other"; direction: "gain" | "loss"; shareDelta: number; description: string; sortOrder: number; sourceReferences: ResearchSourceReference[]; };
export type ResearchMarketProfitPool = { marketProfitPoolId: string; periodLabel: string; industryRevenue: number; sustainableOperatingMargin: number; currency: string; amountScale: string; normalizationNote: string; status: ResearchTypedStatus; sourceReferences: ResearchSourceReference[]; createdAt: number; updatedAt: number; };

export type MarketReconciliation = { layer: "tam" | "sam" | "som"; status: "missing_method" | "incomparable" | "reconciled" | "conflict"; topDownEstimateId: string | null; bottomUpEstimateId: string | null; difference: number | null; divergenceRatio: number | null; reason: string | null; };
export type MarketSpaceHierarchyCheck = {
  status: "reconciled" | "blocked";
  estimateIds: { tam: string | null; sam: string | null; som: string | null };
  reason: string | null;
};
export type MarketShareBridgeCheck = { status: "reconciled" | "conflict"; expectedEndingShare: number; statedEndingShare: number; difference: number; unit: "ratio" | "percent"; };
export type MarketProfitPoolResult = { status: "available" | "incomplete"; amount: number | null; currency: string; amountScale: string; formula: string; };

export function assertResearchOperatingModel(input: ResearchOperatingModel): void {
  assertVersion(input, "operating model"); required(input.operatingModelId, "operatingModelId"); required(input.companyId, "companyId"); required(input.primaryEarningDriver, "primaryEarningDriver"); required(input.revenueRecognition, "revenueRecognition"); required(input.summary, "summary");
  const segmentIds = new Set<string>();
  for (const segment of input.segments) { required(segment.operatingSegmentId, "operatingSegmentId"); if (segmentIds.has(segment.operatingSegmentId)) throw new Error("duplicate operating segment id"); segmentIds.add(segment.operatingSegmentId); [segment.name, segment.productScope, segment.customerScope, segment.geographicScope, segment.revenueFormula, segment.revenueRecognition].forEach((value) => required(value, "operating segment field")); evidence(segment.sourceReferences, "operating segment"); for (const contract of segment.contracts) { [contract.contractDriverId, contract.customerOrChannel, contract.commitmentDescription, contract.pricingBasis, contract.renewalOrDeliveryConstraint].forEach((value) => required(value, "contract driver field")); evidence(contract.sourceReferences, "contract driver"); } for (const unit of segment.unitEconomics) { required(unit.unitEconomicId, "unitEconomicId"); required(unit.unitName, "unitName"); required(unit.periodBasis, "periodBasis"); required(unit.contributionDescription, "contributionDescription"); if ((unit.pricePerUnit === null) !== (unit.variableCostPerUnit === null)) throw new Error("unit economics require both price and variable cost, or neither"); if (unit.pricePerUnit !== null) { nonNegative(unit.pricePerUnit, "unit price"); nonNegative(unit.variableCostPerUnit!, "unit variable cost"); required(unit.currency ?? "", "unit currency"); required(unit.amountScale ?? "", "unit amountScale"); } evidence(unit.sourceReferences, "unit economic"); } }
  for (const constraint of input.growthConstraints) { if (constraint.operatingSegmentId && !segmentIds.has(constraint.operatingSegmentId)) throw new Error("growth constraint must reference a segment in the operating model"); [constraint.growthConstraintId, constraint.description, constraint.affectedDriver, constraint.invalidationOrReleaseCondition].forEach((value) => required(value, "growth constraint field")); evidence(constraint.sourceReferences, "growth constraint"); }
}

export function assertResearchOperatingDriverPlan(input: ResearchOperatingDriverPlan): void {
  assertVersion(input, "operating driver plan"); required(input.operatingDriverPlanId, "operatingDriverPlanId"); required(input.operatingModelId, "operatingModelId"); required(input.valuationCurrency, "valuationCurrency"); required(input.amountScale, "amountScale"); positive(input.openingRevenue, "openingRevenue"); finite(input.openingNetWorkingCapital, "openingNetWorkingCapital");
  if (!input.years.length) throw new Error("operating driver plan requires at least one fiscal year");
  input.years.forEach((year, yearIndex) => { if (!Number.isInteger(year.fiscalYear)) throw new Error("driver plan fiscal year must be an integer"); if (yearIndex && year.fiscalYear !== input.years[yearIndex - 1].fiscalYear + 1) throw new Error("driver plan fiscal years must be consecutive"); rate(year.taxRate, "driver plan taxRate"); finite(year.forecastNetDebt, "driver plan forecastNetDebt"); evidence(year.sourceReferences, "driver plan year"); if (!year.segments.length) throw new Error("each driver plan year requires at least one segment"); const segmentIds = new Set<string>(); year.segments.forEach((segment) => { if (segmentIds.has(segment.operatingSegmentId)) throw new Error("duplicate driver segment in fiscal year"); segmentIds.add(segment.operatingSegmentId); nonNegative(segment.volume, "driver volume"); finite(segment.pricePerUnit, "driver pricePerUnit"); [segment.grossMargin, segment.operatingExpenseMargin, segment.depreciationAmortizationMargin, segment.capitalExpenditureMargin, segment.netWorkingCapitalToRevenue].forEach((value) => rate(value, "driver margin")); evidence(segment.sourceReferences, "driver segment year"); }); });
}

export function assertResearchMarketSpaceAssessment(input: ResearchMarketSpaceAssessment): void {
  assertVersion(input, "market space assessment"); [input.marketSpaceAssessmentId, input.companyId, input.marketDefinition, input.productBoundary, input.geographicBoundary, input.customerBoundary, input.measurementDefinition].forEach((value) => required(value, "market space field"));
  for (const estimate of input.estimates) { [estimate.marketSpaceEstimateId, estimate.currency, estimate.amountScale, estimate.periodLabel, estimate.calculationDescription].forEach((value) => required(value, "market estimate field")); nonNegative(estimate.amount, "market estimate amount"); evidence(estimate.sourceReferences, "market estimate"); }
  for (const bridge of input.shareBridges) { [bridge.marketShareBridgeId, bridge.periodLabel].forEach((value) => required(value, "share bridge field")); share(bridge.startingShare, bridge.unit, "startingShare"); share(bridge.endingShare, bridge.unit, "endingShare"); evidence(bridge.sourceReferences, "share bridge"); bridge.steps.forEach((step) => { required(step.marketShareBridgeStepId, "marketShareBridgeStepId"); required(step.description, "share bridge step description"); nonNegative(step.shareDelta, "share delta"); evidence(step.sourceReferences, "share bridge step"); }); }
  for (const pool of input.profitPools) { [pool.marketProfitPoolId, pool.periodLabel, pool.currency, pool.amountScale, pool.normalizationNote].forEach((value) => required(value, "profit pool field")); nonNegative(pool.industryRevenue, "industryRevenue"); rate(pool.sustainableOperatingMargin, "sustainableOperatingMargin"); evidence(pool.sourceReferences, "profit pool"); }
}

export function compileDriverPlanToSelfBuiltScenario(plan: ResearchOperatingDriverPlan, valuation: DriverPlanValuationBridge): SelfBuiltOperatingScenario {
  assertResearchOperatingDriverPlan(plan); [valuation.wacc, valuation.terminalGrowth].forEach((value) => finite(value, "valuation rate")); if (valuation.wacc <= valuation.terminalGrowth) throw new Error("valuation wacc must be greater than terminalGrowth"); positive(valuation.dilutedShares, "dilutedShares"); finite(valuation.netDebtAtValuation, "netDebtAtValuation"); evidence(valuation.sourceReferences, "valuation bridge");
  let priorRevenue = plan.openingRevenue;
  const years: SelfBuiltOperatingScenarioYear[] = plan.years.map((year) => { const revenue = year.segments.reduce((sum, item) => sum + item.volume * item.pricePerUnit, 0); const weighted = (selector: (item: ResearchOperatingDriverSegmentYear) => number) => revenue === 0 ? 0 : year.segments.reduce((sum, item) => sum + item.volume * item.pricePerUnit * selector(item), 0) / revenue; const revenueGrowth = revenue / priorRevenue - 1; priorRevenue = revenue; return { fiscalYear: year.fiscalYear, revenueGrowth, ebitMargin: weighted((item) => item.grossMargin - item.operatingExpenseMargin), taxRate: year.taxRate, depreciationAmortizationMargin: weighted((item) => item.depreciationAmortizationMargin), capitalExpenditureMargin: weighted((item) => item.capitalExpenditureMargin), netWorkingCapitalToRevenue: weighted((item) => item.netWorkingCapitalToRevenue), forecastNetDebt: year.forecastNetDebt, sourceReferences: uniqueRefs([year.sourceReferences, ...year.segments.map((segment) => segment.sourceReferences)]) }; });
  return { scenarioId: plan.operatingDriverPlanId, scenarioName: plan.scenarioName, version: plan.version, asOf: plan.asOf, valuationCurrency: plan.valuationCurrency, amountScale: plan.amountScale, openingRevenue: plan.openingRevenue, openingNetWorkingCapital: plan.openingNetWorkingCapital, valuation, years, sourceReferences: plan.sourceReferences };
}

export function reconcileMarketSpaceEstimates(estimates: ResearchMarketSpaceEstimate[], toleranceRatio: number): MarketReconciliation[] {
  if (!Number.isFinite(toleranceRatio) || toleranceRatio < 0) throw new Error("market reconciliation toleranceRatio must be non-negative");
  return (["tam", "sam", "som"] as const).map((layer) => { const available = estimates.filter((item) => item.layer === layer && item.status === "available"); const top = available.filter((item) => item.method === "top_down"); const bottom = available.filter((item) => item.method === "bottom_up"); if (top.length !== 1 || bottom.length !== 1) return { layer, status: "missing_method", topDownEstimateId: top[0]?.marketSpaceEstimateId ?? null, bottomUpEstimateId: bottom[0]?.marketSpaceEstimateId ?? null, difference: null, divergenceRatio: null, reason: "exactly one available top-down and bottom-up estimate is required" }; const left = top[0]; const right = bottom[0]; if (left.currency !== right.currency || left.amountScale !== right.amountScale || left.periodLabel !== right.periodLabel || left.periodKind !== right.periodKind) return { layer, status: "incomparable", topDownEstimateId: left.marketSpaceEstimateId, bottomUpEstimateId: right.marketSpaceEstimateId, difference: null, divergenceRatio: null, reason: "currency, amount scale, period label, or flow/stock basis differs" }; const difference = left.amount - right.amount; const denominator = Math.max(Math.abs(left.amount), Math.abs(right.amount)); const divergenceRatio = denominator === 0 ? 0 : Math.abs(difference) / denominator; return { layer, status: divergenceRatio > toleranceRatio ? "conflict" : "reconciled", topDownEstimateId: left.marketSpaceEstimateId, bottomUpEstimateId: right.marketSpaceEstimateId, difference, divergenceRatio, reason: divergenceRatio > toleranceRatio ? "top-down and bottom-up estimates exceed the declared tolerance" : null }; });
}

/**
 * Verifies only a single, directly comparable TAM/SAM/SOM chain.  It never
 * selects one among multiple candidates: that choice belongs to an explicit
 * review/version, not a presentation-time heuristic.
 */
export function validateMarketSpaceHierarchy(estimates: ResearchMarketSpaceEstimate[]): MarketSpaceHierarchyCheck {
  const layers = ["tam", "sam", "som"] as const;
  const available = new Map(layers.map((layer) => [layer, estimates.filter((estimate) => estimate.layer === layer && estimate.status === "available")]));
  const estimateIds = Object.fromEntries(layers.map((layer) => [layer, available.get(layer)?.[0]?.marketSpaceEstimateId ?? null])) as MarketSpaceHierarchyCheck["estimateIds"];
  const invalidLayer = layers.find((layer) => available.get(layer)?.length !== 1);
  if (invalidLayer) {
    const count = available.get(invalidLayer)?.length ?? 0;
    return {
      status: "blocked", estimateIds,
      reason: count === 0
        ? `${invalidLayer.toUpperCase()} has no unique available estimate`
        : `${invalidLayer.toUpperCase()} has multiple available estimates and requires explicit review`,
    };
  }

  const [tam, sam, som] = layers.map((layer) => available.get(layer)![0]);
  const comparable = (left: ResearchMarketSpaceEstimate, right: ResearchMarketSpaceEstimate) => left.currency === right.currency
    && left.amountScale === right.amountScale
    && left.periodLabel === right.periodLabel
    && left.periodKind === right.periodKind;
  if (!comparable(tam, sam) || !comparable(sam, som)) {
    return { status: "blocked", estimateIds, reason: "TAM/SAM/SOM require the same period, currency, amount scale, and flow/stock basis" };
  }
  if (tam.amount < sam.amount || sam.amount < som.amount) {
    return { status: "blocked", estimateIds, reason: "TAM/SAM/SOM hierarchy is reversed" };
  }
  return { status: "reconciled", estimateIds, reason: null };
}

export function evaluateMarketShareBridge(input: ResearchMarketShareBridge): MarketShareBridgeCheck {
  const signedDelta = input.steps.reduce((sum, step) => sum + (step.direction === "gain" ? step.shareDelta : -step.shareDelta), 0); const expectedEndingShare = input.startingShare + signedDelta; const difference = input.endingShare - expectedEndingShare; return { status: Math.abs(difference) < 1e-9 ? "reconciled" : "conflict", expectedEndingShare, statedEndingShare: input.endingShare, difference, unit: input.unit };
}
export function calculateMarketProfitPool(input: ResearchMarketProfitPool): MarketProfitPoolResult { if (input.status === "superseded") return { status: "incomplete", amount: null, currency: input.currency, amountScale: input.amountScale, formula: "superseded profit-pool input" }; return { status: "available", amount: input.industryRevenue * input.sustainableOperatingMargin, currency: input.currency, amountScale: input.amountScale, formula: "industry revenue × sustainable operating margin" }; }

function assertVersion(input: { asOf: number; version: number; epistemicType: ResearchPublicEpistemicType; sourceReferences: ResearchSourceReference[] }, label: string) { assertAsOf(input.asOf); if (!Number.isInteger(input.version) || input.version <= 0) throw new Error(`${label} version must be a positive integer`); evidence(input.sourceReferences, label); assertSourceReferences(input.epistemicType, input.sourceReferences); }
function evidence(refs: ResearchSourceReference[], label: string) { if (!refs.length) throw new Error(`${label} requires at least one source reference`); assertSourceReferences("observed_fact", refs); }
function uniqueRefs(groups: ResearchSourceReference[][]) { const seen = new Set<string>(); return groups.flat().filter((reference) => { const key = JSON.stringify(reference); if (seen.has(key)) return false; seen.add(key); return true; }); }
function required(value: string, label: string) { if (!String(value ?? "").trim()) throw new Error(`${label} is required`); }
function finite(value: number, label: string) { if (!Number.isFinite(value)) throw new Error(`${label} must be finite`); }
function positive(value: number, label: string) { finite(value, label); if (value <= 0) throw new Error(`${label} must be positive`); }
function nonNegative(value: number, label: string) { finite(value, label); if (value < 0) throw new Error(`${label} must be non-negative`); }
function rate(value: number, label: string) { finite(value, label); if (value < -1 || value > 1) throw new Error(`${label} must be between -100% and 100%`); }
function share(value: number, unit: "ratio" | "percent", label: string) { nonNegative(value, label); if ((unit === "ratio" && value > 1) || (unit === "percent" && value > 100)) throw new Error(`${label} exceeds its declared share unit`); }
