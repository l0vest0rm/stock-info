import { normalizeSecurityCode } from "../../../shared/codes";
import { type CompanyOverview } from "../../../types";
import { type CompanyReportForecast } from "./report-types";
import { positiveNumberOrUndefined, round2, text, numberOrUndefined } from "./report-values";

export function calculateCurrentForecastPe(
  forecast: CompanyReportForecast,
  overview: Pick<CompanyOverview, "marketCapYi" | "latestPrice">,
): number | undefined {
  const netProfit = positiveNumberOrUndefined(forecast.netProfit);
  const marketCapYi = positiveNumberOrUndefined(overview.marketCapYi);
  if (netProfit !== undefined && marketCapYi !== undefined) {
    return round2(marketCapYi / netProfit);
  }
  const eps = positiveNumberOrUndefined(forecast.eps);
  const latestPrice = positiveNumberOrUndefined(overview.latestPrice);
  return eps !== undefined && latestPrice !== undefined ? round2(latestPrice / eps) : undefined;
}

export function calculateCurrentForecastNetProfit(
  forecast: CompanyReportForecast,
  overview: Pick<CompanyOverview, "marketCapYi" | "latestPrice">,
): number | undefined {
  const eps = positiveNumberOrUndefined(forecast.eps);
  const marketCapYi = positiveNumberOrUndefined(overview.marketCapYi);
  const latestPrice = positiveNumberOrUndefined(overview.latestPrice);
  if (eps === undefined || marketCapYi === undefined || latestPrice === undefined) {
    return undefined;
  }
  return round2((marketCapYi / latestPrice) * eps);
}

export function applyCurrentPeToReportItems(
  items: Array<Record<string, unknown>>,
  overview: CompanyOverview | null,
  actualAnnualProfitByYear = new Map<number, number>(),
): Array<Record<string, unknown>> {
  if (!overview) {
    return items;
  }
  return items.map((item) => {
    const computedPeByYear = Object.fromEntries(
      [...actualAnnualProfitByYear].flatMap(([year, netProfit]) => {
        const computedPe = calculateCurrentForecastPe({ year, netProfit }, overview);
        return computedPe === undefined ? [] : [[year, computedPe]];
      }),
    );
    if (!Array.isArray(item.forecasts)) {
      return Object.keys(computedPeByYear).length > 0
        ? { ...item, computedPeByYear, computedPeAsOf: overview.updatedAt }
        : item;
    }
    const forecasts = item.forecasts as CompanyReportForecast[];
    const withCurrentPe = forecasts.map((forecast) => {
      const computedPe = calculateCurrentForecastPe(forecast, overview);
      const computedNetProfit = forecast.netProfit === undefined
        ? calculateCurrentForecastNetProfit(forecast, overview)
        : undefined;
      if (computedPe === undefined && computedNetProfit === undefined) {
        return forecast;
      }
      return {
        ...forecast,
        ...(computedPe !== undefined ? { computedPe, computedPeAsOf: overview.updatedAt } : {}),
        ...(computedNetProfit !== undefined ? { computedNetProfit, computedNetProfitAsOf: overview.updatedAt } : {}),
      };
    });
    return {
      ...item,
      forecasts: withCurrentPe,
      ...(Object.keys(computedPeByYear).length > 0 ? { computedPeByYear, computedPeAsOf: overview.updatedAt } : {}),
    };
  });
}

export function aggregateForecastsForCode(
  code: string,
  items: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const normalized = normalizeSecurityCode(code);
  const grouped = new Map<number, Record<"revenue" | "revenueGrowth" | "netProfit" | "profitGrowth", number[]>>();
  for (const item of items) {
    if (normalizeSecurityCode(text(item.code)) !== normalized) {
      continue;
    }
    const forecasts = Array.isArray(item.forecasts) ? item.forecasts as Array<Record<string, unknown>> : [];
    for (const forecast of forecasts) {
      const year = Number(forecast.year);
      if (!Number.isInteger(year)) {
        continue;
      }
      if (!grouped.has(year)) {
        grouped.set(year, {
          revenue: [],
          revenueGrowth: [],
          netProfit: [],
          profitGrowth: [],
        });
      }
      const values = grouped.get(year)!;
      for (const field of ["revenue", "revenueGrowth", "netProfit", "profitGrowth"] as const) {
        const value = numberOrUndefined(forecast[field]);
        const requiresPositiveValue = field === "revenue" || field === "netProfit";
        if (value !== undefined && (!requiresPositiveValue || value > 0)) {
          values[field].push(value);
        }
      }
    }
  }
  return [...grouped.entries()]
    .map(([year, values]) => ({
      year,
      ...Object.fromEntries(
        Object.entries(values)
          .filter(([, fieldValues]) => fieldValues.length > 0)
          .map(([field, fieldValues]) => [
            field,
            round2(fieldValues.reduce((sum, value) => sum + value, 0) / fieldValues.length),
          ])
      ),
    }))
    .filter((forecast) => Object.keys(forecast).length > 1)
    .sort((left, right) => Number(left.year) - Number(right.year));
}
