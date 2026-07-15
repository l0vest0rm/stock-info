import { normalizeSecurityCode, securitySuffix } from "./codes";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const OPEN_MARKET_TTL_MS = 10 * MINUTE_MS;
const FINANCE_FALLBACK_TTL_MS = DAY_MS;

type MarketRegion = "cn" | "hk" | "us";

type MarketSession = {
  startMinutes: number;
  endMinutes: number;
};

type MarketSchedule = {
  timeZone: string;
  sessions: MarketSession[];
};

const MARKET_SCHEDULES: Record<MarketRegion, MarketSchedule> = {
  cn: {
    timeZone: "Asia/Shanghai",
    sessions: [
      { startMinutes: 9 * 60 + 30, endMinutes: 11 * 60 + 30 },
      { startMinutes: 13 * 60, endMinutes: 15 * 60 },
    ],
  },
  hk: {
    timeZone: "Asia/Hong_Kong",
    sessions: [
      { startMinutes: 9 * 60 + 30, endMinutes: 12 * 60 },
      { startMinutes: 13 * 60, endMinutes: 16 * 60 },
    ],
  },
  us: {
    timeZone: "America/New_York",
    sessions: [{ startMinutes: 9 * 60 + 30, endMinutes: 16 * 60 }],
  },
};

const zonedPartsFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function marketDataCacheTtlMsForCode(code: string, now = Date.now()): number {
  const region = marketRegionForCode(code);
  return region ? marketDataCacheTtlMsForRegion(region, now) : 6 * HOUR_MS;
}

export function marketDataCacheTtlMsForRegion(region: MarketRegion, now = Date.now()): number {
  const schedule = MARKET_SCHEDULES[region];
  const current = zonedDateParts(new Date(now), schedule.timeZone);
  const minutes = current.hour * 60 + current.minute;
  for (const session of schedule.sessions) {
    if (minutes >= session.startMinutes && minutes < session.endMinutes && isBusinessDay(current.weekday)) {
      return OPEN_MARKET_TTL_MS;
    }
  }
  const nextOpenAt = nextSessionOpenUtcMs(region, now);
  return Math.max(MINUTE_MS, nextOpenAt - now);
}

export function marketDataCacheExpiresAtMsForCode(code: string, now = Date.now()): number {
  return now + marketDataCacheTtlMsForCode(code, now);
}

export function financialStatementsCacheTtlMs(rows: Array<{ reportDate?: string | null }>, now = Date.now()): number {
  if (hasLatestCompletedQuarter(rows, now)) {
    return Math.max(MINUTE_MS, currentQuarterEndUtcMs(now, "Asia/Shanghai") - now);
  }
  return FINANCE_FALLBACK_TTL_MS;
}

export function areFinancialStatementsFresh(
  rows: Array<{ reportDate?: string | null; updatedAt?: number | null }>,
  now = Date.now()
): boolean {
  if (rows.length === 0) {
    return false;
  }
  if (hasLatestCompletedQuarter(rows, now)) {
    return now < currentQuarterEndUtcMs(now, "Asia/Shanghai");
  }
  const updatedAt = Number(rows[0]?.updatedAt ?? 0);
  return updatedAt > 0 && now - updatedAt < FINANCE_FALLBACK_TTL_MS;
}

function hasLatestCompletedQuarter(
  rows: Array<{ reportDate?: string | null }>,
  now = Date.now()
): boolean {
  const latestReportDate = String(rows[0]?.reportDate ?? "").slice(0, 10);
  return latestReportDate === latestCompletedQuarterEndDate(now);
}

export function latestCompletedQuarterEndDate(now = Date.now()): string {
  return previousQuarterEndDate(now, "Asia/Shanghai");
}

function marketRegionForCode(code: string): MarketRegion | null {
  const suffix = securitySuffix(normalizeSecurityCode(code));
  if (suffix === "SH" || suffix === "SZ" || suffix === "BJ" || suffix === "OF") {
    return "cn";
  }
  if (suffix === "HK") {
    return "hk";
  }
  if (suffix === "US") {
    return "us";
  }
  return null;
}

function nextSessionOpenUtcMs(region: MarketRegion, now: number): number {
  const schedule = MARKET_SCHEDULES[region];
  const current = zonedDateParts(new Date(now), schedule.timeZone);
  const currentDateUtc = Date.UTC(current.year, current.month - 1, current.day);
  const currentMinutes = current.hour * 60 + current.minute;
  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const candidateDate = new Date(currentDateUtc + dayOffset * DAY_MS);
    const weekday = candidateDate.getUTCDay();
    if (!isBusinessDay(weekday)) {
      continue;
    }
    for (const session of schedule.sessions) {
      if (dayOffset === 0 && session.startMinutes <= currentMinutes) {
        continue;
      }
      const hours = Math.floor(session.startMinutes / 60);
      const minutes = session.startMinutes % 60;
      return zonedDateTimeToUtcMs(
        schedule.timeZone,
        candidateDate.getUTCFullYear(),
        candidateDate.getUTCMonth() + 1,
        candidateDate.getUTCDate(),
        hours,
        minutes
      );
    }
  }
  return now + DAY_MS;
}

function currentQuarterEndUtcMs(now: number, timeZone: string): number {
  const current = zonedDateParts(new Date(now), timeZone);
  const quarterIndex = Math.floor((current.month - 1) / 3);
  const nextQuarterMonth = quarterIndex * 3 + 4;
  let year = current.year;
  let month = nextQuarterMonth;
  if (month > 12) {
    month -= 12;
    year += 1;
  }
  return zonedDateTimeToUtcMs(timeZone, year, month, 1, 0, 0);
}

function previousQuarterEndDate(now: number, timeZone: string): string {
  const current = zonedDateParts(new Date(now), timeZone);
  const quarterIndex = Math.floor((current.month - 1) / 3);
  if (quarterIndex === 0) {
    return `${current.year - 1}-12-31`;
  }
  const previousQuarterMonth = quarterIndex * 3;
  const lastDay = new Date(Date.UTC(current.year, previousQuarterMonth, 0)).getUTCDate();
  return `${current.year}-${pad2(previousQuarterMonth)}-${pad2(lastDay)}`;
}

function zonedDateTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(guess), timeZone);
    const adjusted = targetUtc - offset;
    if (adjusted === guess) {
      return adjusted;
    }
    guess = adjusted;
  }
  return guess;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedDateParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  return asUtc - date.getTime();
}

function zonedDateParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
} {
  let formatter = zonedPartsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    zonedPartsFormatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year") ?? 0),
    month: Number(values.get("month") ?? 0),
    day: Number(values.get("day") ?? 0),
    weekday: weekdayToNumber(values.get("weekday") ?? ""),
    hour: Number(values.get("hour") ?? 0),
    minute: Number(values.get("minute") ?? 0),
    second: Number(values.get("second") ?? 0),
  };
}

function weekdayToNumber(value: string): number {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return -1;
  }
}

function isBusinessDay(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
