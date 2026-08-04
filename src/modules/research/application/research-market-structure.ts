import { classifyResearchSecurity, type ClassifiedResearchSecurity } from "../domain/research-identity";
import {
  assertMarketStructureFact,
  buildResearchMarketStructure,
  type ResearchMarketStructureFact,
} from "../domain/research-market-structure";

type Row = Record<string, unknown>;
export type MarketStructureFactWrite = Omit<ResearchMarketStructureFact, "createdAt"> & { createdAt?: number };

/** Appends one sourced security-market observation. This never modifies a
 * security-rights profile or writes a valuation input on the caller's behalf. */
export async function insertResearchMarketStructureFact(db: D1Database, input: MarketStructureFactWrite): Promise<ResearchMarketStructureFact> {
  const securityCode = classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" }).code;
  const createdAt = input.createdAt ?? Date.now();
  const fact = { ...input, securityCode, createdAt };
  assertMarketStructureFact(fact);
  await db.prepare(`insert into research_market_structure_facts (
      market_structure_fact_id, security_code, fact_key, fact_status, value_kind, value_number, value_text, unit, measurement_basis,
      as_of, frequency, epistemic_type, source_authority, source_url, source_title, source_note,
      effective_from, effective_to, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(fact.marketStructureFactId, fact.securityCode, fact.factKey, fact.factStatus, fact.valueKind,
      fact.valueNumber, fact.valueText, fact.unit, fact.measurementBasis, fact.asOf, fact.frequency, fact.epistemicType,
      fact.sourceAuthority, fact.sourceUrl, fact.sourceTitle, fact.sourceNote, fact.effectiveFrom,
      fact.effectiveTo, fact.createdAt).run();
  return fact;
}

export async function loadResearchMarketStructure(db: D1Database, security: ClassifiedResearchSecurity | { code: string; market: ClassifiedResearchSecurity["market"]; instrumentKind: ClassifiedResearchSecurity["instrumentKind"] }) {
  try {
    const rows = await db.prepare(`select market_structure_fact_id as marketStructureFactId, security_code as securityCode,
        fact_key as factKey, fact_status as factStatus, value_kind as valueKind, value_number as valueNumber,
        value_text as valueText, unit, measurement_basis as measurementBasis, as_of as asOf, frequency, epistemic_type as epistemicType,
        source_authority as sourceAuthority, source_url as sourceUrl, source_title as sourceTitle,
        source_note as sourceNote, effective_from as effectiveFrom, effective_to as effectiveTo, created_at as createdAt
      from research_market_structure_facts where security_code=? order by as_of desc, created_at desc`)
      .bind(security.code).all<Row>();
    return { availability: "available" as const, ...buildResearchMarketStructure({ market: security.market, instrumentKind: security.instrumentKind, facts: rows.results.map(mapFact) }) };
  } catch (error) {
    if (/no such table|does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) return { availability: "unavailable" as const, reason: "storage_not_initialized", facts: [] as ResearchMarketStructureFact[] };
    throw error;
  }
}

export async function requirePerShareMarketStructure(db: D1Database, security: Pick<ClassifiedResearchSecurity, "code" | "market" | "instrumentKind">): Promise<void> {
  const structure = await loadResearchMarketStructure(db, security);
  if (structure.availability !== "available") throw new Error("per-share valuation is blocked: market structure storage is unavailable");
  if (structure.perShareValuation.status !== "ready") throw new Error(`per-share valuation is blocked: ${structure.perShareValuation.reason}`);
}

function mapFact(row: Row): ResearchMarketStructureFact {
  return {
    marketStructureFactId: text(row.marketStructureFactId), securityCode: text(row.securityCode), factKey: text(row.factKey),
    factStatus: text(row.factStatus) as ResearchMarketStructureFact["factStatus"], valueKind: text(row.valueKind) as ResearchMarketStructureFact["valueKind"],
    valueNumber: numericOrNull(row.valueNumber), valueText: optional(row.valueText), unit: optional(row.unit), measurementBasis: optional(row.measurementBasis) as ResearchMarketStructureFact["measurementBasis"], asOf: text(row.asOf),
    frequency: text(row.frequency) as ResearchMarketStructureFact["frequency"], epistemicType: text(row.epistemicType) as ResearchMarketStructureFact["epistemicType"],
    sourceAuthority: text(row.sourceAuthority) as ResearchMarketStructureFact["sourceAuthority"], sourceUrl: text(row.sourceUrl), sourceTitle: text(row.sourceTitle), sourceNote: text(row.sourceNote),
    effectiveFrom: optional(row.effectiveFrom), effectiveTo: optional(row.effectiveTo), createdAt: number(row.createdAt),
  };
}
function text(value: unknown): string { const result = String(value ?? "").trim(); if (!result) throw new Error("stored market structure text is missing"); return result; }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored market structure number is invalid"); return result; }
function numericOrNull(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
