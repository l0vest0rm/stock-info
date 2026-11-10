// 全 A 股「细分行业龙头超跌 + 估值合理 + 反弹条件」筛选的纯计算部分。
//
// 这里不读文件、不联网，只做「给定数据怎么判定」，因此可以被回归测试直接调用。
// 数据获取（行业快照、雪球K线、东财利润表）在 CLI 脚本里。
//
// 判定分四关，任何一关缺数据都显式标记，不用 0 或默认值冒充：
//   1. 行业龙头：行业内按总市值排名前 N，且行业样本数、市值达到门槛
//   2. 弱势：相对 252 日高点回撤、120 日下跌、RSI14 未过热
//   3. 估值合理：权重指标（PE(TTM)/PB）的自身 5 年历史分位不超过阈值
//   4. 盈利未恶化：TTM 利润同比不低于下限
// 另加一层「反弹条件」：至少一个确认性质的止跌/修复信号才算候选，
// 只有观察信号的一律进「等止跌信号」，不猜底。

import { percentileRank, positive, technicals } from "./oversold-metrics.mjs";

// ---------------------------------------------------------------------------
// 估值分层：按行业名决定用哪个倍数做主口径
// ---------------------------------------------------------------------------

export const DEFAULT_LAYER = {
  key: "pe_primary",
  label: "通用（PE 主、PB 辅）",
  metrics: ["peTtm", "pb"],
  cyclical: false,
};

/**
 * 显式表格，不做模糊猜测：只有确定的行业才换口径，其余走通用。
 * 银行/保险/券商用 PB 主口径，因为利润受拨备、投资收益和权益市场波动影响，
 * PE 分位在周期里会失真。
 */
export const INDUSTRY_LAYERS = [
  { key: "bank", label: "银行（PB 主、PE 辅）", metrics: ["pb", "peTtm"], test: /^银行/ },
  { key: "insurer", label: "保险（PB 主、PE 辅）", metrics: ["pb", "peTtm"], test: /^保险/ },
  { key: "securities", label: "证券（PB 主、PE 辅）", metrics: ["pb", "peTtm"], test: /^(证券|多元金融)/ },
  { key: "cyclical", label: "周期资源（PE 分位仅作参考，需按中枢利润复核）", metrics: ["peTtm", "pb"], cyclical: true, test: /^(煤炭|工业金属|小金属|贵金属|能源金属|钢铁|化学原料|化学制品|农化制品|化学纤维|石油石化|燃气|电力|水泥|玻璃|装修建材|航运港口|航空机场|养殖业)/ },
  { key: "property", label: "房地产（PB 主，PE 参考意义弱）", metrics: ["pb", "peTtm"], test: /^(房地产|房地产开发|房地产服务)/ },
];

export function layerForIndustry(industry) {
  const name = String(industry ?? "").trim();
  const matched = INDUSTRY_LAYERS.find((layer) => layer.test.test(name));
  if (!matched) return DEFAULT_LAYER;
  const { test, ...rest } = matched;
  return rest;
}

// ---------------------------------------------------------------------------
// 行业龙头选择
// ---------------------------------------------------------------------------

/**
 * 行业快照行：{ code, name, industry, marketCap, close, percent, listed? }
 * 返回按行业分组的 Top N，并把「样本不足 / 市值不足 / 被排除」显式记录。
 */
