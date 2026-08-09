import { projectResearchArtifact } from "./research-artifact-projection.mjs";

export const SCENARIO_VALUATION_SCHEMA_VERSION = "scenario-valuation.v1";
export const SCENARIO_NAMES = Object.freeze(["downside", "base", "upside"]);

const forbiddenComputedFields = new Set(["enterpriseValue", "equityValue", "valuePerShare", "dilutedValuePerShare", "terminalValue", "terminalPresentValue", "targetPrice", "perSecurityValue", "sensitivityResults", "calculationResult"]);

/** Build S9's narrow input boundary: S0 + S8 judgments + S6/S7 observations. */
export function buildScenarioValuationInput({ context, artifactsByKey = {} } = {}) {
  const contextValue = object(context);
  const thesis = projectOptional("operating_thesis", artifactsByKey.operating_thesis, ["causalChain", "judgments", "judgmentIds", "claims", "claimIds", "evidence", "evidenceIds", "sourceIds", "unknowns", "unknownIds", "analysisGaps"]);
  const financial = projectOptional("financial_quality", artifactsByKey.financial_quality, ["observations", "financialQuality", "industryPressureRefs", "claims", "claimIds", "evidence", "evidenceIds", "sourceIds", "unknowns", "analysisGaps"]);
  const market = projectOptional("market_valuation_facts", artifactsByKey.market_valuation_facts, ["marketFacts", "shareCapital", "historicalValuation", "comparability", "availableMethods", "claims", "claimIds", "evidence", "evidenceIds", "sourceIds", "unknowns", "analysisGaps"]);
  const gaps = [...(Array.isArray(contextValue.analysisGaps) ? contextValue.analysisGaps : []), ...(thesis?.analysisGaps || []), ...(financial?.analysisGaps || []), ...(market?.analysisGaps || [])];
  return {
    stage: { key: "scenario_valuation", schemaVersion: SCENARIO_VALUATION_SCHEMA_VERSION, webSearch: false },
    context: {
      contextVersion: contextValue.contextVersion || null,
      asOf: contextValue.asOf || null,
      inputFingerprint: contextValue.inputFingerprint || null,
      company: contextValue.company || null,
      security: contextValue.security || null,
      financialSnapshot: compactFinancialSnapshot(contextValue.financialSnapshot),
      marketSnapshot: compactMarketSnapshot(contextValue.marketSnapshot),
    },
    operatingThesis: thesis?.fields || null,
    financialQuality: financial?.fields || null,
    marketValuationFacts: market?.fields || null,
    inputLineage: collectLineage([thesis, financial, market]),
    analysisGaps: gaps,
  };
}

export function blockedScenarioValuationOutput(input, reason = "required S8/S6/S7 input is unavailable") {
  const gaps = [];
  if (!input?.operatingThesis) gaps.push({ gapId: "analysis-gap:scenario-thesis", code: "operating_thesis_missing", blocking: true });
  if (!input?.financialQuality) gaps.push({ gapId: "analysis-gap:scenario-financial", code: "financial_quality_missing", blocking: true });
  if (!input?.marketValuationFacts) gaps.push({ gapId: "analysis-gap:scenario-market", code: "market_valuation_facts_missing", blocking: true });
  return { schemaVersion: SCENARIO_VALUATION_SCHEMA_VERSION, status: "blocked", scenarios: [], valuationMethodSelection: [], valuationCalculationRequest: { dcfScenarios: [] }, reverseValuationSolveTargets: [], sensitivityRequests: [], riskRegister: [], invalidationPaths: [], monitoringIndicators: [], blockedValuationItems: [...gaps, { code: "scenario_input_blocked", reason }], sourceIds: input?.inputLineage?.sourceIds || [], claimIds: input?.inputLineage?.claimIds || [], evidenceIds: input?.inputLineage?.evidenceIds || [], unknownIds: input?.inputLineage?.unknownIds || [], usedUpstreamArtifactIds: input?.inputLineage?.upstreamArtifactIds || [], analysisGaps: gaps };
}

