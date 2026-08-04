import {
  assertResearchRiskPressureScenario,
  assertResearchRiskRelationship,
  assertResearchRiskThesisLink,
  assertResearchSnapshotModuleDifference,
  buildPublicRiskSnapshotModules,
  diffResearchSnapshotModules,
  type ResearchRiskPressureScenario,
  type ResearchRiskRelationship,
  type ResearchRiskThesisLink,
  type ResearchSnapshotFieldDifference,
  type ResearchSnapshotModule,
  type ResearchSnapshotModuleDifference,
} from "../domain/research-risk-review";
import type { GuidanceEventImpactReview } from "../domain/guidance-event-impact-review";
import { assertAsOf, assertSourceReferences, type ResearchAnalysisSnapshot, type ResearchRiskEntry, type ResearchSourceReference, type ResearchThesis } from "../domain/research-dossier";

type Row = Record<string, unknown>;

export type ResearchRiskReview = {
  availability: "available" | "empty" | "unavailable";
  reason: "no_records" | "storage_not_initialized" | null;
  pressureScenarios: ResearchRiskPressureScenario[];
  relationships: ResearchRiskRelationship[];
  thesisLinks: ResearchRiskThesisLinkRecord[];
  snapshotDifferences: ResearchSnapshotModuleDifference[];
};

export type ResearchRiskThesisLinkRecord = ResearchRiskThesisLink & {
  riskThesisLinkId: string;
  createdAt: number;
};

/** A replayable, public-only point-in-time view.  The payload is read from the
 * frozen modules, never reconstructed from today's mutable research records. */
export type PublicRiskReviewSnapshotHistoryItem = {
  analysisSnapshotId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  completionLevel: "basic" | "standard" | "deep";
  state: string;
  summary: Record<string, unknown>;
  moduleStatus: Record<string, unknown>;
  createdAt: number;
  modules: ResearchSnapshotModule[];
  differences: ResearchSnapshotModuleDifference[];
};

export type PublicRiskReviewSnapshotHistory = {
  availability: "available" | "empty" | "unavailable";
  reason: "no_records" | "storage_not_initialized" | null;
  items: PublicRiskReviewSnapshotHistoryItem[];
};

export type PublicRiskReviewSnapshotWrite = {
  analysisSnapshotId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  completionLevel: ResearchAnalysisSnapshot["completionLevel"];
  state: string;
  createdAt: number;
  risks: ResearchRiskEntry[];
  theses: ResearchThesis[];
  pressureScenarios: ResearchRiskPressureScenario[];
  relationships: ResearchRiskRelationship[];
  impactReviews?: GuidanceEventImpactReview[];
  focusProfile?: Parameters<typeof buildPublicRiskSnapshotModules>[0]["focusProfile"];
};

/**
 * Integration seam for the snapshot writer: build public-only risk modules,
 * then calculate the exact deltas against the module set frozen previously.
 * The caller persists the returned differences only after it has persisted the
 * current analysis snapshot, so foreign-key references remain valid.
 */
export function planPublicRiskSnapshotDifferences(input: {
  differenceIdPrefix: string;
  securityCode: string;
  companyId: string | null;
  baselineSnapshotId: string | null;
  currentSnapshotId: string;
  baselineModules: ResearchSnapshotModule[];
  asOf: number;
  createdAt: number;
  risks: ResearchRiskEntry[];
  theses: ResearchThesis[];
  pressureScenarios: ResearchRiskPressureScenario[];
  relationships: ResearchRiskRelationship[];
  impactReviews?: GuidanceEventImpactReview[];
  focusProfile?: Parameters<typeof buildPublicRiskSnapshotModules>[0]["focusProfile"];
}): { currentModules: ResearchSnapshotModule[]; differences: ResearchSnapshotModuleDifference[] } {
  const currentModules = buildPublicRiskSnapshotModules({
    asOf: input.asOf,
    risks: input.risks,
    theses: input.theses,
    pressureScenarios: input.pressureScenarios,
    relationships: input.relationships,
    impactReviews: input.impactReviews,
    focusProfile: input.focusProfile,
  });
  return {
    currentModules,
    differences: diffResearchSnapshotModules({
      differenceIdPrefix: input.differenceIdPrefix,
      securityCode: input.securityCode,
      companyId: input.companyId,
      baselineSnapshotId: input.baselineSnapshotId,
      currentSnapshotId: input.currentSnapshotId,
      baseline: input.baselineModules,
      current: currentModules,
      createdAt: input.createdAt,
    }),
  };
}