export function selectIndustryLeaders(rows, options = {}) {
  const topN = Math.max(1, Math.trunc(options.topN ?? 3));
  const minMembers = Math.max(1, Math.trunc(options.minMembers ?? 3));
  const minMarketCap = options.minMarketCap ?? 0;
  const excludePattern = options.excludePattern ?? /ST|退/;
  const onlyIndustries = options.industries?.length ? new Set(options.industries) : null;

  const excluded = [];
  const eligible = [];
  for (const row of rows) {
    if (!row?.code || !positive(row.marketCap)) {
      excluded.push({ code: row?.code ?? null, name: row?.name ?? null, reason: "缺少市值" });
      continue;
    }
    if (excludePattern.test(String(row.name ?? ""))) {
      excluded.push({ code: row.code, name: row.name, reason: "ST/退市风险" });
      continue;
    }
    if (row.marketCap < minMarketCap) {
      excluded.push({ code: row.code, name: row.name, reason: `市值低于 ${(minMarketCap / 1e8).toFixed(0)} 亿` });
      continue;
    }
    if (onlyIndustries && !onlyIndustries.has(row.industry)) continue;
    eligible.push(row);
  }

  const groups = new Map();
  for (const row of eligible) {
    const raw = String(row.industry ?? "").trim();
    // 东财对少量个股（多为新股/退市整理）给 "-" 或空，统一归到「未分类」而不是当成一个行业
    const industry = !raw || raw === "-" || raw === "—" ? "未分类" : raw;
    if (!groups.has(industry)) groups.set(industry, []);
    groups.get(industry).push({ ...row, industry });
  }

  const tracks = [];
  const warnings = [];
  for (const [industry, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"))) {
    const ranked = [...members].sort((left, right) => right.marketCap - left.marketCap);
    if (ranked.length < minMembers) {
      warnings.push(`${industry} 只有 ${ranked.length} 只达标成员（< ${minMembers}），不参与龙头排名`);
      continue;
    }
    const leaders = ranked.slice(0, topN).map((row, index) => ({ ...row, industry, industryRank: index + 1 }));
    tracks.push({
      industry,
      memberCount: ranked.length,
      leaders,
      layer: layerForIndustry(industry),
    });
  }
  return { tracks, excluded, warnings };
}

// ---------------------------------------------------------------------------
// 单只候选判定
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  topN: 3,
  minMembers: 3,
  minMarketCap: 5e9,
  minDrawdown: 0.25,
  rsiOverbought: 60,
  requireReturn120Negative: true,
  maxPercentileSevere: 0.2,
  maxPercentileMild: 0.35,
  minTtmGrowth: 0,
  // TTM 同比是滚动四季度，可能掩盖「最近一个季度已经明显转差」。
  // 低于该值时单独降级为 weak-quarter，不进入候选清单。
  minQuarterGrowth: -0.3,
  requireBounceConfirm: true,
};

/** 估值：权重指标取最差分位；严格档全部 ≤ severe，宽松档允许次级指标 ≤ mild。 */
export function evaluateValuation(item, settings) {
  const weight = item.layer?.metrics ?? DEFAULT_LAYER.metrics;
  const used = weight
    .map((key) => ({
      key,
      current: item.quotes?.[key]?.current ?? null,
      percentile: item.quotes?.[key]?.percentile ?? null,
      asOf: item.quotes?.[key]?.asOf ?? null,
    }))
    .filter((entry) => entry.percentile !== null);

  if (!used.length) {
    return { state: "insufficient", pass: false, tier: null, worstPercentile: null, metrics: [], note: "PE/PB 历史分位不足（有效样本 < 250 个交易日，或当前值非正）" };
  }

  const worst = Math.max(...used.map((entry) => entry.percentile));
  const primary = used.find((entry) => entry.key === weight[0]) ?? used[0];
  const breaches = used.filter((entry) => entry.percentile > settings.maxPercentileSevere);
  const mildBreaches = used.filter((entry) => entry.percentile > settings.maxPercentileMild);
  const tier = worst <= settings.maxPercentileSevere ? "severe" : worst <= settings.maxPercentileMild ? "mild" : "not_cheap";
  // 宽松档：允许「只有次级指标超过 mild」，但主指标必须 ≤ mild
  const loose = mildBreaches.length === 0
    || (mildBreaches.length === 1
      && mildBreaches[0].key !== primary.key
      && primary.percentile <= settings.maxPercentileMild);

  return {
    pass: tier === "severe",
    state: tier === "severe" ? "cheap" : tier === "mild" ? "fair" : "expensive",
    tier,
    worstPercentile: worst,
    metrics: used,
    breaches,
    loose: { pass: loose, breaches: mildBreaches },
    note: null,
  };
}