/** Enforce S9's JSON contract and prevent model-generated valuation numbers. */
export function validateScenarioValuationOutput(output, { allowedIds = {} } = {}) {
  const value = object(output);
  if (value.schemaVersion && value.schemaVersion !== SCENARIO_VALUATION_SCHEMA_VERSION) throw new Error("scenario valuation schema version is invalid");
  const status = text(value.status);
  if (!["complete", "partial", "blocked", "not_applicable"].includes(status)) throw new Error("scenario valuation status is invalid");
  const scenarios = Array.isArray(value.scenarios) ? value.scenarios : [];
  const seen = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const row = object(scenario);
    const name = text(row.scenario || row.scenarioName);
    if (!SCENARIO_NAMES.includes(name)) throw new Error(`scenario valuation scenario[${index}] name is invalid`);
    if (seen.has(name)) throw new Error(`scenario valuation duplicates scenario: ${name}`);
    seen.add(name);
    if (!Array.isArray(row.assumptions)) throw new Error(`scenario valuation ${name} assumptions must be an array`);
    for (const [assumptionIndex, assumption] of row.assumptions.entries()) validateAssumption(assumption, `${name}.assumptions[${assumptionIndex}]`);
    if (row.valuationMethodSelection !== undefined) validateMethods(row.valuationMethodSelection, `${name}.valuationMethodSelection`);
    assertNoComputedFields(row, `scenarios[${index}]`);
  }
  const request = object(value.valuationCalculationRequest);
  if (!Array.isArray(request.dcfScenarios)) throw new Error("scenario valuation valuationCalculationRequest.dcfScenarios must be an array");
  const dcfScenarios = new Set();
  for (const [index, item] of request.dcfScenarios.entries()) {
    validateDcfRequest(item, `valuationCalculationRequest.dcfScenarios[${index}]`);
    const scenario = text(item?.scenario);
    if (dcfScenarios.has(scenario)) throw new Error(`valuationCalculationRequest duplicates DCF scenario: ${scenario}`);
    dcfScenarios.add(scenario);
  }
  const reverseTargets = value.reverseValuationSolveTargets === undefined ? [] : value.reverseValuationSolveTargets;
  if (!Array.isArray(reverseTargets)) throw new Error("reverseValuationSolveTargets must be an array");
  for (const [index, item] of reverseTargets.entries()) validateReverseTarget(item, `reverseValuationSolveTargets[${index}]`);
  const sensitivityRequests = value.sensitivityRequests === undefined ? [] : value.sensitivityRequests;
  if (!Array.isArray(sensitivityRequests)) throw new Error("sensitivityRequests must be an array");
  for (const [index, item] of sensitivityRequests.entries()) validateSensitivityRequest(item, `sensitivityRequests[${index}]`);
  if (value.valuationMethodSelection !== undefined) validateMethods(value.valuationMethodSelection, "valuationMethodSelection");
  for (const field of ["riskRegister", "invalidationPaths", "monitoringIndicators", "blockedValuationItems"]) if (value[field] !== undefined && !Array.isArray(value[field])) throw new Error(`${field} must be an array`);
  for (const key of ["sourceIds", "claimIds", "evidenceIds", "unknownIds", "usedUpstreamArtifactIds"]) ids(value[key], `output.${key}`);
  // Computed fields are prohibited everywhere except an explicit enterpriseValue
  // supplied as the input target of a reverse-DCF request.
  assertNoComputedFields(value, "output", { allowEnterpriseValueInReverseTarget: true });
  assertAllowedIds(value, allowedIds);
  if (status === "complete" && scenarios.length !== SCENARIO_NAMES.length) throw new Error("complete scenario valuation requires downside, base and upside");
  if (status === "blocked" && !value.blockedValuationItems?.length) throw new Error("blocked scenario valuation requires blockedValuationItems");
  return { ...value, schemaVersion: SCENARIO_VALUATION_SCHEMA_VERSION };
}

function validateAssumption(value, path) {
  const row = object(value);
  namedId(row.assumptionId, `${path}.assumptionId`);
  if (!text(row.scenario || row.period || row.unit) || !text(row.variable)) throw new Error(`${path} lacks scenario/period/unit/variable`);
  if (!Number.isFinite(Number(row.value)) && row.value !== null) throw new Error(`${path}.value must be numeric or null`);
  ids(row.judgmentIds, `${path}.judgmentIds`); ids(row.claimIds, `${path}.claimIds`); ids(row.evidenceIds, `${path}.evidenceIds`); ids(row.sourceIds, `${path}.sourceIds`);
  if (row.counterEvidenceIds !== undefined) ids(row.counterEvidenceIds, `${path}.counterEvidenceIds`);
}

