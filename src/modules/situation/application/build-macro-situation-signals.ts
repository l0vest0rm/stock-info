import marketExposureConfig from "../../macro/config/market-exposures.json";
import industryExposureConfig from "../../macro/config/industry-exposures.json";
import { buildResearchSeries } from "../../macro/application/build-research-series";
import { D1MacroRepository } from "../../macro/application/macro-repository";
import { calculateMarketFactorContributions, type MarketFactorResult } from "../../macro/domain/research";
import type { MacroSeries } from "../../macro/domain/model";

type Quality = "fresh" | "stale" | "missing";
type MarketExposure = { seriesId: string; factor: string; markets: Record<string, number> };
type IndustryExposure = { id: string; market: string; name: string; series: Record<string, number> };
type SeriesSignal = { signal: number | null; quality: Quality; freshnessWeight: number; latestDate: string | null; ageDays: number | null; reason: string };

export type MacroSituationSignal = {
  subjectType: "market" | "industry";
  subjectId: string;
  name: string;
  state: "supportive" | "pressure" | "mixed" | "data_insufficient";
  score: number | null;
  confidence: number;
  input: Record<string, unknown>;
  explanation: Record<string, unknown>;
};

const marketNames: Record<string, string> = { us: "美股", cn: "A股", hk: "港股", kr: "韩国" };
const marketExposures = marketExposureConfig as MarketExposure[];
const industryExposures = industryExposureConfig as unknown as IndustryExposure[];

/**
 * Derives context-only signals from the existing macro vintage store. The
 * caller supplies `asOf`, so a delayed run cannot read macro revisions that
 * were unavailable at that historical instant.
 */
export async function buildMacroSituationSignals(repository: D1MacroRepository, asOf: number): Promise<MacroSituationSignal[]> {
  const catalog = new Map((await repository.listSeries()).map((item) => [item.seriesId, item]));
  if (!catalog.size) return [];
  const required = [...new Set([...marketExposures.map((item) => item.seriesId), ...industryExposures.flatMap((item) => Object.keys(item.series))])];
  const signals = new Map<string, SeriesSignal>();
  for (const seriesId of required) {
    const definition = catalog.get(seriesId);
    if (!definition) continue;
    const observations = await repository.getObservationSeries(seriesId, { from: dateDaysAgo(asOf, 3650), asOf });
    const series = buildResearchSeries(observations, "zscore", { window: 60 });
    const latest = [...series].reverse().find((item) => item.value !== null)?.value ?? null;
    signals.set(seriesId, assessSignalQuality(definition, observations, latest, asOf));
  }
  const marketSignals = calculateMarketFactorContributions(marketExposures.flatMap((exposure) => {
    const signal = signals.get(exposure.seriesId) ?? missingSignal("series_not_configured");
    return Object.entries(exposure.markets).map(([market, weight]) => ({ market, factor: `${exposure.factor}/${exposure.seriesId}`, seriesId: exposure.seriesId, weight, ...signal }));
  })).map((item) => marketResult(item));
  const industrySignals = industryExposures.map((definition) => industryResult(definition, signals));
  return [...marketSignals, ...industrySignals];
}

function marketResult(result: MarketFactorResult): MacroSituationSignal {
  return {
    subjectType: "market", subjectId: result.market, name: marketNames[result.market] ?? result.market,
    state: situationState(result.score, boundedConfidence(result.confidence)), score: result.score, confidence: boundedConfidence(result.confidence),
    input: { contributions: result.contributions },
    explanation: { methodology: "60-observation rolling z-score × configured market exposure; missing inputs contribute zero.", coverage: result.coverage, confidenceLevel: result.confidenceLevel },
  };
}

function industryResult(definition: IndustryExposure, signals: Map<string, SeriesSignal>): MacroSituationSignal {
  const configured = Object.entries(definition.series);
  const contributions = configured.map(([seriesId, weight]) => {
    const signal = signals.get(seriesId) ?? missingSignal("series_not_configured");
    return { seriesId, weight, signal: signal.signal, quality: signal.quality, freshnessWeight: signal.freshnessWeight, contribution: signal.signal === null ? 0 : signal.signal * weight * signal.freshnessWeight };
  }).sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
  const configuredWeight = configured.reduce((sum, [, weight]) => sum + Math.abs(weight), 0);
  const effectiveWeight = contributions.reduce((sum, item) => sum + Math.abs(item.weight) * item.freshnessWeight, 0);
  const confidence = boundedConfidence(configuredWeight ? effectiveWeight / configuredWeight : 0);
  const score = configuredWeight && contributions.some((item) => item.signal !== null)
    ? contributions.reduce((sum, item) => sum + item.contribution, 0) / configuredWeight
    : null;
  return {
    subjectType: "industry", subjectId: definition.id, name: definition.name,
    state: situationState(score, confidence), score, confidence,
    input: { market: definition.market, contributions },
    explanation: { methodology: "latest 60-observation z-score × configured industry exposure; missing inputs contribute zero.", coverage: { configured: configured.length, available: contributions.filter((item) => item.signal !== null).length, configuredWeight, effectiveWeight } },
  };
}

function situationState(score: number | null, confidence: number): MacroSituationSignal["state"] {
  if (score === null || confidence < 0.35) return "data_insufficient";
  if (score >= 0.35) return "supportive";
  if (score <= -0.35) return "pressure";
  return "mixed";
}

function boundedConfidence(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0; }
function missingSignal(reason: string): SeriesSignal { return { signal: null, quality: "missing", freshnessWeight: 0, latestDate: null, ageDays: null, reason }; }
function dateDaysAgo(asOf: number, days: number): string { return new Date(asOf - days * 86_400_000).toISOString().slice(0, 10); }
function assessSignalQuality(definition: MacroSeries, observations: Awaited<ReturnType<D1MacroRepository["getObservationSeries"]>>, signal: number | null, asOf: number): SeriesSignal {
  const latest = [...observations].reverse().find((item) => item.qualityStatus === "valid");
  if (!latest) return missingSignal("missing_valid_observation");
  const ageDays = Math.max(0, Math.floor((asOf - freshnessTimestamp(latest.observationDate, definition.frequency)) / 86_400_000));
  if (signal === null || !Number.isFinite(signal)) return { signal: null, quality: "missing", freshnessWeight: 0, latestDate: latest.observationDate, ageDays, reason: "insufficient_valid_history" };
  const staleAfterDays = definition.staleAfterSeconds / 86_400;
  return ageDays <= staleAfterDays
    ? { signal, quality: "fresh", freshnessWeight: 1, latestDate: latest.observationDate, ageDays, reason: "fresh_observation" }
    : { signal, quality: "stale", freshnessWeight: Math.min(1, staleAfterDays / Math.max(ageDays, 1)), latestDate: latest.observationDate, ageDays, reason: "stale_observation" };
}
function freshnessTimestamp(date: string, frequency: MacroSeries["frequency"]): number {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (frequency === "monthly" || frequency === "quarterly") return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0);
  if (frequency === "annual") return Date.UTC(parsed.getUTCFullYear(), 11, 31);
  return parsed.getTime();
}
