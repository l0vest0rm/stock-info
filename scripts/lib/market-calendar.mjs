/**
 * Shared market-calendar / contract-convention helpers for A-share ETF options.
 *
 * Why this exists: expiry dates, trading-day counts and holidays change every year,
 * and new expiries appear (e.g. a June quarterly). Hardcoding them per script means
 * the analysis silently breaks the moment the board rolls. Everything structurally
 * derivable is derived here instead.
 *
 * Convention notes
 *   - SSE/SZSE ETF options expire on the 4th Wednesday of the expiry month,
 *     postponed to the next trading day if that Wednesday is a holiday.
 *   - Trading days are counted on the real A-share calendar: weekends minus
 *     statutory holidays. The holiday set is data, not logic, and is extendable.
 */

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

/**
 * Statutory A-share market closures (weekday holidays only; weekends are excluded
 * separately). Extend per year as the State Council publishes the next calendar.
 * Keeping this as plain data means adding 2028 requires no logic change.
 */
export const CN_WEEKDAY_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-03", "2025-02-04",
  "2025-04-04", "2025-05-01", "2025-05-02", "2025-05-05", "2025-06-02",
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08",
  // 2026
  "2026-01-01", "2026-01-02",
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
  "2026-04-06",
  "2026-05-01", "2026-05-04", "2026-05-05",
  "2026-06-19",
  "2026-09-25",
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
  // 2027 (provisional — update when the official calendar is published)
  "2027-01-01",
  "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12",
  "2027-04-05",
  "2027-05-03", "2027-05-04", "2027-05-05",
  "2027-06-09",
  "2027-09-15",
  "2027-10-01", "2027-10-04", "2027-10-05", "2027-10-06", "2027-10-07",
]);

export function isTradingDay(isoDate) {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !CN_WEEKDAY_HOLIDAYS.has(isoDate);
}

/**
 * Trading days in (fromIso, toIso]. Half-open on the start so a position entered at
 * the close of `fromIso` counts only the sessions it actually holds through.
 */
export function tradingDaysBetween(fromIso, toIso) {
  const start = Date.parse(`${fromIso}T00:00:00Z`);
  const end = Date.parse(`${toIso}T00:00:00Z`);
  if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) return 0;
  let count = 0;
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    if (isTradingDay(new Date(t).toISOString().slice(0, 10))) count += 1;
  }
  return count;
}

export function calendarDaysBetween(fromIso, toIso) {
  const start = Date.parse(`${fromIso}T00:00:00Z`);
  const end = Date.parse(`${toIso}T00:00:00Z`);
  if (!(Number.isFinite(start) && Number.isFinite(end))) return null;
  return Math.round((end - start) / 86_400_000);
}

export function addTradingDays(fromIso, n) {
  let iso = fromIso;
  let remaining = n;
  while (remaining > 0) {
    const next = new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    iso = next;
    if (isTradingDay(iso)) remaining -= 1;
  }
  return iso;
}

// ---------------------------------------------------------------------------
// Expiry derivation
// ---------------------------------------------------------------------------

/** The 4th Wednesday of a month, as an ISO date. */
export function fourthWednesday(year, month) {
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) break;
    if (d.getUTCDay() !== 3) continue;
    count += 1;
    if (count === 4) return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Roll a holiday-postponed expiry forward to the next trading day.
 * The exchange postpones when the 4th Wednesday is a statutory holiday.
 */
