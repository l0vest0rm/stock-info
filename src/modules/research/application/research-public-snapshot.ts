import {
  PUBLIC_RESEARCH_SNAPSHOT_KIND,
  planPublicResearchSnapshotDifferences,
  type PublicResearchSnapshotInput,
} from "../domain/research-public-snapshot";
import type { ResearchSnapshotModule, ResearchSnapshotModuleDifference } from "../domain/research-risk-review";
import { loadResearchSnapshotModules } from "./research-risk-review";

type Row = Record<string, unknown>;

export type PublicResearchSnapshotWrite = {
  analysisSnapshotId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  completionLevel: "basic" | "standard" | "deep";
  state: string;
  createdAt: number;
  snapshot: PublicResearchSnapshotInput;
};

export type PublicResearchSnapshotHistoryItem = {
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

export async function savePublicResearchSnapshot(db: D1Database, input: PublicResearchSnapshotWrite) {
  assertWrite(input);
  try {
    const prior = await db.prepare(`select analysis_snapshot_id as analysisSnapshotId from research_analysis_snapshots
      where security_code=? and json_extract(summary_json, '$.kind')=?
        and (as_of<? or (as_of=? and created_at<?)) order by as_of desc, created_at desc, analysis_snapshot_id desc limit 1`)
      .bind(input.securityCode, PUBLIC_RESEARCH_SNAPSHOT_KIND, input.asOf, input.asOf, input.createdAt).first<{ analysisSnapshotId: string }>();
    const baselineModules = prior ? await loadResearchSnapshotModules(db, prior.analysisSnapshotId) : [];
    const plan = planPublicResearchSnapshotDifferences({
      differenceIdPrefix: `public-research-snapshot-diff:${input.analysisSnapshotId}`,
      securityCode: input.securityCode, companyId: input.companyId,
      baselineSnapshotId: prior?.analysisSnapshotId ?? null, currentSnapshotId: input.analysisSnapshotId,
      baselineModules, createdAt: input.createdAt, snapshot: input.snapshot,
    });
    const moduleStatus = Object.fromEntries(plan.currentModules.map((item) => [item.moduleId, {
      availability: item.availability, versionId: item.versionId, asOf: item.asOf,
    }]));
    const summary = {
      kind: PUBLIC_RESEARCH_SNAPSHOT_KIND,
      source: "typed_public_research_records",
      baselineSnapshotId: prior?.analysisSnapshotId ?? null,
      changedModuleCount: plan.differences.length,
      privateDataIncluded: false,
      localLlmDraftIncluded: false,
      realtimeMarketDataIncluded: false,
    };
    const statements: D1PreparedStatement[] = [db.prepare(`insert into research_analysis_snapshots (
      analysis_snapshot_id, company_id, security_code, as_of, completion_level, state, summary_json, module_status_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.analysisSnapshotId, input.companyId, input.securityCode, input.asOf, input.completionLevel, input.state,
        JSON.stringify(summary), JSON.stringify(moduleStatus), input.createdAt)];
    for (const item of plan.currentModules) statements.push(db.prepare(`insert into research_analysis_snapshot_modules (
      analysis_snapshot_id, module_id, availability, version_id, module_as_of, payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.analysisSnapshotId, item.moduleId, item.availability, item.versionId, item.asOf, JSON.stringify(item.payload), input.createdAt));
    for (const item of plan.differences) statements.push(differenceStatement(db, item));
    await db.batch(statements);
    return { state: "saved" as const, analysisSnapshotId: input.analysisSnapshotId, baselineSnapshotId: prior?.analysisSnapshotId ?? null,
      moduleCount: plan.currentModules.length, differenceIds: plan.differences.map((item) => item.differenceId), reason: null };
  } catch (error) {
    if (isMissingTableError(error)) return { state: "unavailable" as const, analysisSnapshotId: input.analysisSnapshotId,
      baselineSnapshotId: null, moduleCount: 0, differenceIds: [] as string[], reason: "storage_not_initialized" as const };
    throw error;
  }
}

/** History is exclusively replayed from frozen module payloads. */
export async function loadPublicResearchSnapshotHistory(db: D1Database, input: { securityCode: string; asOf: number; limit?: number }) {
  const securityCode = input.securityCode.trim().toUpperCase();
  if (!securityCode) throw new Error("public research snapshot securityCode is required");
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 24), 1), 100);
  try {
    const rows = await db.prepare(`select analysis_snapshot_id as analysisSnapshotId, company_id as companyId, security_code as securityCode,
      as_of as asOf, completion_level as completionLevel, state, summary_json as summaryJson, module_status_json as moduleStatusJson, created_at as createdAt
      from research_analysis_snapshots where security_code=? and as_of<=? and json_extract(summary_json, '$.kind')=?
      order by as_of desc, created_at desc, analysis_snapshot_id desc limit ?`)
      .bind(securityCode, input.asOf, PUBLIC_RESEARCH_SNAPSHOT_KIND, limit).all<Row>();
    if (!rows.results.length) return { availability: "empty" as const, reason: "no_records" as const, items: [] as PublicResearchSnapshotHistoryItem[] };
    const ids = rows.results.map((row) => text(row.analysisSnapshotId, "analysisSnapshotId"));
    const differences = await db.prepare(`select * from research_snapshot_module_differences where current_snapshot_id in (${ids.map(() => "?").join(",")}) order by created_at desc, module_id, difference_id`)
      .bind(...ids).all<Row>();
    const bySnapshot = new Map<string, ResearchSnapshotModuleDifference[]>();
    for (const row of differences.results) {
      const difference = mapDifference(row);
      bySnapshot.set(difference.currentSnapshotId, [...(bySnapshot.get(difference.currentSnapshotId) ?? []), difference]);
    }
    const items = await Promise.all(rows.results.map(async (row) => ({
      analysisSnapshotId: text(row.analysisSnapshotId, "analysisSnapshotId"), companyId: nullableText(row.companyId), securityCode: text(row.securityCode, "securityCode"),
      asOf: number(row.asOf, "asOf"), completionLevel: text(row.completionLevel, "completionLevel") as PublicResearchSnapshotHistoryItem["completionLevel"], state: text(row.state, "state"),
      summary: object(row.summaryJson, "summaryJson"), moduleStatus: redactModuleStatus(object(row.moduleStatusJson, "moduleStatusJson")), createdAt: number(row.createdAt, "createdAt"),
      modules: (await loadResearchSnapshotModules(db, text(row.analysisSnapshotId, "analysisSnapshotId"))).map(redactValuationOutputs),
      differences: (bySnapshot.get(text(row.analysisSnapshotId, "analysisSnapshotId")) ?? []).map((difference) => ({
        ...difference,
        baseline: difference.baseline ? redactValuationOutputs(difference.baseline) : null,
        current: difference.current ? redactValuationOutputs(difference.current) : null,
        // A module-level `added`/`removed` field can hold the complete old
        // payload in currentValue/baselineValue.  Redact it too; otherwise a
        // historical diff becomes an alternate public path around valuation
        // gates even though its module replay is safe.
        fields: difference.fields.map((field) => ({
          ...field,
          baselineValue: redactValueTree(field.baselineValue),
          currentValue: redactValueTree(field.currentValue),
        })),
      })),
    })));
    return { availability: "available" as const, reason: null, items };
  } catch (error) {
    if (isMissingTableError(error)) return { availability: "unavailable" as const, reason: "storage_not_initialized" as const, items: [] as PublicResearchSnapshotHistoryItem[] };
    throw error;
  }
}