function validateMethods(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  for (const [index, item] of value.entries()) {
    const row = object(item);
    if (!text(row.method) || !["available", "selected", "blocked", "not_applicable"].includes(text(row.status))) throw new Error(`${path}[${index}] method/status is invalid`);
    ids(row.sourceIds, `${path}[${index}].sourceIds`);
  }
}

function validateDcfRequest(value, path) {
  const row = object(value);
  if (!SCENARIO_NAMES.includes(text(row.scenario))) throw new Error(`${path}.scenario is invalid`);
  for (const field of ["openingRevenue", "openingNetWorkingCapital", "wacc", "terminalGrowth", "netDebt", "dilutedShares"]) if (!Number.isFinite(Number(row[field]))) throw new Error(`${path}.${field} must be numeric`);
  if (!text(row.currency) || !text(row.amountScale)) throw new Error(`${path} currency and amountScale are required`);
  if (Number(row.wacc) <= Number(row.terminalGrowth) || Number(row.dilutedShares) <= 0) throw new Error(`${path} has invalid WACC/growth/shares`);
  if (!Array.isArray(row.years) || row.years.length === 0) throw new Error(`${path}.years must be non-empty`);
  let previous = null;
  for (const [index, year] of row.years.entries()) {
    const item = object(year);
    const fiscalYear = Number(item.fiscalYear);
    if (!Number.isInteger(fiscalYear) || (previous !== null && fiscalYear !== previous + 1)) throw new Error(`${path}.years[${index}].fiscalYear must be consecutive`);
    previous = fiscalYear;
    for (const field of ["revenueGrowth", "ebitMargin", "taxRate", "depreciationAmortizationMargin", "capitalExpenditureMargin", "netWorkingCapitalToRevenue"]) if (!Number.isFinite(Number(item[field]))) throw new Error(`${path}.years[${index}].${field} must be numeric`);
  }
  assertNoComputedFields(row, path);
}

function validateReverseTarget(value, path) {
  const row = object(value);
  if (!SCENARIO_NAMES.includes(text(row.scenario))) throw new Error(`${path}.scenario is invalid`);
  if (!text(row.currency) || !text(row.amountScale)) throw new Error(`${path} currency and amountScale are required`);
  for (const field of ["wacc", "terminalGrowth"]) if (!Number.isFinite(Number(row[field]))) throw new Error(`${path}.${field} must be numeric`);
  if (Number(row.wacc) <= Number(row.terminalGrowth)) throw new Error(`${path} WACC must be greater than terminal growth`);
  const hasEnterpriseValue = row.enterpriseValue !== undefined && row.enterpriseValue !== null && Number.isFinite(Number(row.enterpriseValue));
  const hasSecurityBridge = ["pricePerSecurity", "dilutedShares"].every((field) => Number.isFinite(Number(row[field])));
  if (!hasEnterpriseValue && !hasSecurityBridge) throw new Error(`${path} requires enterpriseValue or a security bridge`);
  if (row.netDebt !== undefined && row.netDebt !== null && !Number.isFinite(Number(row.netDebt))) throw new Error(`${path}.netDebt must be numeric`);
  if (hasSecurityBridge && Number(row.dilutedShares) <= 0) throw new Error(`${path}.dilutedShares must be positive`);
  if (row.underlyingSharesPerSecurity !== undefined && !Number.isFinite(Number(row.underlyingSharesPerSecurity))) throw new Error(`${path}.underlyingSharesPerSecurity must be numeric`);
  if (row.terminalFreeCashFlowMargin !== undefined && row.terminalFreeCashFlowMargin !== null && !Number.isFinite(Number(row.terminalFreeCashFlowMargin))) throw new Error(`${path}.terminalFreeCashFlowMargin must be numeric`);
  assertNoComputedFields(row, path, { allowEnterpriseValueInReverseTarget: true });
}

