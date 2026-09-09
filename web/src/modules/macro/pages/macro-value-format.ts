export type MacroValueDisplayDefinition = {
  regionCode: string;
  unit: string;
  unitFormat: string;
};

export type MacroValueFormatter = {
  unit: string;
  format(value: number): string;
};

type DisplayScale = { divisor: number; unit: string };

/**
 * Formats source values for Chinese readers without changing the raw value or
 * its source unit. Unit matching is deliberately explicit: an unknown source
 * unit remains untouched instead of being inferred from a numeric magnitude.
 */
export function createMacroValueFormatter(definition: MacroValueDisplayDefinition, values: readonly number[] = []): MacroValueFormatter {
  const magnitude = Math.max(0, ...values.map((value) => Math.abs(value)));
  const scale = displayScale(definition.unit, definition.regionCode, magnitude);
  return {
    unit: scale.unit,
    format(value) {
      return `${formatNumber(value / scale.divisor, definition.unitFormat)}${scale.unit ? ` ${scale.unit}` : ""}`;
    },
  };
}

export function formatMacroValue(value: number, definition: MacroValueDisplayDefinition): string {
  return createMacroValueFormatter(definition, [value]).format(value);
}

function displayScale(unit: string, regionCode: string, magnitude: number): DisplayScale {
  const normalized = unit.trim().toLocaleLowerCase();
  if (unit === "十亿本币") return currencyScale(magnitude, localCurrency(regionCode), "");
  if (normalized === "billions of dollars") return currencyScale(magnitude, "美元", "");
  if (normalized === "billions of chained 2017 dollars") return currencyScale(magnitude, "美元", "（2017年不变价）");
  if (normalized === "millions of dollars") return millionDollarScale(magnitude);
  if (normalized === "thousands of persons") return magnitude >= 10 ? { divisor: 10, unit: "万人" } : { divisor: 1, unit: "千人" };
  return { divisor: 1, unit };
}

function currencyScale(magnitude: number, currency: string, qualifier: string): DisplayScale {
  return magnitude >= 1_000
    ? { divisor: 1_000, unit: `万亿${currency}${qualifier}` }
    : { divisor: 0.1, unit: `亿${currency}${qualifier}` };
}

function millionDollarScale(magnitude: number): DisplayScale {
  if (magnitude >= 1_000_000) return { divisor: 1_000_000, unit: "万亿美元" };
  if (magnitude >= 100) return { divisor: 100, unit: "亿美元" };
  return { divisor: 1, unit: "百万美元" };
}

function localCurrency(regionCode: string): string {
  return ({ US: "美元", CN: "元", HK: "港元", JP: "日元", GB: "英镑", EU: "欧元" })[regionCode] ?? "本币";
}

function formatNumber(value: number, unitFormat: string): string {
  const maximumFractionDigits = unitFormat === "integer" || unitFormat === "decimal_0"
    ? 0
    : unitFormat === "percent" || unitFormat === "percentage_point"
      ? 2
      : 3;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(value);
}
