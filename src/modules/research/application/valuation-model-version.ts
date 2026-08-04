import { buildDcfValuationModelVersion, type BuildDcfValuationModelInput, type ResearchDcfValuationModelVersion } from "../domain/valuation-model-version";

type Row = Record<string, unknown>;

export async function createDcfValuationModelVersion(db: D1Database, input: BuildDcfValuationModelInput): Promise<ResearchDcfValuationModelVersion> {
  const model = buildDcfValuationModelVersion(input);
  await db.prepare(`insert into research_valuation_model_versions (
    model_version_id, company_id, security_code, as_of, status, model_kind, algorithm_version, valuation_currency, amount_scale,
    security_currency, fx_rate_to_security, fx_as_of, fx_source_refs_json, underlying_shares_per_security, model_inputs_json,
    operating_forecasts_json, outputs_json, sensitivity_json, source_refs_json, created_at
  ) values (?, ?, ?, ?, ?, 'dcf', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(model.modelVersionId, model.companyId, model.securityCode, model.asOf, model.status, "research-dcf.v1", model.valuationCurrency,
      model.amountScale, model.securityCurrency, model.fxRateToSecurity, model.fxAsOf, JSON.stringify(model.fxSourceReferences),
      model.underlyingSharesPerSecurity, JSON.stringify(model.inputs), JSON.stringify(model.operatingForecasts),
      JSON.stringify({ result: model.result, perSecurityValue: model.perSecurityValue }), JSON.stringify(model.sensitivity),
      JSON.stringify(model.sourceReferences), model.createdAt).run();
  return model;
}

export async function loadDcfValuationModelVersions(db: D1Database, securityCode: string, asOf: number): Promise<{ availability: "available" | "empty" | "unavailable"; reason: string | null; items: ResearchDcfValuationModelVersion[] }> {
  try {
    const rows = await db.prepare(`select * from research_valuation_model_versions where security_code=? and as_of<=? and status<>'superseded' order by as_of desc, created_at desc`).bind(securityCode, asOf).all<Row>();
    return { availability: rows.results.length ? "available" : "empty", reason: rows.results.length ? null : "no_records", items: rows.results.map(map) };
  } catch (error) {
    if (/no such table|does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) return { availability: "unavailable", reason: "storage_not_initialized", items: [] };
    throw error;
  }
}

function map(row: Row): ResearchDcfValuationModelVersion {
  const output = json(row.outputs_json) as { result: ResearchDcfValuationModelVersion["result"]; perSecurityValue: number };
  return {
    modelVersionId: string(row.model_version_id), companyId: nullable(row.company_id), securityCode: string(row.security_code), asOf: number(row.as_of), status: string(row.status) as ResearchDcfValuationModelVersion["status"],
    valuationCurrency: string(row.valuation_currency), amountScale: string(row.amount_scale), securityCurrency: string(row.security_currency), fxRateToSecurity: nullableNumber(row.fx_rate_to_security), fxAsOf: nullableNumber(row.fx_as_of), fxSourceReferences: json(row.fx_source_refs_json), underlyingSharesPerSecurity: number(row.underlying_shares_per_security), inputs: json(row.model_inputs_json), operatingForecasts: json(row.operating_forecasts_json), result: output.result, perSecurityValue: output.perSecurityValue, sensitivity: json(row.sensitivity_json), sourceReferences: json(row.source_refs_json), createdAt: number(row.created_at),
  } as ResearchDcfValuationModelVersion;
}
function json(value: unknown): any { try { return JSON.parse(String(value)); } catch { throw new Error("stored valuation model JSON is invalid"); } }
function string(value: unknown): string { const result = String(value ?? "").trim(); if (!result) throw new Error("stored valuation model text is missing"); return result; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored valuation model number is invalid"); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