function validateSensitivityRequest(value, path) {
  const row = object(value);
  if (!SCENARIO_NAMES.includes(text(row.scenario))) throw new Error(`${path}.scenario is invalid`);
  if (!Array.isArray(row.waccValues) || row.waccValues.length === 0 || row.waccValues.some((item) => !Number.isFinite(Number(item)))) throw new Error(`${path}.waccValues must be a non-empty numeric array`);
  if (!Array.isArray(row.terminalGrowthValues) || row.terminalGrowthValues.length === 0 || row.terminalGrowthValues.some((item) => !Number.isFinite(Number(item)))) throw new Error(`${path}.terminalGrowthValues must be a non-empty numeric array`);
  assertNoComputedFields(row, path);
}

function assertNoComputedFields(value, path, options = {}) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoComputedFields(item, `${path}[${index}]`, options)); return; }
  for (const [key, item] of Object.entries(value)) {
    const reverseEnterpriseValue = options.allowEnterpriseValueInReverseTarget && key === "enterpriseValue" && /(?:^|\.)reverseValuationSolveTargets(?:\[\d+\])?$/.test(path);
    if (forbiddenComputedFields.has(key) && !reverseEnterpriseValue) throw new Error(`${path}.${key} is deterministic output and cannot be supplied by S9`);
    if (item && typeof item === "object") assertNoComputedFields(item, `${path}.${key}`, options);
  }
}

function projectOptional(stageKey, artifact, fields) {
  if (!artifact) return null;
  return projectResearchArtifact({ stageKey, artifact, fields });
}

function compactFinancialSnapshot(value) {
  const row = object(value);
  return { asOf: row.asOf || null, schemaVersion: row.schemaVersion || null, source: row.source || null, periods: Array.isArray(row.periods) ? row.periods : [], deterministicMetrics: Array.isArray(row.deterministicMetrics) ? row.deterministicMetrics : [] };
}

function compactMarketSnapshot(value) {
  const row = object(value);
  return { asOf: row.asOf || null, schemaVersion: row.schemaVersion || null, source: row.source || null, securityId: row.securityId || null, securityCode: row.securityCode || null, listingVenue: row.listingVenue || null, shareClass: row.shareClass || null, tradingCurrency: row.tradingCurrency || row.currency || null, sharesOutstanding: finite(row.sharesOutstanding), rights: row.rights || null, price: finite(row.price), marketCapitalization: finite(row.marketCapitalization), historicalValuation: Array.isArray(row.historicalValuation) ? row.historicalValuation : [], reportedMultiples: object(row.reportedMultiples) };
}

function collectLineage(projections) {
  const result = { upstreamArtifactIds: new Set(), sourceIds: new Set(), claimIds: new Set(), evidenceIds: new Set(), unknownIds: new Set() };
  for (const projection of projections.filter(Boolean)) {
    for (const key of Object.keys(result)) for (const id of projection[key] || []) result[key].add(id);
    for (const id of projection.sourceArtifactIds || []) result.upstreamArtifactIds.add(id);
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, [...value].sort()]));
}

function assertAllowedIds(value, allowedIds) {
  for (const [key, list] of Object.entries(allowedIds || {})) {
    const allowed = new Set(Array.isArray(list) ? list : []);
    if (!allowed.size) continue;
    for (const id of collectIds(value, key)) if (!allowed.has(id)) throw new Error(`scenario valuation ${key} is not allowed: ${id}`);
  }
}
function collectIds(value, key, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) { value.forEach((item) => collectIds(item, key, output)); return output; }
  for (const [field, item] of Object.entries(value)) {
    if (field === key && Array.isArray(item)) output.push(...item);
    else if (field === key && typeof item === "string") output.push(item);
    else collectIds(item, key, output);
  }
  return output;
}
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function namedId(value, path) { const id = text(value); if (!id || /^\d+$/.test(id) || /\s/.test(id)) throw new Error(`${path} must be a named ID`); return id; }
function ids(value, path) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new Error(`${path} must be an array`); const seen = new Set(); for (const [index, item] of value.entries()) { const id = namedId(item, `${path}[${index}]`); if (seen.has(id)) throw new Error(`${path} contains duplicate ID: ${id}`); seen.add(id); } return [...seen]; }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
