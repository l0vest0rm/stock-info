import {
  buildRelativeValuationLedger,
  type BuildRelativeValuationLedgerInput,
  type RelativeValuationComparabilityGate,
  type RelativeValuationInput,
  type RelativeValuationMetric,
  type ResearchRelativeValuationLedger,
} from "../domain/relative-valuation-ledger";
import type { ResearchSourceReference } from "../domain/research-dossier";

type Row = Record<string, unknown>;
export type RelativeValuationLedgerSection = {
  availability: "available" | "empty" | "unavailable";
  reason: "no_records" | "storage_not_initialized" | null;
  items: ResearchRelativeValuationLedger[];
};
export type RelativeValuationLedgerWriteResult = { state: "saved" | "unavailable"; recordId: string; reason: "storage_not_initialized" | null };

/** Writes one complete immutable record. No quote, forecast or peer data is fetched here. */
export async function createResearchRelativeValuationLedger(
  db: D1Database,
  input: BuildRelativeValuationLedgerInput,
): Promise<RelativeValuationLedgerWriteResult> {
  const ledger = buildRelativeValuationLedger(input);
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_relative_valuation_ledgers (
    relative_valuation_ledger_id, company_id, security_code, as_of, status, valuation_role, valuation_archetype, method,
    peer_universe_id, valuation_currency, security_currency, applicability_rationale, rationale_source_refs_json,
    supersedes_ledger_id, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ledger.ledgerId, ledger.companyId, ledger.securityCode, ledger.asOf, ledger.status, ledger.role, ledger.archetype,
      ledger.method, ledger.peerUniverseId, ledger.valuationCurrency, ledger.securityCurrency, ledger.applicabilityRationale,
      JSON.stringify(ledger.rationaleSourceReferences), ledger.supersedesLedgerId, ledger.createdAt)];
  for (const item of ledger.inputs) statements.push(db.prepare(`insert into research_relative_valuation_inputs (
    relative_valuation_input_id, relative_valuation_ledger_id, subject_kind, peer_member_id, peer_member_key, input_kind, input_key, label,
    value, unit, currency, amount_scale, fiscal_year, period_label, input_as_of, epistemic_type, source_refs_json
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(item.inputId, ledger.ledgerId, item.subjectKind, item.peerMemberId, item.peerMemberId ?? "", item.inputKind, item.key, item.label, item.value,
      item.unit, item.currency, item.amountScale, item.fiscalYear, item.periodLabel, item.asOf, item.epistemicType, JSON.stringify(item.sourceReferences)));
  for (const metric of ledger.metrics) statements.push(db.prepare(`insert into research_relative_valuation_metrics (
    relative_valuation_metric_id, relative_valuation_ledger_id, subject_kind, peer_member_id, metric_type, period_basis,
    fiscal_year, definition, numerator_input_id, denominator_input_id, display_unit
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(metric.metricId, ledger.ledgerId, metric.subjectKind, metric.peerMemberId, metric.metricType, metric.periodBasis,
      metric.fiscalYear, metric.definition, metric.numeratorInputId, metric.denominatorInputId, metric.displayUnit));
  for (const gate of ledger.comparabilityGates) statements.push(db.prepare(`insert into research_relative_valuation_comparability_gates (
    relative_valuation_gate_id, relative_valuation_ledger_id, gate_kind, status, rationale, source_refs_json
  ) values (?, ?, ?, ?, ?, ?)`)
    .bind(gate.gateId, ledger.ledgerId, gate.gateKind, gate.status, gate.rationale, JSON.stringify(gate.sourceReferences)));
  try {
    await db.batch(statements);
    return { state: "saved", recordId: ledger.ledgerId, reason: null };
  } catch (error) {
    if (missingTable(error)) return { state: "unavailable", recordId: ledger.ledgerId, reason: "storage_not_initialized" };
    throw error;
  }
}

/** Loads records as frozen input/metric/gate trees and revalidates each one. */
export async function loadResearchRelativeValuationLedgers(
  db: D1Database,
  query: { securityCode: string; asOf: number },
): Promise<RelativeValuationLedgerSection> {
  const securityCode = required(query.securityCode, "securityCode");
  if (!Number.isInteger(query.asOf) || query.asOf <= 0) throw new Error("relative valuation asOf must be a positive integer");
  try {
    const rows = await db.prepare(`select * from research_relative_valuation_ledgers
      where security_code=? and as_of<=? order by as_of desc, created_at desc, relative_valuation_ledger_id`)
      .bind(securityCode, query.asOf).all<Row>();
    if (!rows.results.length) return { availability: "empty", reason: "no_records", items: [] };
    const ledgerIds = rows.results.map((row) => required(row.relative_valuation_ledger_id, "relative_valuation_ledger_id"));
    const [inputRows, metricRows, gateRows] = await Promise.all([
      rowsFor(db, "research_relative_valuation_inputs", "relative_valuation_ledger_id", ledgerIds, "input_key"),
      rowsFor(db, "research_relative_valuation_metrics", "relative_valuation_ledger_id", ledgerIds, "relative_valuation_metric_id"),
      rowsFor(db, "research_relative_valuation_comparability_gates", "relative_valuation_ledger_id", ledgerIds, "gate_kind"),
    ]);
    const inputsByLedger = group(inputRows, "relative_valuation_ledger_id", mapInput);
    const metricsByLedger = group(metricRows, "relative_valuation_ledger_id", mapMetric);
    const gatesByLedger = group(gateRows, "relative_valuation_ledger_id", mapGate);
    const items = rows.results.map((row) => buildRelativeValuationLedger({
      ledgerId: required(row.relative_valuation_ledger_id, "relative_valuation_ledger_id"), companyId: nullable(row.company_id), securityCode: required(row.security_code, "security_code"),
      asOf: number(row.as_of, "as_of"), status: required(row.status, "status") as "draft" | "reviewed", role: required(row.valuation_role, "valuation_role") as "primary" | "auxiliary",
      archetype: required(row.valuation_archetype, "valuation_archetype") as BuildRelativeValuationLedgerInput["archetype"], method: required(row.method, "method") as BuildRelativeValuationLedgerInput["method"],
      peerUniverseId: required(row.peer_universe_id, "peer_universe_id"), valuationCurrency: required(row.valuation_currency, "valuation_currency"), securityCurrency: required(row.security_currency, "security_currency"),
      applicabilityRationale: required(row.applicability_rationale, "applicability_rationale"), rationaleSourceReferences: references(row.rationale_source_refs_json, "rationale_source_refs_json"), supersedesLedgerId: nullable(row.supersedes_ledger_id),
      inputs: inputsByLedger.get(required(row.relative_valuation_ledger_id, "relative_valuation_ledger_id")) ?? [], metrics: metricsByLedger.get(required(row.relative_valuation_ledger_id, "relative_valuation_ledger_id")) ?? [],
      comparabilityGates: gatesByLedger.get(required(row.relative_valuation_ledger_id, "relative_valuation_ledger_id")) ?? [], createdAt: number(row.created_at, "created_at"),
    }));
    return { availability: "available", reason: null, items };
  } catch (error) {
    if (missingTable(error)) return { availability: "unavailable", reason: "storage_not_initialized", items: [] };
    throw error;
  }
}

function mapInput(row: Row): RelativeValuationInput {
  return {
    inputId: required(row.relative_valuation_input_id, "relative_valuation_input_id"), subjectKind: required(row.subject_kind, "subject_kind") as RelativeValuationInput["subjectKind"], peerMemberId: nullable(row.peer_member_id),
    inputKind: required(row.input_kind, "input_kind") as RelativeValuationInput["inputKind"], key: required(row.input_key, "input_key"), label: required(row.label, "label"), value: number(row.value, "value"),
    unit: required(row.unit, "unit"), currency: nullable(row.currency), amountScale: nullable(row.amount_scale), fiscalYear: nullableInteger(row.fiscal_year, "fiscal_year"), periodLabel: nullable(row.period_label), asOf: number(row.input_as_of, "input_as_of"),
    epistemicType: required(row.epistemic_type, "epistemic_type") as RelativeValuationInput["epistemicType"], sourceReferences: references(row.source_refs_json, "source_refs_json"),
  };
}
function mapMetric(row: Row): Omit<RelativeValuationMetric, "value"> {
  return {
    metricId: required(row.relative_valuation_metric_id, "relative_valuation_metric_id"), subjectKind: required(row.subject_kind, "subject_kind") as RelativeValuationMetric["subjectKind"], peerMemberId: nullable(row.peer_member_id),
    metricType: required(row.metric_type, "metric_type") as RelativeValuationMetric["metricType"], periodBasis: required(row.period_basis, "period_basis") as RelativeValuationMetric["periodBasis"], fiscalYear: nullableInteger(row.fiscal_year, "fiscal_year"),
    definition: required(row.definition, "definition"), numeratorInputId: required(row.numerator_input_id, "numerator_input_id"), denominatorInputId: required(row.denominator_input_id, "denominator_input_id"), displayUnit: required(row.display_unit, "display_unit"),
  };
}
function mapGate(row: Row): RelativeValuationComparabilityGate {
  return { gateId: required(row.relative_valuation_gate_id, "relative_valuation_gate_id"), gateKind: required(row.gate_kind, "gate_kind") as RelativeValuationComparabilityGate["gateKind"], status: required(row.status, "status") as RelativeValuationComparabilityGate["status"], rationale: required(row.rationale, "rationale"), sourceReferences: references(row.source_refs_json, "source_refs_json") };
}
async function rowsFor(db: D1Database, table: string, column: string, values: string[], orderBy: string): Promise<Row[]> {
  const placeholders = values.map(() => "?").join(", ");
  const rows = await db.prepare(`select * from ${table} where ${column} in (${placeholders}) order by ${column}, ${orderBy}`).bind(...values).all<Row>();
  return rows.results;
}
function group<T>(rows: Row[], field: string, mapper: (row: Row) => T): Map<string, T[]> { const result = new Map<string, T[]>(); for (const row of rows) { const key = required(row[field], field); const items = result.get(key) ?? []; items.push(mapper(row)); result.set(key, items); } return result; }
function references(value: unknown, label: string): ResearchSourceReference[] { try { const parsed = typeof value === "string" ? JSON.parse(value) : value; if (!Array.isArray(parsed)) throw new Error(); return parsed as ResearchSourceReference[]; } catch { throw new Error(`relative valuation ${label} must be valid JSON source references`); } }
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`relative valuation ${label} is required`); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown, label: string): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`relative valuation ${label} must be finite`); return result; }
function nullableInteger(value: unknown, label: string): number | null { if (value === null || value === undefined) return null; const result = number(value, label); if (!Number.isInteger(result)) throw new Error(`relative valuation ${label} must be an integer`); return result; }
function missingTable(error: unknown): boolean { return /no such table|does not exist|not found/i.test(error instanceof Error ? error.message : String(error)); }