/** 弱势：回撤够深、中期仍下跌、且没有已经反弹到过热。 */
export function evaluateWeak(tech, settings) {
  if (!tech?.available) return { pass: false, reason: tech?.reason ?? "K线不足" };
  const pass = tech.drawdown252 <= -settings.minDrawdown
    && (!settings.requireReturn120Negative || (tech.return120 !== null && tech.return120 < 0))
    && tech.rsi14 !== null
    && tech.rsi14 < settings.rsiOverbought;
  return {
    pass,
    drawdown252: tech.drawdown252,
    return120: tech.return120,
    return60: tech.return60,
    return20: tech.return20,
    rsi14: tech.rsi14,
    distanceFromLow252: tech.distanceFromLow252,
    belowMa250: tech.ma250 !== null && tech.close < tech.ma250,
  };
}

/** 盈利：TTM 利润同比不低于下限，且最近一个单季没有大幅转差。 */
export function evaluateEarnings(fin, settings) {
  const latestQuarter = fin?.quarters?.[0] ?? null;
  const latestQuarterYoY = latestQuarter?.netProfitYoY ?? null;
  const ttmOk = fin?.ttmGrowth !== null && fin?.ttmGrowth !== undefined && fin.ttmGrowth >= settings.minTtmGrowth;
  // 单季缺失时不因此判负（数据缺失不等于恶化），但会由调用方在输出里看到 null
  const quarterOk = latestQuarterYoY === null
    || settings.minQuarterGrowth === null
    || settings.minQuarterGrowth === undefined
    || latestQuarterYoY >= settings.minQuarterGrowth;
  return {
    pass: ttmOk && quarterOk,
    ttmPass: ttmOk,
    quarterPass: quarterOk,
    ttmGrowth: fin?.ttmGrowth ?? null,
    cagr2y: fin?.cagr2y ?? null,
    latestQuarterDate: latestQuarter?.reportDate ?? null,
    latestQuarterYoY,
    reportDate: fin?.latestReportDate ?? null,
    ageDays: fin?.ageDays ?? null,
  };
}

/**
 * 综合研究优先级打分（0–100），四个分量都是可复核的公开口径：
 * 便宜程度 35%、跌幅 25%、盈利 20%、反弹动能 20%。
 * 这不是上涨概率，也不能当作仓位建议。
 */
export function scoreCandidate({ valuation, tech, earnings, bounce }) {
  const cheapness = valuation?.worstPercentile === null || valuation?.worstPercentile === undefined
    ? 0
    : 1 - valuation.worstPercentile;
  const depth = tech?.available ? Math.min(1, Math.abs(tech.drawdown252) / 0.6) : 0;
  const growth = earnings?.ttmGrowth ?? null;
  const earningsScore = growth === null ? 0.3 : Math.min(1, Math.max(0, (growth + 0.3) / 0.8));
  const triggerScore = Math.min(1, ((bounce?.confirm?.length ?? 0) * 2 + (bounce?.watch?.length ?? 0)) / 4);
  const total = 0.35 * cheapness + 0.25 * depth + 0.20 * earningsScore + 0.20 * triggerScore;
  return Math.round(Math.max(0, Math.min(1, total)) * 100);
}

export const STATUS_ORDER = ["bounce-watch", "no-trigger", "tight-wait-trigger", "expensive", "weak-quarter", "weak-earnings", "not-weak", "watch", "blocked"];

export const STATUS_LABEL = {
  "bounce-watch": "四关全过",
  "no-trigger": "等止跌信号",
  "tight-wait-trigger": "口径宽松待确认",
  expensive: "估值不便宜",
  "weak-quarter": "单季转差",
  "weak-earnings": "盈利恶化",
  "not-weak": "不够弱势",
  watch: "多关未过",
  blocked: "缺数据",
};

/**
 * 完整判定一只候选。item 需要：layer、tech（technicals 结果）、fin（buildFinancialSummary 结果）、
 * quotes（{peTtm:{current,percentile,asOf}, pb:{...}}）。
 */
