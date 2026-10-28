/**
 * Report-date window requested from Eastmoney's F10 statement endpoints.
 *
 * Kept in a dependency-free module so the window rule can be unit checked with
 * plain type stripping (the adapter itself pulls in JSON and HTTP helpers).
 *
 * Eight periods guarantee three usable TTM anchors — prior fiscal year, the
 * current period, and the prior-year same period — even when one statement
 * family publishes fewer interim rows than the other, which is exactly what
 * the bank (`BINCOME`) and insurer (`IINCOME`) feeds do.  `*INCOMEQC` was
 * previously fetched with a 5-period window, and 招商银行 / 中国平安 then had no
 * prior-year anchor for the current quarter.
 */
export function genReportDates(years: number, now: Date = new Date()): string[] {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dates: string[] = [];
  for (let i = 0; i < years; i += 1) {
    const current = year - i;
    if (i > 0) {
      dates.push(`${current}-12-31`);
    }
    if (i !== 0 || month > 9) {
      dates.push(`${current}-09-30`);
    }
    if (i !== 0 || month > 6) {
      dates.push(`${current}-06-30`);
    }
    if (i !== 0 || month > 3) {
      dates.push(`${current}-03-31`);
    }
  }
  return dates;
}
