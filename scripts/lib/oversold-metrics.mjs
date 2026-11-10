// 超跌筛选共用的纯计算：技术指标、估值历史分位、TTM/单季利润。
//
// 这里只放「给定数据怎么算」的函数，不读文件、不联网、不读参数，
// 所以脚本和回归测试可以共用同一份实现，避免两套口径漂移。
//
// 两个关键口径（与 backend/src/finance/series.rs 一致）：
//   1. TTM = 上年报 + 本期累计 − 上年同期累计；最新一期是年报则直接取。
//   2. 单季值优先取东财单季度家族（*INCOMEQC）的原始行；没有该行时，
//      才用「本年累计 − 本年上一份累计」做差。缺上一份就返回 null，不内插。

export const DAY = 86_400_000;

export const closeOf = (row) => (Number.isFinite(row?.close) ? row.close : null);
export const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
export const numeric = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export const pct = (value, digits = 1) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  // 极小的负数（-0.0001）统一显示为 0%，避免「-0.0%」这种噪声
  const shown = Math.abs(value) < 0.5 * 10 ** -digits / 100 ? 0 : value;
  return `${(shown * 100).toFixed(digits)}%`;
};
export const ratio = (value, digits = 1) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—");

export const daysBetween = (from, to) => {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY) : null;
};

export const shiftYear = (date, years) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!match) return null;
  const year = Number(match[1]) + years;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// 技术指标
// ---------------------------------------------------------------------------

/** Wilder RSI（与主流行情软件一致的 warm-up：先简单平均，再递推）。 */
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    ema = ema === null ? value : value * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function macdHistogram(closes) {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const dif = closes.map((_, i) => fast[i] - slow[i]);
  const dea = emaSeries(dif, 9);
  return closes.map((_, i) => 2 * (dif[i] - dea[i]));
}

export const sma = (values, period) => {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
};

