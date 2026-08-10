import { projectResearchArtifact } from "./research-artifact-projection.mjs";
import { validateScenarioValuationOutput } from "./operating-analysis-scenario-valuation.mjs";

export const INVESTMENT_CONCLUSION_SCHEMA_VERSION = "investment-conclusion.v2";
export const INVESTMENT_CONCLUSION_CHAPTERS = Object.freeze(["9", "10", "11", "12"]);
const ALLOWED_CHAPTERS = INVESTMENT_CONCLUSION_CHAPTERS;

/** Build S11 input from S9/S10 and a narrow provenance manifest only. */
export function buildInvestmentConclusionInput({ context, scenarioOutput, deterministicValuation, scenarioArtifact, thesisArtifact, financialArtifact, marketArtifact } = {}) {
  const contextValue = object(context);
  const thesis = projectOptional("operating_thesis", thesisArtifact, ["judgmentIds", "claimIds", "evidenceIds", "sourceIds", "unknownIds", "analysisGaps"]);
  const financial = projectOptional("financial_quality", financialArtifact, ["claimIds", "evidenceIds", "sourceIds", "unknowns", "analysisGaps"]);
  const market = projectOptional("market_valuation_facts", marketArtifact, ["claimIds", "evidenceIds", "sourceIds", "unknowns", "analysisGaps"]);
  const scenario = scenarioOutput && typeof scenarioOutput === "object" && !Array.isArray(scenarioOutput)
    ? validateScenarioValuationOutput(scenarioOutput)
    : {};
  const valuation = object(deterministicValuation);
  const calculationIds = collectCalculationIds(valuation);
  const scenarioIds = collectIdsFromObject(scenario, ["sourceIds", "claimIds", "evidenceIds", "unknownIds", "usedUpstreamArtifactIds"]);
  const valuationIds = collectIdsFromObject(valuation, ["sourceIds", "claimIds", "evidenceIds", "unknownIds", "usedUpstreamArtifactIds"]);
  return {
    stage: { key: "investment_conclusion", schemaVersion: INVESTMENT_CONCLUSION_SCHEMA_VERSION, webSearch: false },
    context: { contextVersion: contextValue.contextVersion || null, asOf: contextValue.asOf || null, company: contextValue.company || null, security: contextValue.security || null, inputFingerprint: contextValue.inputFingerprint || null },
    scenarioValuation: { status: scenario.status || null, scenarios: scenario.scenarios || [], blockedValuationItems: scenario.blockedValuationItems || [], riskRegister: scenario.riskRegister || [], invalidationPaths: scenario.invalidationPaths || [], monitoringIndicators: scenario.monitoringIndicators || [], claimIds: scenario.claimIds || [], evidenceIds: scenario.evidenceIds || [], sourceIds: scenario.sourceIds || [], unknownIds: scenario.unknownIds || [] },
    deterministicValuation: { status: valuation.status || null, formulaVersion: valuation.formulaVersion || null, results: valuation.results || [], sensitivity: valuation.sensitivity || [], blockedValuationItems: valuation.blockedValuationItems || [], calculationTrace: valuation.calculationTrace || [], calculationIds },
    calculationIds,
    provenance: mergeProvenance(collectProvenance([thesis, financial, market]), scenarioIds, valuationIds, { calculationIds }, scenarioArtifact?.artifactId ? { upstreamArtifactIds: [scenarioArtifact.artifactId] } : {}),
  };
}

