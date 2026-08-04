import {
  assertAsOf,
  assertSourceReferences,
  type ResearchEpistemicType,
  type ResearchRiskEntry,
  type ResearchSourceReference,
  type ResearchThesis,
} from "./research-dossier";
import type { GuidanceEventImpactReview } from "./guidance-event-impact-review";

export type ResearchRiskReviewScope = "operating_company" | "listed_security";
export type ResearchRiskReviewStatus = "draft" | "reviewed" | "superseded";
export type ResearchRiskRelationshipStatus = "active" | "historical" | "unavailable";
export type ResearchRiskRelationshipType = "customer" | "supplier" | "geography" | "product" | "channel" | "financing" | "asset" | "regulation" | "other";
export type ResearchPublicEpistemicType = Exclude<ResearchEpistemicType, "user_decision">;

export type ResearchRiskPressureInput = {
  key: string;
  label: string;
  baseline: number | string | null;
  stressed: number | string | null;
  unit: string | null;
  epistemicType: ResearchPublicEpistemicType;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchRiskPressureResult = {
  key: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  explanation: string;
};

export type ResearchRiskPressureScenario = {
  scenarioId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  scenarioKey: string;
  version: number;
  supersedesScenarioId: string | null;
  status: ResearchRiskReviewStatus;
  scope: ResearchRiskReviewScope;
  title: string;
  transmission: string;
  modelVersion: string;
  inputs: ResearchRiskPressureInput[];
  results: ResearchRiskPressureResult[];
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchRiskRelationship = {
  relationshipId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  scope: ResearchRiskReviewScope;
  relationshipType: ResearchRiskRelationshipType;
  counterpartyName: string;
  description: string;
  transmission: string;
  concentrationValue: number | null;
  concentrationBasis: string | null;
  status: ResearchRiskRelationshipStatus;
  epistemicType: ResearchPublicEpistemicType;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchSnapshotModule = {
  moduleId: string;
  availability: "available" | "empty" | "unavailable";
  versionId: string | null;
  asOf: number | null;
  payload: Record<string, unknown>;
};

export type ResearchSnapshotFieldDifference = {
  path: string;
  changeType: "added" | "removed" | "changed";
  baselineValue: unknown;
  currentValue: unknown;
};

export type ResearchSnapshotModuleDifference = {
  differenceId: string;
  companyId: string | null;
  securityCode: string;
  baselineSnapshotId: string | null;
  currentSnapshotId: string;
  moduleId: string;
  diffVersion: string;
  changeType: "added" | "removed" | "changed";
  baseline: ResearchSnapshotModule | null;
  current: ResearchSnapshotModule | null;
  fields: ResearchSnapshotFieldDifference[];
  createdAt: number;
};

export const RESEARCH_SNAPSHOT_DIFF_VERSION = "research-snapshot-diff.v1";
export const RESEARCH_RISK_STRESS_CALCULATION_VERSION = "research-risk-stress.v1";

export type ResearchRiskStressObservation = {
  key: "revenue" | "ebit" | "operating_cash_flow" | "net_debt" | "cash_runway_years" | "equity_value_per_share";
  label: string;
  baselineValue: number | null;
  stressedValue: number | null;
  deltaValue: number | null;
  unit: string | null;
  status: "available" | "unavailable";
  inputKeys: string[];
  limitation: string | null;
};

export type ResearchRiskStressCalculation = {
  scenarioId: string;
  scenarioKey: string;
  modelVersion: string;
  calculationVersion: string;
  availability: "available" | "partial" | "unavailable";
  observations: ResearchRiskStressObservation[];
  limitations: string[];
};

export type ResearchRiskThesisLink = {
  riskId: string;
  thesisId: string;
  relationship: "invalidates" | "pressures" | "monitors";
  rationale: string;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchRiskThesisPropagation = {
  riskId: string;
  thesisId: string;
  state: "requires_review" | "monitor" | "review_resolution" | "not_applicable";
  rationale: string;
};

export function assertResearchRiskPressureScenario(input: ResearchRiskPressureScenario): void {
  assertPublicResearchRecord(input.securityCode, input.asOf, input.scope);
  assertOneOf(input.status, ["draft", "reviewed", "superseded"], "risk pressure scenario status");
  if (!positiveInteger(input.version)) throw new Error("risk pressure scenario version must be a positive integer");
  requireText(input.scenarioId, "risk pressure scenario id");
  requireText(input.scenarioKey, "risk pressure scenario key");
  requireText(input.title, "risk pressure scenario title");
  requireText(input.transmission, "risk pressure scenario transmission");
  requireText(input.modelVersion, "risk pressure scenario modelVersion");
  if (!input.inputs.length) throw new Error("risk pressure scenario requires explicit inputs");
  if (!input.results.length) throw new Error("risk pressure scenario requires explicit results");
  for (const item of input.inputs) {
    requireText(item.key, "risk pressure input key");
    requireText(item.label, "risk pressure input label");
    assertPublicEpistemicType(item.epistemicType);
    assertJsonValue(item.baseline, "risk pressure input baseline");
    assertJsonValue(item.stressed, "risk pressure input stressed");
    assertSourceReferences(item.epistemicType, item.sourceReferences);
  }
  for (const result of input.results) {
    requireText(result.key, "risk pressure result key");
    requireText(result.label, "risk pressure result label");
    requireText(result.explanation, "risk pressure result explanation");
    assertJsonValue(result.value, "risk pressure result value");
  }
  assertUniqueKeys(input.inputs, "risk pressure input");
  assertUniqueKeys(input.results, "risk pressure result");
  assertSourceReferences("system_judgment", input.sourceReferences);
}

export function assertResearchRiskRelationship(input: ResearchRiskRelationship): void {
  assertPublicResearchRecord(input.securityCode, input.asOf, input.scope);
  assertOneOf(input.relationshipType, ["customer", "supplier", "geography", "product", "channel", "financing", "asset", "regulation", "other"], "risk relationship type");
  assertOneOf(input.status, ["active", "historical", "unavailable"], "risk relationship status");
  requireText(input.relationshipId, "risk relationship id");
  requireText(input.counterpartyName, "risk relationship counterpartyName");
  requireText(input.description, "risk relationship description");
  requireText(input.transmission, "risk relationship transmission");
  assertPublicEpistemicType(input.epistemicType);
  if (input.concentrationValue !== null && (!Number.isFinite(input.concentrationValue) || input.concentrationValue < 0 || input.concentrationValue > 1)) {
    throw new Error("risk relationship concentrationValue must be between 0 and 1");
  }
  if (input.concentrationValue !== null && !input.concentrationBasis?.trim()) {
    throw new Error("risk relationship concentrationBasis is required when concentrationValue is present");
  }
  assertSourceReferences(input.epistemicType, input.sourceReferences);
}

export function assertResearchSnapshotModuleDifference(input: ResearchSnapshotModuleDifference): void {
  requireText(input.differenceId, "snapshot module difference id");
  requireText(input.securityCode, "snapshot module difference securityCode");
  requireText(input.currentSnapshotId, "snapshot module difference currentSnapshotId");
  requireText(input.moduleId, "snapshot module difference moduleId");
  if (input.diffVersion !== RESEARCH_SNAPSHOT_DIFF_VERSION) throw new Error("unsupported research snapshot diff version");
  assertModule(input.baseline, "baseline");
  assertModule(input.current, "current");
  if (!input.baseline && !input.current) throw new Error("snapshot module difference requires a baseline or current module");
  const expected = !input.baseline ? "added" : !input.current ? "removed" : "changed";
  if (input.changeType !== expected) throw new Error(`snapshot module difference changeType must be ${expected}`);
  if (!positiveInteger(input.createdAt)) throw new Error("snapshot module difference createdAt must be a positive integer");
  for (const field of input.fields) {
    requireText(field.path, "snapshot module difference field path");
    assertOneOf(field.changeType, ["added", "removed", "changed"], "snapshot module difference field changeType");
    assertJsonValue(field.baselineValue, "snapshot module difference baseline value");
    assertJsonValue(field.currentValue, "snapshot module difference current value");
  }
}

export function diffResearchSnapshotModules(input: {
  differenceIdPrefix: string;
  securityCode: string;
  companyId: string | null;
  baselineSnapshotId: string | null;
  currentSnapshotId: string;
  baseline: ResearchSnapshotModule[];
  current: ResearchSnapshotModule[];
  createdAt: number;
}): ResearchSnapshotModuleDifference[] {
  requireText(input.differenceIdPrefix, "snapshot difference id prefix");
  requireText(input.securityCode, "snapshot difference securityCode");
  requireText(input.currentSnapshotId, "snapshot difference currentSnapshotId");
  if (!positiveInteger(input.createdAt)) throw new Error("snapshot difference createdAt must be a positive integer");
  assertDistinctModuleIds(input.baseline, "baseline");
  assertDistinctModuleIds(input.current, "current");
  const baselineById = new Map(input.baseline.map((module) => [module.moduleId, module]));
  const currentById = new Map(input.current.map((module) => [module.moduleId, module]));
  const moduleIds = [...new Set([...baselineById.keys(), ...currentById.keys()])].sort();
  const differences: ResearchSnapshotModuleDifference[] = [];
  for (const moduleId of moduleIds) {
    const baseline = baselineById.get(moduleId) ?? null;
    const current = currentById.get(moduleId) ?? null;
    const fields = diffModule(baseline, current);
    if (!fields.length) continue;
    const changeType = !baseline ? "added" : !current ? "removed" : "changed";
    const difference: ResearchSnapshotModuleDifference = {
      differenceId: `${input.differenceIdPrefix}:${moduleId}`,
      companyId: input.companyId,
      securityCode: input.securityCode.trim().toUpperCase(),
      baselineSnapshotId: input.baselineSnapshotId,
      currentSnapshotId: input.currentSnapshotId,
      moduleId,
      diffVersion: RESEARCH_SNAPSHOT_DIFF_VERSION,
      changeType,
      baseline,
      current,
      fields,
      createdAt: input.createdAt,
    };
    assertResearchSnapshotModuleDifference(difference);
    differences.push(difference);
  }
  return differences;
}

/**
 * Evaluates only explicitly supplied baseline/stressed inputs. It deliberately
 * does not infer a margin, cash burn or share count from another source.
 * Supported input keys: revenue, ebit_margin, operating_cash_flow, cash,
 * debt, annual_cash_burn, equity_value, diluted_shares.
 */
export function calculateResearchRiskStress(input: {
  scenario: ResearchRiskPressureScenario;
  monetaryUnit: string;
}): ResearchRiskStressCalculation {
  assertResearchRiskPressureScenario(input.scenario);
  requireText(input.monetaryUnit, "risk stress monetaryUnit");
  const values = new Map(input.scenario.inputs.map((item) => [item.key, item]));
  const monetary = (key: string) => numericPair(values.get(key), input.monetaryUnit);
  const ratio = (key: string) => numericPair(values.get(key), "ratio");
  const revenue = monetary("revenue");
  const ebitMargin = ratio("ebit_margin");
  const operatingCashFlow = monetary("operating_cash_flow");
  const cash = monetary("cash");
  const debt = monetary("debt");
  const annualCashBurn = monetary("annual_cash_burn");
  const equityValue = monetary("equity_value");
  const dilutedShares = numericPair(values.get("diluted_shares"), values.get("diluted_shares")?.unit ?? "shares");
  const observations = [
    directObservation("revenue", "收入", revenue, input.monetaryUnit, ["revenue"]),
    derivedObservation("ebit", "息税前利润", revenue, ebitMargin, input.monetaryUnit, ["revenue", "ebit_margin"], (r, margin) => r * margin),
    directObservation("operating_cash_flow", "经营现金流", operatingCashFlow, input.monetaryUnit, ["operating_cash_flow"]),
    derivedObservation("net_debt", "净债务", debt, cash, input.monetaryUnit, ["debt", "cash"], (totalDebt, cashBalance) => totalDebt - cashBalance),
    derivedObservation("cash_runway_years", "现金跑道", cash, annualCashBurn, "years", ["cash", "annual_cash_burn"], (cashBalance, burn) => burn > 0 ? cashBalance / burn : Number.NaN),
    derivedObservation("equity_value_per_share", "每股股权价值", equityValue, dilutedShares, `${input.monetaryUnit}/share`, ["equity_value", "diluted_shares"], (value, shares) => shares > 0 ? value / shares : Number.NaN),
  ];
  const available = observations.filter((item) => item.status === "available");
  const limitations = observations.filter((item) => item.limitation).map((item) => `${item.label}：${item.limitation}`);
  return {
    scenarioId: input.scenario.scenarioId,
    scenarioKey: input.scenario.scenarioKey,
    modelVersion: input.scenario.modelVersion,
    calculationVersion: RESEARCH_RISK_STRESS_CALCULATION_VERSION,
    availability: available.length === observations.length ? "available" : available.length ? "partial" : "unavailable",
    observations,
    limitations,
  };
}

/**
 * Propagation is a review queue, not an automatic edit to a thesis. A risk is
 * linked only when the caller supplies an explicit link; title matching would
 * be an unauditable guess.
 */
export function buildResearchRiskThesisPropagation(input: {
  risks: ResearchRiskEntry[];
  theses: ResearchThesis[];
  links: ResearchRiskThesisLink[];
}): ResearchRiskThesisPropagation[] {
  const risks = new Map(input.risks.map((risk) => [risk.riskId, risk]));
  const theses = new Map(input.theses.map((thesis) => [thesis.thesisId, thesis]));
  return input.links.map((link) => {
    const risk = risks.get(link.riskId);
    const thesis = theses.get(link.thesisId);
    if (!risk || !thesis) throw new Error("risk thesis propagation link references an unknown record");
    assertPublicRiskEntry(risk);
    if (thesis.epistemicType !== "system_judgment") throw new Error("risk thesis propagation cannot update a personal thesis");
    assertResearchRiskThesisLink(link);
    if (thesis.status === "invalidated" || thesis.status === "superseded") {
      return { riskId: risk.riskId, thesisId: thesis.thesisId, state: "not_applicable", rationale: "命题已经失效或被替代；保留风险关联但不自动改变历史记录。" };
    }
    if (["new", "upgraded"].includes(risk.status) || link.relationship === "invalidates") {
      return { riskId: risk.riskId, thesisId: thesis.thesisId, state: "requires_review", rationale: `${link.rationale}；风险状态为 ${risk.status}，需要人工复核命题与相关估值。` };
    }
    if (["downgraded", "resolved"].includes(risk.status)) {
      return { riskId: risk.riskId, thesisId: thesis.thesisId, state: "review_resolution", rationale: `${link.rationale}；风险缓和不自动恢复命题，需人工确认。` };
    }
    return { riskId: risk.riskId, thesisId: thesis.thesisId, state: "monitor", rationale: `${link.rationale}；风险仍在监测，未自动改变命题。` };
  });
}

/** Creates public-only modules for a dated research snapshot. */
export function buildPublicRiskSnapshotModules(input: {
  asOf: number;
  risks: ResearchRiskEntry[];
  theses: ResearchThesis[];
  pressureScenarios: ResearchRiskPressureScenario[];
  relationships: ResearchRiskRelationship[];
  /** Exact source-to-target mappings and appended thesis/risk dispositions. */
  impactReviews?: GuidanceEventImpactReview[];
  focusProfile?: { focusProfileId: string; companyId: string; version: number; asOf: number; status: string; title: string; reviewBy: number | null; epistemicType: "system_judgment"; items: Array<{ focusItemId: string; role: string; targetKind: string; targetId: string; securityCode: string | null; sortOrder: number; target: Record<string, unknown> | null; unavailableReason: string | null }> } | null;
}): ResearchSnapshotModule[] {
  assertAsOf(input.asOf);
  for (const risk of input.risks) assertPublicRiskEntry(risk);
  for (const thesis of input.theses) {
    if (thesis.epistemicType !== "system_judgment") throw new Error("public snapshot cannot include personal thesis");
  }
  for (const scenario of input.pressureScenarios) assertResearchRiskPressureScenario(scenario);
  for (const relationship of input.relationships) assertResearchRiskRelationship(relationship);
  const modules: ResearchSnapshotModule[] = [
    publicModule("risk-register", input.asOf, input.risks, (risk) => ({
      riskId: risk.riskId, asOf: risk.asOf, scope: risk.scope, category: risk.category, title: risk.title, exposure: risk.exposure,
      transmission: risk.transmission, status: risk.status, triggerCondition: risk.triggerCondition, sourceReferences: risk.sourceReferences,
    })),
    publicModule("theses", input.asOf, input.theses, (thesis) => ({
      thesisId: thesis.thesisId, asOf: thesis.asOf, title: thesis.title, statement: thesis.statement, status: thesis.status,
      invalidationCondition: thesis.invalidationCondition, reviewBy: thesis.reviewBy, evidence: thesis.evidence,
    })),
    publicModule("risk-pressure-scenarios", input.asOf, input.pressureScenarios, (scenario) => ({
      scenarioId: scenario.scenarioId, asOf: scenario.asOf, scenarioKey: scenario.scenarioKey, version: scenario.version,
      status: scenario.status, scope: scenario.scope, modelVersion: scenario.modelVersion, inputs: scenario.inputs, results: scenario.results,
      sourceReferences: scenario.sourceReferences,
    })),
    publicModule("risk-relationships", input.asOf, input.relationships, (relationship) => ({
      relationshipId: relationship.relationshipId, asOf: relationship.asOf, scope: relationship.scope, relationshipType: relationship.relationshipType,
      counterpartyName: relationship.counterpartyName, concentrationValue: relationship.concentrationValue,
      concentrationBasis: relationship.concentrationBasis, status: relationship.status, sourceReferences: relationship.sourceReferences,
    })),
    publicModule("source-impact-review-mappings", input.asOf, input.impactReviews ?? [], (review) => ({
      impactReviewId: review.impactReviewId, sourceKind: review.sourceKind, sourceId: review.sourceId,
      sourceObservedAt: review.sourceObservedAt, reviewer: review.reviewer, rationale: review.rationale,
      sourceBinding: review.sourceBinding, createdAt: review.createdAt,
      targets: review.targets.map((target) => ({ impactReviewTargetId: target.impactReviewTargetId, targetKind: target.targetKind,
        targetId: target.targetId, reviewState: target.reviewState, action: target.action })),
    })),
  ];
  // A focus profile is a public reference graph.  Freeze its current public
  // projection only; private owner membership and any personal notes are not
  // accepted by this type or copied into the payload.
  if (input.focusProfile) {
    if (input.focusProfile.epistemicType !== "system_judgment" || !input.focusProfile.focusProfileId || !input.focusProfile.companyId) throw new Error("public snapshot focus profile must be a public system judgment version");
    modules.push({ moduleId: "company-focus-profile", availability: "available", versionId: input.focusProfile.focusProfileId, asOf: input.focusProfile.asOf, payload: {
      focusProfileId: input.focusProfile.focusProfileId, companyId: input.focusProfile.companyId, version: input.focusProfile.version, asOf: input.focusProfile.asOf, status: input.focusProfile.status, title: input.focusProfile.title, reviewBy: input.focusProfile.reviewBy,
      items: input.focusProfile.items.map((item) => ({ focusItemId: item.focusItemId, role: item.role, targetKind: item.targetKind, targetId: item.targetId, securityCode: item.securityCode, sortOrder: item.sortOrder, target: item.target, unavailableReason: item.unavailableReason })),
      privateDataIncluded: false,
    } });
  }
  for (const module of modules) assertModule(module, "public risk");
  return modules;
}

export function assertResearchRiskThesisLink(input: ResearchRiskThesisLink): void {
  requireText(input.riskId, "risk thesis link riskId");
  requireText(input.thesisId, "risk thesis link thesisId");
  requireText(input.rationale, "risk thesis link rationale");
  assertOneOf(input.relationship, ["invalidates", "pressures", "monitors"], "risk thesis link relationship");
  assertSourceReferences("system_judgment", input.sourceReferences);
}

function assertPublicResearchRecord(securityCode: string, asOf: number, scope: ResearchRiskReviewScope): void {
  requireText(securityCode, "research risk review securityCode");
  assertAsOf(asOf);
  if (scope !== "operating_company" && scope !== "listed_security") throw new Error("risk review scope cannot be user_portfolio");
}

function assertPublicRiskEntry(risk: ResearchRiskEntry): void {
  if (!(["operating_company", "listed_security"] as string[]).includes(risk.scope)) {
    throw new Error("public risk review cannot include user_portfolio risk entries");
  }
  if (risk.epistemicType !== "system_judgment") throw new Error("public risk review requires system judgment risk entries");
  assertSourceReferences(risk.epistemicType, risk.sourceReferences);
}

function numericPair(input: ResearchRiskPressureInput | undefined, expectedUnit: string): { baseline: number | null; stressed: number | null; limitation: string | null } {
  if (!input) return { baseline: null, stressed: null, limitation: "缺少明确输入" };
  if (input.unit !== expectedUnit) return { baseline: null, stressed: null, limitation: `单位必须为 ${expectedUnit}` };
  const baseline = typeof input.baseline === "number" && Number.isFinite(input.baseline) ? input.baseline : null;
  const stressed = typeof input.stressed === "number" && Number.isFinite(input.stressed) ? input.stressed : null;
  if (baseline === null || stressed === null) return { baseline: null, stressed: null, limitation: "基准或压力值不可用" };
  return { baseline, stressed, limitation: null };
}

function directObservation(
  key: ResearchRiskStressObservation["key"],
  label: string,
  pair: { baseline: number | null; stressed: number | null; limitation: string | null },
  unit: string,
  inputKeys: string[],
): ResearchRiskStressObservation {
  if (pair.baseline === null || pair.stressed === null) return unavailableObservation(key, label, unit, inputKeys, pair.limitation ?? "输入不可用");
  return { key, label, baselineValue: pair.baseline, stressedValue: pair.stressed, deltaValue: pair.stressed - pair.baseline, unit, status: "available", inputKeys, limitation: null };
}

function derivedObservation(
  key: ResearchRiskStressObservation["key"],
  label: string,
  left: { baseline: number | null; stressed: number | null; limitation: string | null },
  right: { baseline: number | null; stressed: number | null; limitation: string | null },
  unit: string,
  inputKeys: string[],
  derive: (left: number, right: number) => number,
): ResearchRiskStressObservation {
  if (left.baseline === null || left.stressed === null || right.baseline === null || right.stressed === null) {
    return unavailableObservation(key, label, unit, inputKeys, left.limitation ?? right.limitation ?? "输入不可用");
  }
  const baseline = derive(left.baseline, right.baseline);
  const stressed = derive(left.stressed, right.stressed);
  if (!Number.isFinite(baseline) || !Number.isFinite(stressed)) return unavailableObservation(key, label, unit, inputKeys, "压力输入不满足计算前提");
  return { key, label, baselineValue: baseline, stressedValue: stressed, deltaValue: stressed - baseline, unit, status: "available", inputKeys, limitation: null };
}

function unavailableObservation(
  key: ResearchRiskStressObservation["key"],
  label: string,
  unit: string,
  inputKeys: string[],
  limitation: string,
): ResearchRiskStressObservation {
  return { key, label, baselineValue: null, stressedValue: null, deltaValue: null, unit, status: "unavailable", inputKeys, limitation };
}

function publicModule<T extends { [key: string]: unknown }>(
  moduleId: string,
  asOf: number,
  records: T[],
  project: (record: T) => Record<string, unknown>,
): ResearchSnapshotModule {
  const projected = records.map(project).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return {
    moduleId,
    availability: projected.length ? "available" : "empty",
    versionId: projected.length ? projected.map(stableJson).join("|") : null,
    asOf,
    payload: { records: projected },
  };
}

function assertPublicEpistemicType(value: ResearchEpistemicType): void {
  if (!["observed_fact", "management_guidance", "source_viewpoint", "third_party_forecast", "analysis_assumption", "system_judgment"].includes(value)) {
    throw new Error("risk review records cannot contain user decisions or unsupported epistemic types");
  }
}

function assertModule(module: ResearchSnapshotModule | null, label: string): void {
  if (!module) return;
  requireText(module.moduleId, `${label} snapshot module id`);
  if (!["available", "empty", "unavailable"].includes(module.availability)) throw new Error(`${label} snapshot module availability is invalid`);
  if (module.asOf !== null) assertAsOf(module.asOf);
  if (!module.payload || typeof module.payload !== "object" || Array.isArray(module.payload)) throw new Error(`${label} snapshot module payload must be an object`);
  assertJsonValue(module.payload, `${label} snapshot module payload`);
  assertNoPrivateFields(module.payload, `${label} snapshot module payload`);
}

function assertNoPrivateFields(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateFields(item, label);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["ownerKey", "userDecision", "position", "tradePlan", "order", "membership", "userNote", "userNotes", "localLlmDraft", "synthesisDraft"].includes(key)) {
      throw new Error(`${label} cannot contain private decision field ${key}`);
    }
    if (key === "epistemicType" && nested === "user_decision") {
      throw new Error(`${label} cannot contain a personal decision epistemic type`);
    }
    assertNoPrivateFields(nested, label);
  }
}

function diffModule(baseline: ResearchSnapshotModule | null, current: ResearchSnapshotModule | null): ResearchSnapshotFieldDifference[] {
  if (!baseline) return [{ path: "/", changeType: "added", baselineValue: null, currentValue: current }];
  if (!current) return [{ path: "/", changeType: "removed", baselineValue: baseline, currentValue: null }];
  const before = { availability: baseline.availability, versionId: baseline.versionId, asOf: baseline.asOf, payload: baseline.payload };
  const after = { availability: current.availability, versionId: current.versionId, asOf: current.asOf, payload: current.payload };
  return diffValue(before, after, "");
}

function diffValue(baseline: unknown, current: unknown, path: string): ResearchSnapshotFieldDifference[] {
  if (stableJson(baseline) === stableJson(current)) return [];
  const baselineObject = isPlainObject(baseline);
  const currentObject = isPlainObject(current);
  if (baselineObject && currentObject) {
    const fields: ResearchSnapshotFieldDifference[] = [];
    for (const key of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
      const nextPath = `${path}/${escapePath(key)}`;
      if (!(key in baseline)) fields.push({ path: nextPath, changeType: "added", baselineValue: null, currentValue: current[key] });
      else if (!(key in current)) fields.push({ path: nextPath, changeType: "removed", baselineValue: baseline[key], currentValue: null });
      else fields.push(...diffValue(baseline[key], current[key], nextPath));
    }
    return fields;
  }
  return [{ path: path || "/", changeType: "changed", baselineValue: baseline, currentValue: current }];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertDistinctModuleIds(modules: ResearchSnapshotModule[], label: string): void {
  const ids = new Set<string>();
  for (const module of modules) {
    assertModule(module, label);
    if (ids.has(module.moduleId)) throw new Error(`${label} snapshot modules contain duplicate moduleId`);
    ids.add(module.moduleId);
  }
}

function assertUniqueKeys(items: Array<{ key: string }>, label: string): void {
  const keys = new Set<string>();
  for (const item of items) {
    if (keys.has(item.key)) throw new Error(`${label} keys must be unique`);
    keys.add(item.key);
  }
}

function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${label} must not contain a non-finite number`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label);
    return;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) assertJsonValue(nested, label);
    return;
  }
  throw new Error(`${label} must be JSON serializable`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapePath(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function positiveInteger(value: number): boolean { return Number.isInteger(value) && value > 0; }
function requireText(value: string, label: string): void { if (!value?.trim()) throw new Error(`${label} is required`); }
function assertOneOf(value: string, accepted: string[], label: string): void { if (!accepted.includes(value)) throw new Error(`${label} is invalid`); }