export async function loadResearchRiskReview(db: D1Database, input: { securityCode: string; asOf: number }): Promise<ResearchRiskReview> {
  const securityCode = input.securityCode.trim().toUpperCase();
  if (!securityCode) throw new Error("research risk review securityCode is required");
  try {
    const [scenarios, relationships, links, differences] = await Promise.all([
      db.prepare(`select * from research_risk_pressure_scenarios where security_code=? and as_of<=? order by as_of desc, scenario_key, version desc`).bind(securityCode, input.asOf).all<Row>(),
      db.prepare(`select * from research_risk_relationships where security_code=? and as_of<=? order by as_of desc, relationship_type, counterparty_name`).bind(securityCode, input.asOf).all<Row>(),
      db.prepare(`select l.* from research_risk_thesis_links l join research_risk_entries r on r.risk_id=l.risk_id
        where r.security_code=? and r.as_of<=? order by l.created_at desc, l.risk_thesis_link_id`).bind(securityCode, input.asOf).all<Row>(),
      db.prepare(`select * from research_snapshot_module_differences where security_code=? and created_at<=? order by created_at desc, module_id`).bind(securityCode, input.asOf).all<Row>(),
    ]);
    const result = {
      pressureScenarios: scenarios.results.map(mapPressureScenario),
      relationships: relationships.results.map(mapRelationship),
      thesisLinks: links.results.map(mapRiskThesisLink),
      snapshotDifferences: differences.results.map(mapSnapshotDifference),
    };
    const any = result.pressureScenarios.length + result.relationships.length + result.thesisLinks.length + result.snapshotDifferences.length > 0;
    return { availability: any ? "available" : "empty", reason: any ? null : "no_records", ...result };
  } catch (error) {
    if (isMissingTableError(error)) return { availability: "unavailable", reason: "storage_not_initialized", pressureScenarios: [], relationships: [], thesisLinks: [], snapshotDifferences: [] };
    throw error;
  }
}

/**
 * Reads exactly the public risk-review snapshots that existed at the requested
 * time.  This keeps historical review honest: no current risk, thesis or
 * relationship record is substituted for a missing frozen module.
 */
export async function loadPublicRiskReviewSnapshotHistory(
  db: D1Database,
  input: { securityCode: string; asOf: number; limit?: number },
): Promise<PublicRiskReviewSnapshotHistory> {
  const securityCode = input.securityCode.trim().toUpperCase();
  if (!securityCode) throw new Error("research snapshot history securityCode is required");
  assertAsOf(input.asOf);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 24), 1), 100);
  try {
    const snapshots = await db.prepare(`select analysis_snapshot_id as analysisSnapshotId, company_id as companyId,
        security_code as securityCode, as_of as asOf, completion_level as completionLevel, state,
        summary_json as summaryJson, module_status_json as moduleStatusJson, created_at as createdAt
      from research_analysis_snapshots
      where security_code=? and as_of<=?
      order by as_of desc, created_at desc, analysis_snapshot_id desc limit ?`)
      .bind(securityCode, input.asOf, limit).all<Row>();
    const publicRows = snapshots.results.filter((row) => parseObject(row.summaryJson, "summaryJson").kind === "public_risk_review_snapshot");
    if (!publicRows.length) return { availability: "empty", reason: "no_records", items: [] };
    const ids = publicRows.map((row) => requiredText(row.analysisSnapshotId, "analysisSnapshotId"));
    const placeholders = ids.map(() => "?").join(",");
    const differences = await db.prepare(`select * from research_snapshot_module_differences
      where current_snapshot_id in (${placeholders}) order by created_at desc, module_id, difference_id`).bind(...ids).all<Row>();
    const bySnapshot = new Map<string, ResearchSnapshotModuleDifference[]>();
    for (const row of differences.results) {
      const difference = mapSnapshotDifference(row);
      bySnapshot.set(difference.currentSnapshotId, [...(bySnapshot.get(difference.currentSnapshotId) ?? []), difference]);
    }
    const items = await Promise.all(publicRows.map(async (row) => {
      const analysisSnapshotId = requiredText(row.analysisSnapshotId, "analysisSnapshotId");
      return {
        analysisSnapshotId,
        companyId: nullableText(row.companyId),
        securityCode: requiredText(row.securityCode, "securityCode"),
        asOf: requiredNumber(row.asOf, "asOf"),
        completionLevel: requiredText(row.completionLevel, "completionLevel") as PublicRiskReviewSnapshotHistoryItem["completionLevel"],
        state: requiredText(row.state, "state"),
        summary: parseObject(row.summaryJson, "summaryJson"),
        moduleStatus: parseObject(row.moduleStatusJson, "moduleStatusJson"),
        createdAt: requiredNumber(row.createdAt, "createdAt"),
        modules: await loadResearchSnapshotModules(db, analysisSnapshotId),
        differences: bySnapshot.get(analysisSnapshotId) ?? [],
      };
    }));
    return { availability: "available", reason: null, items };
  } catch (error) {
    if (isMissingTableError(error)) return { availability: "unavailable", reason: "storage_not_initialized", items: [] };
    throw error;
  }
}