export function validateInvestmentConclusionOutput(output, { calculationIds = [], requiredCalculationIds = [], deterministicStatus = null, allowedIds = {} } = {}) {
  const value = object(output);
  if (value.schemaVersion && value.schemaVersion !== INVESTMENT_CONCLUSION_SCHEMA_VERSION) throw new Error("investment conclusion schema version is invalid");
  const status = text(value.status);
  if (!["complete", "partial", "blocked", "not_applicable"].includes(status)) throw new Error("investment conclusion status is invalid");
  const chapters = object(value.markdownByChapter);
  for (const key of Object.keys(chapters)) {
    if (!ALLOWED_CHAPTERS.includes(key)) throw new Error(`investment conclusion cannot own chapter ${key}`);
    if (typeof chapters[key] !== "string") throw new Error(`investment conclusion chapter ${key} must be Markdown text`);
  }
  if (value.markdown !== undefined) {
    if (typeof value.markdown !== "string") throw new Error("investment conclusion markdown must be text");
    if (/(^|\n)\s*#{1,2}\s+(?:[2-8](?:[.、\s]|$)|公司概况|行业与产业链|公司竞争|增长、驱动|利润质量|资本效率|资产负债)/m.test(value.markdown)) throw new Error("investment conclusion cannot rewrite chapters 2-8");
  }
  const references = ids(value.calculationIds, "output.calculationIds");
  const allowedCalculations = new Set(calculationIds);
  for (const id of references) if (allowedCalculations.size && !allowedCalculations.has(id)) throw new Error(`investment conclusion references unknown calculation: ${id}`);
  const requiredCalculations = ids(requiredCalculationIds, "requiredCalculationIds");
  for (const id of requiredCalculations) if (!references.includes(id)) throw new Error(`investment conclusion is missing calculation reference: ${id}`);
  if (deterministicStatus === "blocked" && status === "complete") throw new Error("investment conclusion cannot be complete when deterministic valuation is blocked");
  if (status === "complete" && (deterministicStatus === null ? references.length === 0 && requiredCalculations.length === 0 : deterministicStatus !== "complete" || references.length === 0)) throw new Error("complete investment conclusion requires source-backed deterministic calculations");
  for (const key of ["judgmentIds", "assumptionIds", "riskIds", "claimIds", "evidenceIds", "sourceIds", "unknownIds"]) ids(value[key], `output.${key}`);
  assertAllowedIds(value, allowedIds);
  if (status === "complete" && !Object.keys(chapters).length && !text(value.markdown)) throw new Error("complete investment conclusion requires chapter Markdown");
  if (status === "complete" && Object.keys(chapters).length && ALLOWED_CHAPTERS.some((key) => !Object.prototype.hasOwnProperty.call(chapters, key) || !text(chapters[key]))) throw new Error("complete investment conclusion requires chapters 9-12");
  return { ...value, schemaVersion: INVESTMENT_CONCLUSION_SCHEMA_VERSION, markdownByChapter: chapters, calculationIds: references };
}

/** Validate the direct-Markdown S11 contract while reusing the structured
 * validator's calculation/provenance and chapter-boundary checks.  The model
 * stage intentionally remains Markdown so S12 can splice its four chapters;
 * this adapter supplies the status/calculation manifest that the structured
 * validator requires without persisting a second representation. */
export function validateInvestmentConclusionMarkdown(markdown, { stageStatus = null, calculationIds = [], deterministicStatus = null } = {}) {
  const body = text(markdown);
  if (!body) throw new Error("investment conclusion markdown is required");
  const references = extractCalculationIds(body);
  const status = text(stageStatus) || (deterministicStatus === "complete" ? "complete" : "blocked");
  validateInvestmentConclusionOutput({ status, markdown: body, calculationIds: references }, {
    calculationIds,
    requiredCalculationIds: status === "complete" ? calculationIds : [],
    deterministicStatus,
  });
  if (status === "complete") {
    for (const chapter of ALLOWED_CHAPTERS) {
      if (!new RegExp(`(?:^|\\n)\\s*#{1,2}\\s+${chapter}(?:[.、\\s]|$)`, "m").test(body)) throw new Error(`complete investment conclusion markdown is missing chapter ${chapter}`);
    }
  }
  return body;
}

export function projectInvestmentConclusionForReport(output, options = {}) {
  const value = validateInvestmentConclusionOutput(output, options);
  return { schemaVersion: INVESTMENT_CONCLUSION_SCHEMA_VERSION, status: value.status, markdownByChapter: Object.fromEntries(ALLOWED_CHAPTERS.map((key) => [key, value.markdownByChapter[key] || ""])), calculationIds: value.calculationIds, judgmentIds: ids(value.judgmentIds, "output.judgmentIds"), assumptionIds: ids(value.assumptionIds, "output.assumptionIds"), riskIds: ids(value.riskIds, "output.riskIds"), claimIds: ids(value.claimIds, "output.claimIds"), evidenceIds: ids(value.evidenceIds, "output.evidenceIds"), sourceIds: ids(value.sourceIds, "output.sourceIds"), unknownIds: ids(value.unknownIds, "output.unknownIds"), analysisGaps: Array.isArray(value.analysisGaps) ? value.analysisGaps : [] };
}

function projectOptional(stageKey, artifact, fields) { return artifact ? projectResearchArtifact({ stageKey, artifact, fields }) : null; }
function collectCalculationIds(value) {
  const result = new Set();
  for (const trace of Array.isArray(value?.calculationTrace) ? value.calculationTrace : []) {
    const id = text(trace?.calculationId);
    if (id) result.add(id);
  }
  return [...result].sort();
}
function extractCalculationIds(markdown) {
  return [...new Set(String(markdown).match(/calculation:[A-Za-z0-9:_-]+/g) || [])].sort();
}
function collectIdsFromObject(value, fields, result = {}) {
  const sets = Object.fromEntries(fields.map((field) => [field, new Set()]));
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    for (const [key, item] of Object.entries(node)) {
      if (sets[key] && Array.isArray(item)) for (const id of item) if (typeof id === "string" && id.trim()) sets[key].add(id.trim());
      else visit(item);
    }
  };
  visit(value);
  return Object.fromEntries(Object.entries(sets).map(([key, set]) => [key, [...set].sort()]));
}
function mergeProvenance(base, ...extras) {
  const result = {};
  for (const key of ["upstreamArtifactIds", "sourceIds", "claimIds", "evidenceIds", "unknownIds", "calculationIds"]) {
    const values = new Set();
    for (const source of [base, ...extras]) for (const id of source?.[key] || []) values.add(id);
    result[key] = [...values].sort();
  }
  return result;
}
function collectProvenance(projections) {
  const result = { upstreamArtifactIds: new Set(), sourceIds: new Set(), claimIds: new Set(), evidenceIds: new Set(), unknownIds: new Set() };
  for (const projection of projections.filter(Boolean)) for (const key of Object.keys(result)) for (const id of projection[key] || []) result[key].add(id);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, [...value].sort()]));
}
function assertAllowedIds(value, allowedIds) { for (const [key, list] of Object.entries(allowedIds || {})) { const allowed = new Set(Array.isArray(list) ? list : []); if (!allowed.size) continue; for (const id of collectIds(value, key)) if (!allowed.has(id)) throw new Error(`investment conclusion ${key} is not allowed: ${id}`); } }
function collectIds(value, key, output = []) { if (!value || typeof value !== "object") return output; if (Array.isArray(value)) { value.forEach((item) => collectIds(item, key, output)); return output; } for (const [field, item] of Object.entries(value)) { if (field === key && Array.isArray(item)) output.push(...item); else if (field === key && typeof item === "string") output.push(item); else collectIds(item, key, output); } return output; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function namedId(value, path) { const id = text(value); if (!id || /^\d+$/.test(id) || /\s/.test(id)) throw new Error(`${path} must be a named ID`); return id; }
function ids(value, path) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new Error(`${path} must be an array`); const seen = new Set(); for (const [index, item] of value.entries()) { const id = namedId(item, `${path}[${index}]`); if (seen.has(id)) throw new Error(`${path} contains duplicate ID: ${id}`); seen.add(id); } return [...seen]; }