function differenceStatement(db: D1Database, item: ResearchSnapshotModuleDifference): D1PreparedStatement {
  return db.prepare(`insert into research_snapshot_module_differences (
    difference_id, company_id, security_code, baseline_snapshot_id, current_snapshot_id, module_id, diff_version, change_type, baseline_json, current_json, fields_json, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(item.differenceId, item.companyId, item.securityCode, item.baselineSnapshotId, item.currentSnapshotId, item.moduleId, item.diffVersion,
      item.changeType, JSON.stringify(item.baseline), JSON.stringify(item.current), JSON.stringify(item.fields), item.createdAt);
}
function assertWrite(input: PublicResearchSnapshotWrite) {
  if (!input.analysisSnapshotId.trim() || !input.securityCode.trim() || !input.state.trim()) throw new Error("public research snapshot id, securityCode and state are required");
  if (!Number.isInteger(input.asOf) || input.asOf <= 0 || !Number.isInteger(input.createdAt) || input.createdAt <= 0) throw new Error("public research snapshot timestamps must be positive integers");
}
function mapDifference(row: Row): ResearchSnapshotModuleDifference {
  return { differenceId: text(row.difference_id, "difference_id"), companyId: nullableText(row.company_id), securityCode: text(row.security_code, "security_code"),
    baselineSnapshotId: nullableText(row.baseline_snapshot_id), currentSnapshotId: text(row.current_snapshot_id, "current_snapshot_id"), moduleId: text(row.module_id, "module_id"),
    diffVersion: text(row.diff_version, "diff_version") as ResearchSnapshotModuleDifference["diffVersion"], changeType: text(row.change_type, "change_type") as ResearchSnapshotModuleDifference["changeType"],
    baseline: nullableModule(row.baseline_json), current: nullableModule(row.current_json), fields: array(row.fields_json) as ResearchSnapshotModuleDifference["fields"], createdAt: number(row.created_at, "created_at") };
}
function nullableModule(value: unknown): ResearchSnapshotModule | null { const parsed = json(value); return parsed === null ? null : parsed as ResearchSnapshotModule; }
/**
 * Historic snapshots written before the public snapshot contract was tightened
 * must not provide an alternate public route to precise valuation outputs.
 * Values remain in their immutable model records and the live read model
 * decides, through current gates, whether they can be displayed.
 */
function redactValuationOutputs(module: ResearchSnapshotModule): ResearchSnapshotModule {
  if (module.moduleId !== "valuation-versions") return module;
  return { ...module, versionId: publicValuationVersionId(module.versionId), payload: redactValueTree(module.payload) as Record<string, unknown> };
}
function redactValueTree(value: unknown): unknown {
  const forbidden = new Set(["perSecurityValue", "enterpriseValue", "equityValue", "valuePerShare", "sensitivity", "pricePerSecurity", "marketCapitalizationInSecurityCurrency", "impliedTerminalUnleveredFreeCashFlow", "impliedTerminalRevenue"]);
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(record).filter(([key]) => !forbidden.has(key)).map(([key, nested]) => [key, visit(nested)]));
    // Historic field-level differences can contain a whole module object as a
    // value. Its old versionId was a stable JSON serialization of the module
    // payload, so remove that indirect channel as well as direct output keys.
    if (record.moduleId === "valuation-versions") result.versionId = publicValuationVersionId(record.versionId);
    return result;
  };
  return visit(value);
}
function redactModuleStatus(status: Record<string, unknown>): Record<string, unknown> {
  const valuation = status["valuation-versions"];
  if (!valuation || typeof valuation !== "object" || Array.isArray(valuation)) return status;
  return { ...status, "valuation-versions": { ...(valuation as Record<string, unknown>), versionId: publicValuationVersionId((valuation as Record<string, unknown>).versionId) } };
}
function publicValuationVersionId(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return "valuation-output-redacted.v1";
}
function object(value: unknown, label: string): Record<string, unknown> { const parsed = json(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be object`); return parsed as Record<string, unknown>; }
function array(value: unknown): unknown[] { const parsed = json(value); if (!Array.isArray(parsed)) throw new Error("snapshot fields must be array"); return parsed; }
function json(value: unknown): unknown { return typeof value === "string" ? JSON.parse(value) : value; }
function text(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function nullableText(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown, label: string): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`${label} must be finite`); return result; }
function isMissingTableError(error: unknown): boolean { return /(?:no such table|does not exist|not found).*research_/i.test(error instanceof Error ? error.message : String(error)); }