/** 简单线性回归斜率，归一化为「每交易日涨跌幅」。 */
export function trendSlope(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const n = slice.length;
  const meanX = (n - 1) / 2;
  const meanY = slice.reduce((sum, value) => sum + value, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (slice[i] - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0 || meanY === 0) return null;
  return num / den / meanY;
}

/** 历史分位：只用正数观测；当前值非正或样本不足 250 时返回 null，而不是 0。 */
export function percentileRank(series, value) {
  const usable = series.filter(positive);
  if (!positive(value) || usable.length < 250) return null;
  const below = usable.filter((item) => item <= value).length;
  return below / usable.length;
}

/** 以最新K线日为终点、向前 years 个自然年的行（含端点）。日期无效时退回全部行。 */
export function windowRows(rows, asOf, years) {
  const start = shiftYear(asOf, -years);
  if (!start) return rows;
  return rows.filter((row) => row.date >= start);
}

/**
 * 单只股票的技术状态。所有指标都以「已有交易日」为口径，
 * 返回 asOf / sessions 让调用方自行核对最后一根K线属于哪个交易日。
 */
export function technicals(rows) {
  const closes = rows.map(closeOf).filter((value) => value !== null);
  const dates = rows.map((row) => row.date);
  if (closes.length < 260) return { available: false, reason: `仅 ${closes.length} 根K线，不足 260 个交易日`, sessions: closes.length };
  const high252 = Math.max(...closes.slice(-252));
  const low252 = Math.min(...closes.slice(-252));
  const last = closes.at(-1);
  const rsi = rsiSeries(closes);
  const macd = macdHistogram(closes);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma250 = sma(closes, 250);
  const lastRsi = rsi.at(-1);
  const minRsi20 = Math.min(...rsi.slice(-20).filter((value) => value !== null));
  const lastMacd = macd.at(-1);
  const priorMacd = macd.at(-2);
  const lastLow = rows.at(-1)?.low ?? null;
  const priorLow5 = Math.min(...rows.slice(-6, -1).map((row) => row.low ?? Infinity));
  const returnOver = (sessions) => (closes.length > sessions ? last / closes.at(-1 - sessions) - 1 : null);

  // 反弹条件分两级：确认信号（需要正面证据）与观察信号（超卖但还没走出来）。
  // 只有确认信号能让标的进入候选，观察信号只降低「追高」的风险。
  const confirm = [];
  const watch = [];
  if (lastRsi !== null && minRsi20 <= 30 && lastRsi >= 30 && lastRsi > (rsi.at(-2) ?? -Infinity)) {
    confirm.push({ key: "rsi-reset", label: `RSI14 从 ${minRsi20.toFixed(1)} 回升至 ${lastRsi.toFixed(1)}（超卖修复）` });
  }
  if (priorMacd !== null && lastMacd !== null && priorMacd < 0 && lastMacd >= 0) {
    confirm.push({ key: "macd-turn", label: "MACD 柱由负转正（动能修复）" });
  }
  if (ma5 !== null && last > ma5 && Number.isFinite(priorLow5) && lastLow !== null && lastLow > priorLow5) {
    confirm.push({ key: "base", label: "站上 5 日线且近 5 日低点抬高（止跌结构）" });
  }
  if (lastRsi !== null && lastRsi < 30) {
    watch.push({ key: "rsi-oversold", label: `RSI14 ${lastRsi.toFixed(1)} 仍处超卖区（等待企稳，不宜一次性满仓）` });
  }
  // 「跌不动」只对仍处于弱势的票生效：20 日跌幅收窄到 -5% 以内、且离 252 日低点不远
  if (returnOver(20) !== null && returnOver(20) > -0.05 && returnOver(20) < 0 && last / low252 - 1 < 0.10) {
    watch.push({ key: "selling-exhaustion", label: "20 日跌幅收敛至 5% 内且距 252 日低点不足 10%（抛压衰竭）" });
  }
  const signals = [...confirm, ...watch];

  return {
    available: true,
    sessions: closes.length,
    asOf: dates.at(-1),
    close: last,
    return20: returnOver(20),
    return60: returnOver(60),
    return120: returnOver(120),
    drawdown252: last / high252 - 1,
    distanceFromLow252: last / low252 - 1,
    rsi14: lastRsi,
    macdHistogram: lastMacd,
    mae5: ma5,
    ma20,
    ma60,
    ma250,
    trend60: trendSlope(closes, 60),
    // 5 年窗口：标签写「5 年分位」就必须真的只用最近 5 个自然年，
    // 否则雪球给的 2000 根K线（约 8 年）会让分位口径前后不一致。
    pe5y: windowRows(rows, dates.at(-1), 5).map((row) => row.peTtm),
    pb5y: windowRows(rows, dates.at(-1), 5).map((row) => row.pb),
    // 最近 4 年截断均值：单日 PE 极值（利润骤降）会主导 5 年历史，均值只作参照
    pe4y: windowRows(rows, dates.at(-1), 4).map((row) => row.peTtm),
    pb4y: windowRows(rows, dates.at(-1), 4).map((row) => row.pb),
    signals,
    confirm,
    watch,
  };
}

// ---------------------------------------------------------------------------
// 财务：TTM 利润、单季同比、2 年复合
// ---------------------------------------------------------------------------

/** 正式财报（排除业绩预告/快报）。 */
export const isFormal = (row) => {
  const label = String(row?.fiscalPeriod ?? row?.payload?.REPORT_TYPE ?? "");
  return !/预告|快报|forecast/i.test(label);
};

export const profitOf = (row) => numeric(row?.payload?.PARENT_NETPROFIT) ?? numeric(row?.payload?.NETPROFIT);
export const revenueOf = (row) => numeric(row?.payload?.TOTAL_OPERATE_INCOME) ?? numeric(row?.payload?.OPERATE_INCOME);

const SINGLE_QUARTER_LABEL = /^(一季度|二季度|三季度|四季度|Q1|Q2|Q3|Q4)$/i;

/**
 * 行为口径：东财同一份利润表会同时给出「累计」家族（三季报/中报/年报）和
 * 「单季度」家族（三季度/二季度）。两者 reportDate 相同，靠排序区分并不可靠，
 * 因此这里按合同/标签显式分类。
 */
export function statementFamily(row) {
  const contract = String(row?.payload?.FINANCIAL_SOURCE_CONTRACT ?? "");
  const label = String(row?.fiscalPeriod ?? row?.payload?.REPORT_TYPE ?? "").trim();
  if (contract.endsWith("incomeqc.v1") || SINGLE_QUARTER_LABEL.test(label)) return "single";
  return "cumulative";
}

const cumulativeRows = (rows) => rows.filter((row) => isFormal(row) && statementFamily(row) === "cumulative");

/**
 * TTM：最新为年报则直接取；否则 上年报 + 本期累计 − 上年同期累计。
 * 只使用累计家族，避免把单季度行当成累计行。
 */
export function ttmValue(rows, pick) {
  const sorted = [...cumulativeRows(rows)]
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.reportDate ?? ""))
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  const latest = sorted[0];
  if (!latest) return null;
  const latestValue = pick(latest);
  if (!Number.isFinite(latestValue)) return null;
  if (latest.reportDate.endsWith("12-31")) return { value: latestValue, reportDate: latest.reportDate, basis: "annual" };
  const annual = sorted
    .filter((row) => row.reportDate.endsWith("12-31") && row.reportDate < latest.reportDate)
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))[0];
  if (!annual) return null;
  const prior = sorted.find((row) => row.reportDate === shiftYear(latest.reportDate, -1))
    ?? sorted.find((row) => row.reportDate === shiftYear(latest.reportDate, -1));
  if (!prior) return null;
  const value = pick(annual) + latestValue - pick(prior);
  if (!Number.isFinite(value)) return null;
  return { value, reportDate: latest.reportDate, basis: "cumulative_roll", annualDate: annual.reportDate, priorDate: prior.reportDate };
}

