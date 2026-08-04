import { buildReverseDcfValuationModelVersion, type BuildReverseDcfValuationModelInput, type ReverseDcfValuationModelVersion } from "../domain/reverse-valuation-model-version";

type Row = Record<string, unknown>;

export async function createReverseDcfValuationModelVersion(db: D1Database, input: BuildReverseDcfValuationModelInput): Promise<ReverseDcfValuationModelVersion> {
  const model = buildReverseDcfValuationModelVersion(input);
  await db.prepare(`insert into research_reverse_valuation_model_versions (
    model_version_id, company_id, security_code, as_of, status, algorithm_version, valuation_currency, amount_scale, security_currency,
    price_per_security, price_as_of, price_source_refs_json, diluted_underlying_shares, diluted_shares_scale, diluted_shares_source_refs_json,
    underlying_shares_per_security, net_debt_at_valuation, net_debt_source_refs_json, fx_rate_to_valuation, fx_as_of,
    fx_source_refs_json, wacc, terminal_growth, terminal_ufcf_margin, terminal_ebit_margin, assumption_source_refs_json,
    outputs_json, source_refs_json, created_at
  ) values (?, ?, ?, ?, ?, 'research-reverse-dcf.v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(model.modelVersionId, model.companyId, model.securityCode, model.asOf, model.status, model.valuationCurrency, model.amountScale, model.securityCurrency,
      model.pricePerSecurity, model.priceAsOf, JSON.stringify(model.priceSourceReferences), model.dilutedUnderlyingShares, model.dilutedSharesScale, JSON.stringify(model.dilutedSharesSourceReferences),
      model.underlyingSharesPerSecurity, model.netDebtAtValuation, JSON.stringify(model.netDebtSourceReferences), model.fxRateToValuation, model.fxAsOf,
      JSON.stringify(model.fxSourceReferences), model.wacc, model.terminalGrowth, model.terminalFreeCashFlowMargin, model.terminalEbitMargin, JSON.stringify(model.assumptionSourceReferences),
      JSON.stringify(model.result), JSON.stringify(model.sourceReferences), model.createdAt).run();
  return model;
}

export async function loadReverseDcfValuationModelVersions(db: D1Database, securityCode: string, asOf: number): Promise<{ availability: "available" | "empty" | "unavailable"; reason: string | null; items: ReverseDcfValuationModelVersion[] }> {
  try {
    const rows = await db.prepare(`select * from research_reverse_valuation_model_versions where security_code=? and as_of<=? and status<>'superseded' order by as_of desc, created_at desc`).bind(securityCode, asOf).all<Row>();
    return { availability: rows.results.length ? "available" : "empty", reason: rows.results.length ? null : "no_records", items: rows.results.map(map) };
  } catch (error) {
    if (/no such table|does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) return { availability: "unavailable", reason: "storage_not_initialized", items: [] };
    throw error;
  }
}

function map(row: Row): ReverseDcfValuationModelVersion {
  return {
    modelVersionId: text(row.model_version_id), companyId: nullable(row.company_id), securityCode: text(row.security_code), asOf: number(row.as_of), status: text(row.status) as ReverseDcfValuationModelVersion["status"], valuationCurrency: text(row.valuation_currency), amountScale: text(row.amount_scale), securityCurrency: text(row.security_currency), pricePerSecurity: number(row.price_per_security), priceAsOf: number(row.price_as_of), priceSourceReferences: json(row.price_source_refs_json), dilutedUnderlyingShares: number(row.diluted_underlying_shares), dilutedSharesScale: text(row.diluted_shares_scale), dilutedSharesSourceReferences: json(row.diluted_shares_source_refs_json), underlyingSharesPerSecurity: number(row.underlying_shares_per_security), netDebtAtValuation: number(row.net_debt_at_valuation), netDebtSourceReferences: json(row.net_debt_source_refs_json), fxRateToValuation: nullableNumber(row.fx_rate_to_valuation), fxAsOf: nullableNumber(row.fx_as_of), fxSourceReferences: json(row.fx_source_refs_json), wacc: number(row.wacc), terminalGrowth: number(row.terminal_growth), terminalFreeCashFlowMargin: nullableNumber(row.terminal_ufcf_margin), terminalEbitMargin: nullableNumber(row.terminal_ebit_margin), assumptionSourceReferences: json(row.assumption_source_refs_json), result: json(row.outputs_json), sourceReferences: json(row.source_refs_json), createdAt: number(row.created_at),
  } as ReverseDcfValuationModelVersion;
}
function json(value: unknown): any { try { return JSON.parse(String(value)); } catch { throw new Error("stored reverse valuation model JSON is invalid"); } }
function text(value: unknown): string { const result = String(value ?? "").trim(); if (!result) throw new Error("stored reverse valuation model text is missing"); return result; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored reverse valuation model number is invalid"); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