export async function insertResearchRiskPressureScenario(db: D1Database, input: ResearchRiskPressureScenario) {
  assertResearchRiskPressureScenario(input);
  return runInsert(db, "research_risk_pressure_scenarios", input.scenarioId, db.prepare(`insert into research_risk_pressure_scenarios (
    scenario_id, company_id, security_code, as_of, scenario_key, version, supersedes_scenario_id, status, scope,
    title, transmission, model_version, inputs_json, results_json, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.scenarioId, input.companyId ?? null, input.securityCode.trim().toUpperCase(), input.asOf, input.scenarioKey, input.version,
      input.supersedesScenarioId ?? null, input.status, input.scope, input.title, input.transmission, input.modelVersion,
      JSON.stringify(input.inputs), JSON.stringify(input.results), JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt));
}

export async function loadResearchRiskPressureScenario(db: D1Database, input: { securityCode: string; scenarioId: string }) {
  try {
    const row = await db.prepare(`select * from research_risk_pressure_scenarios where security_code=? and scenario_id=?`)
      .bind(input.securityCode.trim().toUpperCase(), input.scenarioId).first<Row>();
    return row ? mapPressureScenario(row) : null;
  } catch (error) {
    if (isMissingTableError(error, "research_risk_pressure_scenarios")) return null;
    throw error;
  }
}

export async function insertResearchRiskRelationship(db: D1Database, input: ResearchRiskRelationship) {
  assertResearchRiskRelationship(input);
  return runInsert(db, "research_risk_relationships", input.relationshipId, db.prepare(`insert into research_risk_relationships (
    relationship_id, company_id, security_code, as_of, scope, relationship_type, counterparty_name, description,
    transmission, concentration_value, concentration_basis, status, epistemic_type, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.relationshipId, input.companyId ?? null, input.securityCode.trim().toUpperCase(), input.asOf, input.scope,
      input.relationshipType, input.counterpartyName, input.description, input.transmission, input.concentrationValue,
      input.concentrationBasis, input.status, input.epistemicType, JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt));
}

export async function insertResearchRiskThesisLink(db: D1Database, input: ResearchRiskThesisLinkRecord) {
  assertResearchRiskThesisLink(input);
  if (!input.riskThesisLinkId.trim()) throw new Error("risk thesis link id is required");
  if (!Number.isInteger(input.createdAt) || input.createdAt <= 0) throw new Error("risk thesis link createdAt must be a positive integer");
  return runInsert(db, "research_risk_thesis_links", input.riskThesisLinkId, db.prepare(`insert into research_risk_thesis_links (
    risk_thesis_link_id, risk_id, thesis_id, relationship, rationale, source_refs_json, created_at
  ) values (?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.riskThesisLinkId, input.riskId, input.thesisId, input.relationship, input.rationale,
      JSON.stringify(input.sourceReferences), input.createdAt));
}

export async function validateRiskThesisLinkOwnership(db: D1Database, input: { securityCode: string; companyId: string; riskId: string; thesisId: string }): Promise<boolean> {
  const row = await db.prepare(`select 1 as matched from research_risk_entries r join research_theses t on t.thesis_id=?
    where r.risk_id=? and r.security_code=? and t.company_id=? and r.scope in ('operating_company', 'listed_security') limit 1`)
    .bind(input.thesisId, input.riskId, input.securityCode.trim().toUpperCase(), input.companyId).first<{ matched: number }>();
  return Boolean(row?.matched);
}

/** Saves a dated, public-only snapshot plus reconstructible module state and differences in one D1 batch. */
export async function savePublicRiskReviewSnapshot(db: D1Database, input: PublicRiskReviewSnapshotWrite) {
  assertPublicRiskSnapshotWrite(input);
  try {
    // `research_analysis_snapshots` also stores the older generic dossier
    // snapshot.  It has no frozen module rows and therefore is not a valid
    // baseline for a public risk-review diff.  Selecting it here would turn
    // every later public module into a false "added" change.  The summary
    // discriminator is written in this same batch and keeps the comparison
    // within the replayable, public-only snapshot series.
    const prior = await db.prepare(`select analysis_snapshot_id as analysisSnapshotId from research_analysis_snapshots
      where security_code=? and json_extract(summary_json, '$.kind')='public_risk_review_snapshot'
        and (as_of<? or (as_of=? and created_at<?)) order by as_of desc, created_at desc, analysis_snapshot_id desc limit 1`)
      .bind(input.securityCode, input.asOf, input.asOf, input.createdAt).first<{ analysisSnapshotId: string }>();
    const baselineModules = prior ? await loadResearchSnapshotModules(db, prior.analysisSnapshotId) : [];
    const plan = planPublicRiskSnapshotDifferences({
      differenceIdPrefix: `snapshot-diff:${input.analysisSnapshotId}`,
      securityCode: input.securityCode,
      companyId: input.companyId,
      baselineSnapshotId: prior?.analysisSnapshotId ?? null,
      currentSnapshotId: input.analysisSnapshotId,
      baselineModules,
      asOf: input.asOf,
      createdAt: input.createdAt,
      risks: input.risks,
      theses: input.theses,
      pressureScenarios: input.pressureScenarios,
      relationships: input.relationships,
      impactReviews: input.impactReviews,
      focusProfile: input.focusProfile,
    });
    const moduleStatus = Object.fromEntries(plan.currentModules.map((module) => [module.moduleId, {
      availability: module.availability, versionId: module.versionId, asOf: module.asOf,
    }]));
    const summary = {
      kind: "public_risk_review_snapshot",
      source: "typed_research_records",
      baselineSnapshotId: prior?.analysisSnapshotId ?? null,
      changedModuleCount: plan.differences.length,
      privateDataIncluded: false,
    };
    const statements: D1PreparedStatement[] = [db.prepare(`insert into research_analysis_snapshots (
      analysis_snapshot_id, company_id, security_code, as_of, completion_level, state, summary_json, module_status_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      input.analysisSnapshotId, input.companyId, input.securityCode, input.asOf, input.completionLevel, input.state,
      JSON.stringify(summary), JSON.stringify(moduleStatus), input.createdAt,
    )];
    for (const module of plan.currentModules) statements.push(db.prepare(`insert into research_analysis_snapshot_modules (
      analysis_snapshot_id, module_id, availability, version_id, module_as_of, payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.analysisSnapshotId, module.moduleId, module.availability, module.versionId, module.asOf,
        JSON.stringify(module.payload), input.createdAt));
    for (const difference of plan.differences) statements.push(snapshotDifferenceStatement(db, difference));
    await db.batch(statements);
    return {
      state: "saved" as const,
      analysisSnapshotId: input.analysisSnapshotId,
      baselineSnapshotId: prior?.analysisSnapshotId ?? null,
      moduleCount: plan.currentModules.length,
      differenceIds: plan.differences.map((difference) => difference.differenceId),
      reason: null,
    };
  } catch (error) {
    if (isMissingTableError(error)) return {
      state: "unavailable" as const, analysisSnapshotId: input.analysisSnapshotId, baselineSnapshotId: null,
      moduleCount: 0, differenceIds: [] as string[], reason: "storage_not_initialized" as const,
    };
    throw error;
  }
}

export async function loadResearchSnapshotModules(db: D1Database, analysisSnapshotId: string): Promise<ResearchSnapshotModule[]> {
  const rows = await db.prepare(`select module_id as moduleId, availability, version_id as versionId, module_as_of as asOf, payload_json as payloadJson
    from research_analysis_snapshot_modules where analysis_snapshot_id=? order by module_id`).bind(analysisSnapshotId).all<Row>();
  return rows.results.map((row) => ({
    moduleId: requiredText(row.moduleId, "moduleId"), availability: requiredText(row.availability, "availability") as ResearchSnapshotModule["availability"],
    versionId: nullableText(row.versionId), asOf: nullableNumber(row.asOf), payload: parseObject(row.payloadJson, "payloadJson"),
  }));
}

export async function insertResearchSnapshotModuleDifferences(db: D1Database, inputs: ResearchSnapshotModuleDifference[]) {
  for (const input of inputs) assertResearchSnapshotModuleDifference(input);
  if (!inputs.length) return { state: "saved" as const, recordIds: [] as string[], reason: null };
  try {
    await db.batch(inputs.map((input) => db.prepare(`insert into research_snapshot_module_differences (
      difference_id, company_id, security_code, baseline_snapshot_id, current_snapshot_id, module_id, diff_version,
      change_type, baseline_json, current_json, fields_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.differenceId, input.companyId, input.securityCode.trim().toUpperCase(), input.baselineSnapshotId,
        input.currentSnapshotId, input.moduleId, input.diffVersion, input.changeType, JSON.stringify(input.baseline),
        JSON.stringify(input.current), JSON.stringify(input.fields), input.createdAt)));
    return { state: "saved" as const, recordIds: inputs.map((input) => input.differenceId), reason: null };
  } catch (error) {
    if (isMissingTableError(error, "research_snapshot_module_differences")) {
      return { state: "unavailable" as const, recordIds: inputs.map((input) => input.differenceId), reason: "storage_not_initialized" as const };
    }
    throw error;
  }
}

async function runInsert(db: D1Database, table: string, recordId: string, statement: D1PreparedStatement) {
  try {
    await db.batch([statement]);
    return { state: "saved" as const, recordId, reason: null };
  } catch (error) {
    if (isMissingTableError(error, table)) return { state: "unavailable" as const, recordId, reason: "storage_not_initialized" as const };
    throw error;
  }
}

function mapPressureScenario(row: Row): ResearchRiskPressureScenario {
  const input: ResearchRiskPressureScenario = {
    scenarioId: requiredText(row.scenario_id, "scenario_id"), companyId: nullableText(row.company_id), securityCode: requiredText(row.security_code, "security_code"),
    asOf: requiredNumber(row.as_of, "as_of"), scenarioKey: requiredText(row.scenario_key, "scenario_key"), version: requiredNumber(row.version, "version"),
    supersedesScenarioId: nullableText(row.supersedes_scenario_id), status: requiredText(row.status, "status") as ResearchRiskPressureScenario["status"],
    scope: requiredText(row.scope, "scope") as ResearchRiskPressureScenario["scope"], title: requiredText(row.title, "title"), transmission: requiredText(row.transmission, "transmission"),
    modelVersion: requiredText(row.model_version, "model_version"), inputs: parseArray(row.inputs_json, "inputs_json") as ResearchRiskPressureScenario["inputs"],
    results: parseArray(row.results_json, "results_json") as ResearchRiskPressureScenario["results"], sourceReferences: parseReferences(row.source_refs_json),
    createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
  assertResearchRiskPressureScenario(input);
  return input;
}

function mapRelationship(row: Row): ResearchRiskRelationship {
  const input: ResearchRiskRelationship = {
    relationshipId: requiredText(row.relationship_id, "relationship_id"), companyId: nullableText(row.company_id), securityCode: requiredText(row.security_code, "security_code"),
    asOf: requiredNumber(row.as_of, "as_of"), scope: requiredText(row.scope, "scope") as ResearchRiskRelationship["scope"],
    relationshipType: requiredText(row.relationship_type, "relationship_type") as ResearchRiskRelationship["relationshipType"], counterpartyName: requiredText(row.counterparty_name, "counterparty_name"),
    description: requiredText(row.description, "description"), transmission: requiredText(row.transmission, "transmission"), concentrationValue: nullableNumber(row.concentration_value),
    concentrationBasis: nullableText(row.concentration_basis), status: requiredText(row.status, "status") as ResearchRiskRelationship["status"],
    epistemicType: requiredText(row.epistemic_type, "epistemic_type") as ResearchRiskRelationship["epistemicType"], sourceReferences: parseReferences(row.source_refs_json),
    createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
  assertResearchRiskRelationship(input);
  return input;
}

function mapRiskThesisLink(row: Row): ResearchRiskThesisLinkRecord {
  const input: ResearchRiskThesisLinkRecord = {
    riskThesisLinkId: requiredText(row.risk_thesis_link_id, "risk_thesis_link_id"),
    riskId: requiredText(row.risk_id, "risk_id"), thesisId: requiredText(row.thesis_id, "thesis_id"),
    relationship: requiredText(row.relationship, "relationship") as ResearchRiskThesisLinkRecord["relationship"],
    rationale: requiredText(row.rationale, "rationale"), sourceReferences: parseReferences(row.source_refs_json),
    createdAt: requiredNumber(row.created_at, "created_at"),
  };
  assertResearchRiskThesisLink(input);
  return input;
}

function mapSnapshotDifference(row: Row): ResearchSnapshotModuleDifference {
  const input: ResearchSnapshotModuleDifference = {
    differenceId: requiredText(row.difference_id, "difference_id"), companyId: nullableText(row.company_id), securityCode: requiredText(row.security_code, "security_code"),
    baselineSnapshotId: nullableText(row.baseline_snapshot_id), currentSnapshotId: requiredText(row.current_snapshot_id, "current_snapshot_id"),
    moduleId: requiredText(row.module_id, "module_id"), diffVersion: requiredText(row.diff_version, "diff_version") as ResearchSnapshotModuleDifference["diffVersion"],
    changeType: requiredText(row.change_type, "change_type") as ResearchSnapshotModuleDifference["changeType"],
    baseline: parseNullableModule(row.baseline_json, "baseline_json"), current: parseNullableModule(row.current_json, "current_json"),
    fields: parseArray(row.fields_json, "fields_json") as ResearchSnapshotFieldDifference[], createdAt: requiredNumber(row.created_at, "created_at"),
  };
  assertResearchSnapshotModuleDifference(input);
  return input;
}

function parseNullableModule(value: unknown, label: string): ResearchSnapshotModule | null {
  const parsed = parseJson(value, label);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object or null`);
  return parsed as ResearchSnapshotModule;
}

function parseReferences(value: unknown): ResearchSourceReference[] {
  const parsed = parseArray(value, "source references");
  for (const reference of parsed) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("risk review source reference must be an object");
  }
  return parsed as ResearchSourceReference[];
}

function parseArray(value: unknown, label: string): unknown[] {
  const parsed = parseJson(value, label);
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  return parsed;
}
function parseObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function snapshotDifferenceStatement(db: D1Database, input: ResearchSnapshotModuleDifference): D1PreparedStatement {
  assertResearchSnapshotModuleDifference(input);
  return db.prepare(`insert into research_snapshot_module_differences (
    difference_id, company_id, security_code, baseline_snapshot_id, current_snapshot_id, module_id, diff_version,
    change_type, baseline_json, current_json, fields_json, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.differenceId, input.companyId, input.securityCode.trim().toUpperCase(), input.baselineSnapshotId,
      input.currentSnapshotId, input.moduleId, input.diffVersion, input.changeType, JSON.stringify(input.baseline),
      JSON.stringify(input.current), JSON.stringify(input.fields), input.createdAt);
}

function assertPublicRiskSnapshotWrite(input: PublicRiskReviewSnapshotWrite): void {
  if (!input.analysisSnapshotId.trim()) throw new Error("public risk snapshot id is required");
  if (!input.securityCode.trim()) throw new Error("public risk snapshot securityCode is required");
  assertAsOf(input.asOf);
  if (!Number.isInteger(input.createdAt) || input.createdAt <= 0) throw new Error("public risk snapshot createdAt must be a positive integer");
  if (!["basic", "standard", "deep"].includes(input.completionLevel)) throw new Error("public risk snapshot completionLevel is invalid");
  if (!input.state.trim()) throw new Error("public risk snapshot state is required");
}
function parseJson(value: unknown, label: string): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { throw new Error(`${label} contains invalid JSON`); } }
function requiredText(value: unknown, label: string): string { const text = typeof value === "string" ? value.trim() : ""; if (!text) throw new Error(`${label} is required`); return text; }
function nullableText(value: unknown): string | null { const text = typeof value === "string" ? value.trim() : ""; return text || null; }
function requiredNumber(value: unknown, label: string): number { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${label} must be numeric`); return number; }
function nullableNumber(value: unknown): number | null { if (value === null || value === undefined || value === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function isMissingTableError(error: unknown, table?: string): boolean { const message = error instanceof Error ? error.message : String(error); return /(?:no such table|does not exist|not found).*research_/i.test(message) && (!table || message.toLowerCase().includes(table.toLowerCase())); }
