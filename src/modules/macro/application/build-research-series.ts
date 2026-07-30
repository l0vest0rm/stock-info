import type { MacroObservationVintage } from "../domain/model";
import { transformSeries, type NullableDatedValue, type SeriesTransform } from "../domain/transforms";

/**
 * Converts a repository snapshot into a research series. Callers are expected to
 * request observations with an asOf cutoff when doing historical research, which
 * prevents revised values published later from leaking into a backtest.
 */
export function buildResearchSeries(
  observations: readonly MacroObservationVintage[],
  transform: SeriesTransform,
  options: { window?: number } = {}
): NullableDatedValue[] {
  return transformSeries(observations
    .filter((item) => item.qualityStatus === "valid")
    .map((item) => ({ date: item.observationDate, value: item.value })), transform, options);
}