export function evaluateCandidate(item, settings = DEFAULT_SETTINGS) {
  // 阻塞项由 buildCandidate 统一生成（已按原因去重），这里只补齐历史不足的情况
  const blocked = [...new Set(item.blocked ?? [])];

  const weak = evaluateWeak(item.tech, settings);
  const valuation = evaluateValuation(item, settings);
  const earnings = evaluateEarnings(item.fin, settings);
  const bounce = {
    confirm: item.tech?.confirm ?? [],
    watch: item.tech?.watch ?? [],
    pass: (item.tech?.confirm?.length ?? 0) > 0 || settings.requireBounceConfirm === false,
  };

  if (blocked.length) {
    return { status: "blocked", blocked, weak, valuation, earnings, bounce, failures: ["blocked"], score: null };
  }

  const failures = [];
  if (!weak.pass) failures.push("not-weak");
  if (!earnings.ttmPass) failures.push("weak-earnings");
  else if (!earnings.quarterPass) failures.push("weak-quarter");
  if (!bounce.pass) failures.push("no-trigger");
  if (!valuation.pass) failures.push(valuation.loose?.pass ? "valuation-tight" : "expensive");

  let status = "watch";
  if (failures.length === 0) status = "bounce-watch";
  else if (failures.length === 1 && failures[0] === "not-weak") status = "not-weak";
  else if (failures.length === 1 && failures[0] === "no-trigger") status = "no-trigger";
  else if (failures.length === 1 && failures[0] === "weak-earnings") status = "weak-earnings";
  else if (failures.length === 1 && failures[0] === "weak-quarter") status = "weak-quarter";
  else if (failures.length === 1 && failures[0] === "expensive") status = "expensive";
  else if (failures.length === 2 && failures[0] === "no-trigger" && failures[1] === "valuation-tight") status = "tight-wait-trigger";

  return {
    status,
    blocked,
    failures,
    weak,
    valuation,
    earnings,
    bounce,
    score: scoreCandidate({ valuation, tech: item.tech, earnings, bounce }),
  };
}

/**
 * 由 5 年日K序列构造 PE/PB 分位读数（当前值取最后一个有效倍数）。
 * 分位窗口直接复用 technicals 算好的 5 年序列，保证「5 年分位」这一标签
 * 和实际样本窗口一致，不在第二个地方重新定义历史区间。
 */
export function quoteHistory(rows, tech) {
  const lastValid = (key) => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (positive(rows[index]?.[key])) return { value: rows[index][key], date: rows[index].date };
    }
    return { value: null, date: null };
  };
  const pe = lastValid("peTtm");
  const pb = lastValid("pb");
  const peWindow = tech?.pe5y ?? rows.map((row) => row.peTtm);
  const pbWindow = tech?.pb5y ?? rows.map((row) => row.pb);
  return {
    peTtm: {
      current: pe.value,
      asOf: pe.date,
      percentile: percentileRank(peWindow, pe.value),
      observations: peWindow.filter(positive).length,
      stale: pe.date !== (rows.at(-1)?.date ?? null),
    },
    pb: {
      current: pb.value,
      asOf: pb.date,
      percentile: percentileRank(pbWindow, pb.value),
      observations: pbWindow.filter(positive).length,
      stale: pb.date !== (rows.at(-1)?.date ?? null),
    },
    stale: pe.date !== (rows.at(-1)?.date ?? null) || pb.date !== (rows.at(-1)?.date ?? null),
  };
}

/** 组装一只候选：技术、估值分位、财务。 */
export function buildCandidate(base, { rows, financialRows, blocked = [] }) {
  const tech = technicals(rows);
  const reasons = [...blocked];
  if (!tech.available) reasons.push(`K线：${tech.reason}`);
  if (!financialRows?.available) reasons.push(`财务：${financialRows?.reason ?? "缺失"}`);
  return {
    ...base,
    tech,
    quotes: quoteHistory(rows, tech),
    fin: financialRows,
    // 去重：同一原因（例如 K 线不足）不应重复计入阻塞项
    blocked: [...new Set(reasons)],
  };
}
