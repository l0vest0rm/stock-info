/** Ordinary-share PB excludes other equity instruments, not equity investments.
 * Prefer the aggregate: preferred/perpetual components must never be deducted
 * again. Explicitly missing adjustments fail closed; absent adjustment fields
 * retain the no-disclosed-instruments convention for other provider schemas.
 */
export function commonEquity(payload: Record<string, unknown>): { value: number; sourceFields: string[] } | null {
  const read = (fields: string[]) => {
    for (const field of fields) {
      const value = payload[field];
      if (typeof value === 'number' && Number.isFinite(value)) return { value, sourceFields: [field] };
    }
    return null;
  };
  const parent = read(['TOTAL_PARENT_EQUITY', 'totalParentEquity']);
  if (!parent) return null; // Consolidated equity includes minority interests.
  const aggregateFields = ['OTHER_EQUITY_TOOL', 'otherEquityTool'];
  const componentFields = ['PREFERRED_SHARES', 'PERPETUAL_BOND', 'OTHER_EQUITY_OTHER'];
  let adjustment = read(aggregateFields);
  if (!adjustment) {
    const preferred = read(['PREFERRED_SHARES']);
    const perpetual = read(['PERPETUAL_BOND']);
    const other = read(['OTHER_EQUITY_OTHER']);
    if (preferred && perpetual && (!('OTHER_EQUITY_OTHER' in payload) || other)) {
      if ([preferred, perpetual, other].some((v) => v && v.value < 0)) return null;
      adjustment = { value: preferred.value + perpetual.value + (other?.value ?? 0), sourceFields: [...preferred.sourceFields, ...perpetual.sourceFields, ...(other?.sourceFields ?? [])] };
    } else if ([...aggregateFields, ...componentFields].some((key) => key in payload)) {
      return null;
    } else {
      adjustment = { value: 0, sourceFields: [] };
    }
  }
  const value = parent.value - adjustment.value;
  if (adjustment.value < 0 || !Number.isFinite(value) || value <= 0) return null;
  return { value, sourceFields: [...parent.sourceFields, ...adjustment.sourceFields] };
}