/**
 * 单季值：优先取单季度家族的原始行；没有时用「本年累计 − 本年上一份累计」做差。
 * 一季度本身就是单季；年报减三季报即 Q4。没有更早的累计行就返回 null，不内插。
 */
export function quarterValue(rows, pick, reportDate) {
  const formal = [...rows].filter((row) => isFormal(row) && /^\d{4}-\d{2}-\d{2}$/.test(row.reportDate ?? ""));
  const direct = formal.find((row) => row.reportDate === reportDate && statementFamily(row) === "single");
  if (direct) {
    const value = pick(direct);
    return Number.isFinite(value) ? { value, reportDate, basis: "single_quarter" } : null;
  }
  const cumulative = formal
    .filter((row) => statementFamily(row) === "cumulative")
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  const current = cumulative.find((row) => row.reportDate === reportDate);
  if (!current) return null;
  const monthDay = reportDate.slice(5);
  const year = reportDate.slice(0, 4);
  const value = pick(current);
  if (!Number.isFinite(value)) return null;
  if (monthDay === "03-31") return { value, reportDate, basis: "cumulative_q1" };
  const expected = { "06-30": "03-31", "09-30": "06-30", "12-31": "09-30" }[monthDay];
  const previous = expected ? cumulative.find((row) => row.reportDate === `${year}-${expected}`) : null;
  if (!previous) return null;
  const priorValue = pick(previous);
  if (!Number.isFinite(priorValue)) return null;
  return { value: value - priorValue, reportDate, previousReportDate: previous.reportDate, basis: "cumulative_diff" };
}

export function latestQuarterDates(rows, limit = 8) {
  const dates = [...new Set(cumulativeRows(rows).map((row) => row.reportDate))]
    .sort()
    .reverse();
  return dates.slice(0, limit);
}

/**
 * 由利润表行得到筛选所需的财务摘要。数据不足时显式返回 available:false。
 */
export function buildFinancialSummary(rows, refDate) {
  if (!Array.isArray(rows) || rows.length === 0) return { available: false, reason: "没有本地利润表快照" };
  const latestFormal = [...cumulativeRows(rows)].sort((left, right) => String(right.reportDate).localeCompare(String(left.reportDate)))[0];
  if (!latestFormal) return { available: false, reason: "利润表缺少正式累计报表" };
  const age = daysBetween(latestFormal.reportDate, refDate);
  const ttmProfit = ttmValue(rows, profitOf);
  const ttmRevenue = ttmValue(rows, revenueOf);
  const yearAgo = ttmProfit ? ttmValue(rows.filter((row) => row.reportDate <= shiftYear(ttmProfit.reportDate, -1)), profitOf) : null;
  const ttmGrowth = ttmProfit && yearAgo && yearAgo.value > 0 ? ttmProfit.value / yearAgo.value - 1 : null;
  const twoYearDate = ttmProfit ? shiftYear(ttmProfit.reportDate, -2) : null;
  const twoYear = twoYearDate ? ttmValue(rows.filter((row) => row.reportDate <= twoYearDate), profitOf) : null;
  const cagr2y = ttmProfit && twoYear && twoYear.value > 0 && ttmProfit.value > 0 ? (ttmProfit.value / twoYear.value) ** 0.5 - 1 : null;

  const quarters = [];
  for (const date of latestQuarterDates(rows).slice(0, 3)) {
    const current = quarterValue(rows, profitOf, date);
    const priorDate = shiftYear(date, -1);
    const prior = priorDate ? quarterValue(rows, profitOf, priorDate) : null;
    const currentRevenue = quarterValue(rows, revenueOf, date);
    const priorRevenue = priorDate ? quarterValue(rows, revenueOf, priorDate) : null;
    quarters.push({
      reportDate: date,
      netProfit: current?.value ?? null,
      netProfitYoY: current && prior && prior.value > 0 ? current.value / prior.value - 1 : null,
      revenue: currentRevenue?.value ?? null,
      revenueYoY: currentRevenue && priorRevenue && priorRevenue.value > 0 ? currentRevenue.value / priorRevenue.value - 1 : null,
    });
  }

  return {
    available: true,
    latestReportDate: latestFormal.reportDate,
    ageDays: age,
    ttmProfit: ttmProfit?.value ?? null,
    ttmRevenue: ttmRevenue?.value ?? null,
    ttmGrowth,
    cagr2y,
    quarters,
  };
}