export function adjustForHoliday(isoDate) {
  let iso = isoDate;
  for (let i = 0; i < 10; i += 1) {
    if (isTradingDay(iso)) return iso;
    iso = new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return iso;
}

/**
 * Resolve a contract's expiry from an Eastmoney-style contract name (e.g.
 * "科创50购12月1550", "500ETF购12月7367A") plus the trade date.
 *
 * The month label alone is ambiguous across a year boundary, so the vendor's own
 * day-to-expiry count (f162) is used to disambiguate this year vs next year. When
 * no vendor count is available it falls back to the nearest future occurrence.
 */
export function expiryFromContractName(name, asOfIso, vendorDaysToExpiry) {
  const m = /(\d{1,2})月/.exec(name ?? "");
  if (!m) return null;
  const month = Number(m[1]);
  if (!(month >= 1 && month <= 12)) return null;
  const asOfYear = Number(asOfIso.slice(0, 4));
  const asOfMonth = Number(asOfIso.slice(5, 7));

  // A month label can only mean "this month or a later month of the listed ladder",
  // i.e. within roughly the next 12 months. Generating both offsets and then
  // disambiguating by the vendor count is the only reliable way, because a January
  // contract seen in December belongs to next year while a June contract seen in
  // October belongs to this year.
  const candidates = [];
  for (const yearOffset of [0, 1]) {
    const year = asOfYear + yearOffset;
    const raw = fourthWednesday(year, month);
    if (!raw) continue;
    const expiry = adjustForHoliday(raw);
    const days = calendarDaysBetween(asOfIso, expiry);
    if (days === null || days <= 0) continue;
    candidates.push({ expiry, days, monthOffset: (year - asOfYear) * 12 + (month - asOfMonth) });
  }
  if (candidates.length === 0) return null;

  if (typeof vendorDaysToExpiry === "number" && vendorDaysToExpiry > 0) {
    return candidates.reduce((best, c) =>
      Math.abs(c.days - vendorDaysToExpiry) < Math.abs(best.days - vendorDaysToExpiry) ? c : best
    ).expiry;
  }

  // Without a vendor count, prefer the earliest candidate still clearly in the future
  // but no more than ~12 months out (the listed ladder never exceeds four expiries).
  // If that yields nothing, the contract name most likely refers to an already-expired
  // month, so return null instead of silently rolling the year forward.
  const plausible = candidates.filter((c) => c.monthOffset <= 12);
  if (plausible.length === 0) return null;
  return plausible[0].expiry;
}

// ---------------------------------------------------------------------------
// Contract conventions
// ---------------------------------------------------------------------------

/** SSE/SZSE ETF option standard contract unit (shares per contract). */
export const CONTRACT_UNIT = 10_000;

/** Minimum tick for ETF option premiums. */
export const MIN_TICK = 0.0001;

/**
 * Exchange minimum margin for a SHORT CALL obligation (per contract, in yuan),
 * per the SSE contract terms:
 *   (settlement + max(12% * underlying - OTM amount, 7% * underlying)) * unit
 */
export function shortCallMarginPerContract(spot, strike, premium) {
  const otm = Math.max(0, strike - spot);
  return (premium + Math.max(0.12 * spot - otm, 0.07 * spot)) * CONTRACT_UNIT;
}

/**
 * Exchange minimum margin for a SHORT PUT obligation (per contract, in yuan):
 *   min(settlement + max(12% * underlying - OTM amount, 7% * strike), strike) * unit
 */
export function shortPutMarginPerContract(spot, strike, premium) {
  const otm = Math.max(0, spot - strike);
  return Math.min(premium + Math.max(0.12 * spot - otm, 0.07 * strike), strike) * CONTRACT_UNIT;
}

/**
 * Calendar-spread margin is the larger of the two leg requirements in practice, but
 * a conservative approximation for research is the long leg's requirement.
 * Documented here so the number is traceable rather than a magic constant.
 */
export function calendarSpreadMarginPerContract(spot, strikes, premiums) {
  return Math.max(...strikes.map((k, i) => shortCallMarginPerContract(spot, k, premiums[i])));
}

// ---------------------------------------------------------------------------
// Board selection
// ---------------------------------------------------------------------------

/**
 * Turn whatever expiries the live board offers into a stabilized comparison set.
 *
 * Rules (structural, not hardcoded dates):
 *   - Always include the nearest expiry that is at least `minDays` out (front week is
 *     gamma-dominated and its vol is not representative).
 *   - Add up to `count` additional expiries, preferring quarterly months (Mar/Jun/
 *     Sep/Dec) because those are the liquid, widely-quoted tenors.
 *   - Never assume a fixed list: a new June quarterly simply becomes eligible.
 */
export function selectComparisonExpiries(allExpiries, asOfIso, { minDays = 15, count = 3 } = {}) {
  const withDays = [...new Set(allExpiries)]
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .map((expiry) => ({
      expiry,
      calendarDays: calendarDaysBetween(asOfIso, expiry),
      tradingDays: tradingDaysBetween(asOfIso, expiry),
      month: Number(expiry.slice(5, 7)),
      isQuarterly: [3, 6, 9, 12].includes(Number(expiry.slice(5, 7))),
    }))
    .filter((e) => e.calendarDays !== null && e.calendarDays > 0)
    .sort((a, b) => a.calendarDays - b.calendarDays);

  if (withDays.length === 0) return [];
  const firstIdx = withDays.findIndex((e) => e.calendarDays >= minDays);
  const startIdx = firstIdx >= 0 ? firstIdx : 0;
  const pool = withDays.slice(startIdx);

  // Pick the nearest usable expiry, then the quarterlies in increasing distance so a
  // newly listed June/September quarterly is picked up automatically instead of being
  // crowded out by nearer non-quarterly months.
  const picked = [];
  if (pool[0]) picked.push(pool[0]);
  for (const e of pool) {
    if (picked.length >= count) break;
    if (!e.isQuarterly) continue;
    if (picked.some((p) => p.expiry === e.expiry)) continue;
    picked.push(e);
  }
  // Fill any remaining slots with the closest expiries.
  for (const e of pool) {
    if (picked.length >= count) break;
    if (picked.some((p) => p.expiry === e.expiry)) continue;
    picked.push(e);
  }
  return picked.sort((a, b) => a.calendarDays - b.calendarDays);
}

/** Short human label for an expiry, derived from the date (never hardcoded). */
export function expiryLabel(expiry) {
  return `${Number(expiry.slice(5, 7))}月`;
}

/**
 * Pick replay horizons (in trading days) from the selected expiries, so the
 * historical backtest always matches the tenors actually available on the board.
 */
export function horizonsFromExpiries(expiries, maxHorizons = 3) {
  const seen = new Set();
  const out = [];
  for (const e of expiries) {
    const td = e.tradingDays;
    if (!(td > 0)) continue;
    if (seen.has(td)) continue;
    seen.add(td);
    const months = Math.max(1, Math.round(td / 21));
    out.push({ tradingDays: td, label: `${months}个月(${td}交易日)`, expiry: e.expiry });
    if (out.length >= maxHorizons) break;
  }
  return out;
}
