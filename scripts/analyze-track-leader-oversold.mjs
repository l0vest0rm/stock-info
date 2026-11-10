#!/usr/bin/env node
/**
 * 细分赛道龙头「跌得多 + 估值合理 + 有反弹条件」的可重复筛选。
 *
 * 输入（全部只读，除显式 --write-cache 回写K线缓存外不写任何数据）：
 *   - config/investment-universe.json —— 赛道 / 公司 / 原型（唯一分类口径）
 *   - data/local/market-data/kline/qfq/*.json —— 前复权日K（雪球快照）
 *   - data/local/market-data/financial-statements/income/*.json —— 东财利润表
 *   - 本地缓存缺失或过期时，用 XUEQIU_COOKIE 直连雪球K线（AGENTS.md 规定的
 *     唯一 A股K线来源），默认把新行合并回缓存，下次重跑就很快。
 *
 * 判定分三层，任何一层缺数据都显式标 blocked，不用 0 或默认值冒充：
 *   1. 赛道内 Top3（按前复权收盘价 × 总股本 = 当日总市值排名，可 --rank-by 切换）
 *   2. 弱势（相对 252 日高点回撤、120/60/20 日涨跌、RSI14）
 *   3. 估值合理（PE(TTM) / PB 在自身 5 年历史分位 ≤ --max-percentile-
 *      metrics 截断）+ 盈利质量（TTM 利润同比、最新单季同比、2 年 CAGR、
 *      是否跌破 250 日均线）+ 反弹条件（RSI 低位后金叉 / MACD 柱转正 /
 *      站回 5 日线且低点抬高）
 *
 * 输出是研究筛选清单，不是目标价、不是买卖指令、不构成收益预测。
 *
 * 用法：
 *   node scripts/analyze-track-leader-oversold.mjs
 *   node scripts/analyze-track-leader-oversold.mjs --json
 *   node scripts/analyze-track-leader-oversold.mjs --offline      # 不联网
 *   node scripts/analyze-track-leader-oversold.mjs --no-write-cache
 *   node scripts/analyze-track-leader-oversold.mjs --track IT-05 --min-drawdown 0.35
 *   node scripts/analyze-track-leader-oversold.mjs --rank-by growth
 *
 * 全部参数见 --help。
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildFinancialSummary,
  pct,
  percentileRank,
  positive,
  ratio,
  technicals,
  ttmValue,
  quarterValue,
} from "./lib/oversold-metrics.mjs";
import {
  createKlineResolver,
  pool,
  readJson,
  todayUtc,
  writeJsonAtomic,
} from "./lib/kline-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const DEFAULTS = {
  "base-url": "http://127.0.0.1:8000",
  "universe": "config/investment-universe.json",
  "kline-dir": "data/local/market-data/kline/qfq",
  "income-dir": "data/local/market-data/financial-statements/income",
  "credential-store": "data/local/runtime/xueqiu-credential.json",
  "out-dir": "reports/research",
  "track": "",
  "market": "CN",
  "top-n": "3",
  "rank-by": "market-cap",
  "min-drawdown": "0.25",
  "rsi-overbought": "60",
  "max-percentile-severe": "0.20",
  "max-percentile-mild": "0.35",
  "min-ttm-growth": "0.00",
  "stale-days": "7",
  "timeout-ms": "20000",
  "concurrency": "4",
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(helpText());
  process.exit(0);
}
const getOption = (name) => {
  const prefix = `${name}=`;
  const inline = args.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : null;
};
const flag = (name) => args.includes(name);
const config = {};
for (const key of Object.keys(DEFAULTS)) config[key] = getOption(`--${key}`) ?? DEFAULTS[key];
const asJson = flag("--json");
const offline = flag("--offline");
const writeCache = !flag("--no-write-cache");
const writeReport = flag("--write-report");
const strictFresh = flag("--strict-fresh");

const number = (key, min = -Infinity) => {
  const value = Number(config[key]);
  if (!Number.isFinite(value) || value < min) throw new Error(`--${key} 需要 >= ${min} 的数字，收到 ${config[key]}`);
  return value;
};
const settings = {
  topN: Math.trunc(number("top-n", 1)),
  minDrawdown: number("min-drawdown"),
  rsiOverbought: number("rsi-overbought"),
  maxPercentileSevere: number("max-percentile-severe"),
  maxPercentileMild: number("max-percentile-mild"),
  minTtmGrowth: number("min-ttm-growth"),
  staleDays: Math.trunc(number("stale-days", 0)),
  timeoutMs: Math.trunc(number("timeout-ms", 1000)),
  concurrency: Math.trunc(number("concurrency", 1)),
  market: config.market,
  rankBy: config["rank-by"],
  tracks: config.track ? String(config.track).split(",").map((v) => v.trim()).filter(Boolean) : [],
};
if (!["market-cap", "growth"].includes(settings.rankBy)) throw new Error("--rank-by 只支持 market-cap 或 growth");

const paths = {
  universe: resolve(root, config.universe),
  klineDir: resolve(root, config["kline-dir"]),
  incomeDir: resolve(root, config["income-dir"]),
  credentialStore: resolve(root, config["credential-store"]),
  outDir: resolve(root, config["out-dir"]),
};

// ---------------------------------------------------------------------------
// 归档口径
// ---------------------------------------------------------------------------

/**
 * 估值分层的权重键。跟随后端 finance/valuation/bands.rs 的 make_band 原型表：
 * 银行/保险用资产负债表口径，预盈利与地产运营不套通用 PE，周期股另行标注。
 */
const VALUATION_LAYERS = {
  growth_manufacturing: { label: "成长制造（PE 主、PB 辅）", metrics: ["peTtm", "pb"] },
  software_platform: { label: "软件平台（PE 主、PB 辅）", metrics: ["peTtm", "pb"] },
  healthcare_services: { label: "医疗服务（PE 主、PB 辅）", metrics: ["peTtm", "pb"] },
  stable_cash_dividend: { label: "稳定现金流/高股息（PE 主、PB 辅）", metrics: ["peTtm", "pb"] },
  cyclical_commodity: { label: "周期资源（价格分位仅作参考，需按中枢利润复核）", metrics: ["peTtm", "pb"], cyclical: true },
  exchange: { label: "交易所（PE 主、PB 辅）", metrics: ["peTtm", "pb"] },
  payment: { label: "支付网络（PE 主、PB 辅）", metrics: ["peTtm", "pb"] },
  bank: { label: "银行（PB 主、PE 辅）", metrics: ["pb", "peTtm"] },
  insurer: { label: "保险（PB 主、PE 辅）", metrics: ["pb", "peTtm"] },
  pre_profit_milestone: { label: "预盈利/里程碑事件（PE 无意义）", metrics: ["pb"], peMeaningless: true },
  property_operator: { label: "不动产运营（不套通用 PE 分层）", metrics: ["pb"], peMeaningless: true },
  other: { label: "未分类（PE 主、PB 辅）", metrics: ["peTtm", "pb"] },
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
//
// DAY / closeOf / positive / numeric / pct / ratio / daysBetween / shiftYear /
// todayUtc / readJson / writeJsonAtomic / xueqiuSymbol / xueqiuCookie 都由
// ./lib/oversold-metrics.mjs 与 ./lib/kline-store.mjs 提供，两个筛选脚本共用。

// ---------------------------------------------------------------------------
// K线：本地缓存优先，缺失/过期才拉雪球并回写
// ---------------------------------------------------------------------------
//
// 实现位于 ./lib/kline-store.mjs（与全市场行业龙头筛选共用）。这里只把
// 本脚本的参数绑定进去，保持 --offline / --no-write-cache 的原有语义。

const ensureKline = createKlineResolver({
  klineDir: paths.klineDir,
  credentialStore: paths.credentialStore,
  root,
  offline,
  writeCache,
  staleDays: settings.staleDays,
  timeoutMs: settings.timeoutMs,
});

// ---------------------------------------------------------------------------
// 技术指标与财务口径
// ---------------------------------------------------------------------------
//
// 实现位于 ./lib/oversold-metrics.mjs，与全市场行业龙头筛选脚本共用，
// 避免两个脚本对 TTM / 单季 / RSI 的口径出现漂移。这里只做转出。

export { percentileRank, ttmValue, quarterValue };

function financials(code, refDate) {
  const file = readJson(resolve(paths.incomeDir, `${code}.json`));
  const rows = Array.isArray(file?.rows) ? file.rows : [];
  return buildFinancialSummary(rows, refDate);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const universe = readJson(paths.universe);
  if (!universe?.companies || !universe?.tracks) throw new Error(`无法读取观察池：${paths.universe}`);
  const tracks = new Map((universe.tracks ?? []).map((track) => [track.id, track]));
  const sectors = new Map((universe.sectors ?? []).map((sector) => [sector.id, sector]));

  // 1. 候选证券：A股（或指定市场）+ 已核验分类
  const candidates = universe.companies
    .filter((company) => company.classificationStatus === "verified")
    .filter((company) => !settings.tracks.length || settings.tracks.includes(company.primaryTrackId))
    .map((company) => {
      const security = company.securities.find((item) => item.market === settings.market && item.ticker === company.preferredTicker)
        ?? company.securities.find((item) => item.market === settings.market);
      if (!security) return null;
      return {
        companyId: company.id,
        name: company.displayName,
        code: security.ticker,
        market: security.market,
        trackId: company.primaryTrackId,
        trackName: tracks.get(company.primaryTrackId)?.name ?? company.primaryTrackId,
        sectorId: company.primarySectorId,
        sectorName: sectors.get(company.primarySectorId)?.name ?? company.primarySectorId,
        archetype: company.valuationArchetype ?? "other",
        positioning: company.positioning ?? "",
        priority: company.researchPriority ?? "",
      };
    })
    .filter(Boolean);

  // 2. K线（缓存优先）
  const byCode = new Map();
  for (const item of candidates) {
    if (!byCode.has(item.code)) byCode.set(item.code, []);
    byCode.get(item.code).push(item);
  }
  const codes = [...byCode.keys()];
  const refDate = null; // 以「今天」为前沿，判断缓存是否过期
  const klines = new Map();
  const fetched = await pool(codes, settings.concurrency, async (code) => [code, await ensureKline(code, refDate)]);
  for (const [code, result] of fetched) klines.set(code, result);

  // 3. 每只票：市值（份额 = 市值 / 收盘价）、技术、财务、估值分位
  const enriched = [];
  for (const company of candidates) {
    const kline = klines.get(company.code);
    const rows = kline?.rows ?? [];
    const last = rows.at(-1) ?? null;
    const shares = last && positive(last.marketCapital) && positive(last.close) ? last.marketCapital / last.close : null;
    // 雪球个别交易日缺 market_capital：用最近一次有效值 / 当日收盘 反推股本，再乘最新收盘。
    // 股本变化（增发、回购）会让这里失真，所以只在「源数据缺市值」时使用，并在输出里标注。
    let marketCap = positive(last?.marketCapital) ? last.marketCapital : null;
    let marketCapDerived = false;
    if (marketCap === null && shares && last) {
      marketCap = shares * last.close;
      marketCapDerived = true;
    }
    const tech = technicals(rows);
    const fin = financials(company.code, tech.available ? tech.asOf : (kline?.cacheEnd ?? todayUtc()));
    const layer = VALUATION_LAYERS[company.archetype] ?? VALUATION_LAYERS.other;
    // 最后一天雪球偶尔不带 PE/PB：回看最近一个有值的交易日，并在分位对象里记录口径日，
    // 避免用「当天价格 + 旧倍数」给分位。
    const multipleOn = (key) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (positive(rows[index]?.[key])) return { value: rows[index][key], date: rows[index].date };
      }
      return { value: null, date: null };
    };
    const lastPe = multipleOn("peTtm");
    const lastPb = multipleOn("pb");
    const valuation = {
      layer: company.archetype,
      layerLabel: layer.label,
      weight: layer.metrics,
      metrics: {},
    };
    for (const key of ["peTtm", "pb"]) {
      const series = key === "peTtm" ? tech.pe5y ?? [] : tech.pb5y ?? [];
      const reading = key === "peTtm" ? lastPe : lastPb;
      const current = reading.value;
      const window = key === "peTtm" ? tech.pe4y ?? [] : tech.pb4y ?? [];
      const usable = window.filter(positive);
      const mean4y = usable.length >= 250 ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
      const observations = (series ?? []).filter(positive).length;
      // 分位用「截至当日」的窗口；当前值非正（亏损）时分位无定义，不给 0
      const currentValid = positive(current) ? current : null;
      const historicalValid = positive(current) ? observations : 0;
      valuation.metrics[key] = {
        current: currentValid,
        asOf: currentValid === null ? null : reading.date,
        staleMultiple: Boolean(currentValid) && reading.date !== last?.date,
        percentile5y: percentileRank(series ?? [], currentValid),
        mean4y,
        observations: historicalValid,
        note: currentValid === null
          ? `${key === "peTtm" ? "PE" : "PB"} 非正或历史缺失（亏损/口径异常），不参与判定`
          : null,
      };
    }
    valuation.cyclical = layer.cyclical === true;
    valuation.peMeaningless = layer.peMeaningless === true;

    enriched.push({
      ...company,
      kline: {
        source: kline?.source ?? "missing",
        cacheEnd: kline?.cacheEnd ?? null,
        current: kline?.current ?? false,
        fetched: kline?.fetched ?? false,
        fetchError: kline?.fetchError ?? null,
        sessions: rows.length,
      },
      shares,
      marketCap,
      marketCapDerived,
      last,
      tech,
      fin,
      valuation,
      blocked: [],
    });
  }

  // 4. 赛道内 Top N
  const groups = new Map();
  for (const item of enriched) {
    if (!groups.has(item.trackId)) groups.set(item.trackId, []);
    groups.get(item.trackId).push(item);
  }
  // 市值缺失的成员无法参与排名，显式留档，不按 0 处理
  for (const item of enriched) item.trackRank = null;
  const warnings = [];
  const rankKey = (item) => {
    if (settings.rankBy === "growth") {
      const size = positive(item.marketCap) ? Math.log10(item.marketCap) : 0;
      const growth = item.fin?.available ? (item.fin.ttmGrowth ?? 0) : 0;
      return size * (1 + Math.max(-0.5, Math.min(1, growth)));
    }
    return positive(item.marketCap) ? item.marketCap : -Infinity;
  };
  for (const [trackId, members] of groups) {
    const ranked = members.filter((item) => item.marketCap > 0).sort((left, right) => rankKey(right) - rankKey(left));
    ranked.forEach((item, index) => {
      item.trackRank = index + 1;
      item.isLeader = index < settings.topN;
    });
    const missingCodes = members.filter((item) => !(item.marketCap > 0)).map((item) => item.code);
    if (missingCodes.length) warnings.push(`${trackId} 有 ${missingCodes.length} 只成员缺市值（${missingCodes.join("、")}），未参与龙头排名`);
  }

  // 5. 逐票打分
  for (const item of enriched) {
    const blocked = [];
    const tech = item.tech;
    const fin = item.fin;
    if (!item.kline.current) blocked.push(`行情未刷新（最后K线 ${item.kline.cacheEnd ?? "—"}）`);
    if (item.kline.fetchError && !item.kline.fetched) blocked.push(`行情刷新失败：${item.kline.fetchError}`);
    if (!item.isLeader) blocked.push("非赛道 Top N");
    if (!(item.marketCap > 0)) blocked.push("无法确定市值（缺 market_capital，也无法用股本反推）");
    if (!tech?.available) blocked.push(`K线不足：${tech?.reason ?? "缺失"}`);
    if (!fin?.available) blocked.push(`财务缺失：${fin?.reason ?? "未知"}`);
    item.blocked = blocked;

    if (!tech?.available || !fin?.available) continue;

    // 5.1 弱势
    const weak = tech.drawdown252 <= -settings.minDrawdown
      && tech.return120 < 0
      && tech.rsi14 !== null
      && tech.rsi14 < settings.rsiOverbought;
    item.weak = {
      pass: weak,
      drawdown252: tech.drawdown252,
      return120: tech.return120,
      return60: tech.return60,
      return20: tech.return20,
      rsi14: tech.rsi14,
      distanceFromLow252: tech.distanceFromLow252,
      trend60: tech.trend60,
      belowMa250: tech.ma250 !== null && tech.close < tech.ma250,
    };

    // 5.2 估值：加权指标分位取最大值（至少要有一个可用指标）
    const used = item.valuation.weight
      .map((key) => ({
        key,
        percentile: item.valuation.metrics[key]?.percentile5y ?? null,
        current: item.valuation.metrics[key]?.current ?? null,
      }))
      .filter((entry) => entry.percentile !== null);
    const worst = used.length ? Math.max(...used.map((entry) => entry.percentile)) : null;
    const valuation = {
      pass: false,
      worstPercentile: worst,
      state: "insufficient",
      metrics: used,
      note: null,
    };
    if (!used.length) {
      valuation.note = "5 年历史分位不足（样本 < 250 个有效观测）";
    } else {
      const breached = used.filter((entry) => entry.percentile > settings.maxPercentileSevere);
      const tier = worst <= settings.maxPercentileSevere ? "severe" : worst <= settings.maxPercentileMild ? "mild" : "not_cheap";
      valuation.tier = tier;
      valuation.state = tier === "severe" ? "cheap" : tier === "mild" ? "fair" : "expensive";
      valuation.breached = breached;
      const missing = item.valuation.weight.filter((key) => !used.some((entry) => entry.key === key));
      if (missing.length) valuation.note = `缺少可用的 ${missing.map((key) => (key === "peTtm" ? "PE" : "PB")).join("/")} 分位（亏损或历史不足）`;

      // 次口径（宽松档）给「结论稳健」和「结论依赖口径」分档：所有指标 ≤ mild，
      // 或「主指标 ≤ mild 且只有次级指标超限」（例如银行只看 PB、成长看 PE）。
      // 它不影响 pass（pass 仍然是严格档），只用于把半程达标的标的从「贵」里挑出来。
      const primary = used.find((entry) => entry.key === item.valuation.weight[0]);
      const looseBreaches = used.filter((entry) => entry.percentile > settings.maxPercentileMild);
      const loose = looseBreaches.length === 0
        || (looseBreaches.length === 1 && looseBreaches[0].key !== item.valuation.weight[0]
          && (primary?.percentile ?? 1) <= settings.maxPercentileMild);
      valuation.loose = { pass: loose, breaches: looseBreaches };

      // 严格档：权重指标全部 ≤ severe 阈值
      valuation.strict = breached.length === 0;
      valuation.pass = valuation.strict;
    }

    // 5.3 盈利与反弹条件
    const quarters = fin.quarters ?? [];
    const latestQuarter = quarters[0] ?? null;
    const earnings = {
      ttmGrowth: fin.ttmGrowth,
      cagr2y: fin.cagr2y,
      latestQuarterDate: latestQuarter?.reportDate ?? null,
      latestQuarterYoY: latestQuarter?.netProfitYoY ?? null,
      latestQuarterRevenueYoY: latestQuarter?.revenueYoY ?? null,
      growing: fin.ttmGrowth !== null && fin.ttmGrowth >= settings.minTtmGrowth,
      reportDate: fin.latestReportDate,
      ageDays: fin.ageDays,
    };
    const bounce = {
      signals: tech.signals,
      confirm: tech.confirm,
      watch: tech.watch,
      pass: tech.confirm.length > 0,
    };
    const quality = {
      pass: earnings.growing,
    };

    // 估值这一关要在「弱势」之后才知道是否进候选，所以放到最后再做「便宜程度」的分数
    item.valuationCheck = valuation;
    item.earnings = earnings;
    item.bounce = bounce;

    // 5.4 先过滤再排序。失败项按「弱势 / 盈利 / 反弹 / 估值」的语义命名，
    // 便于输出时直接说清楚差在哪一关。
    const failures = [];
    if (!weak) failures.push("not-weak");
    if (!quality.pass) failures.push("weak-earnings");
    if (!bounce.pass) failures.push("no-trigger");
    if (!valuation.pass) failures.push(valuation.loose?.pass ? "valuation-tight" : "expensive");
    item.failures = failures;

    // 「综合研究优先级」打分（0–100），四个分量都是可复核的公开口径：
    // 便宜程度（权重 35%）、跌幅（25%）、盈利（20%）、反弹动能（20%）。
    // 这不是上涨概率，也不能当作仓位建议。
    const cheapness = used.length ? 1 - worst : 0;
    const depth = Math.min(1, Math.abs(tech.drawdown252) / 0.6);
    const earningsScore = fin.ttmGrowth === null ? 0.3 : Math.min(1, Math.max(0, (fin.ttmGrowth + 0.3) / 0.8));
    const triggerScore = Math.min(1, (tech.confirm.length * 2 + tech.watch.length) / 4);
    item.score = Math.round(
      Math.max(0, Math.min(1, 0.35 * cheapness + 0.25 * depth + 0.20 * earningsScore + 0.20 * triggerScore)) * 100,
    );

    if (failures.length === 0) item.status = "bounce-watch";
    else if (failures.length === 1 && failures[0] === "not-weak") item.status = "not-weak";
    else if (failures.length === 1 && failures[0] === "no-trigger") item.status = "no-trigger";
    else if (failures.length === 1 && failures[0] === "weak-earnings") item.status = "weak-earnings";
    else if (failures.length === 1 && failures[0] === "expensive") item.status = "expensive";
    else if (failures.length === 2 && failures[0] === "no-trigger" && failures[1] === "valuation-tight") item.status = "tight-wait-trigger";
    else item.status = "watch";
  }

  const leaders = enriched.filter((item) => item.isLeader);
  const results = leaders
    .map((item) => {
      const quote = item.last;
      return {
        code: item.code,
        name: item.name,
        trackId: item.trackId,
        trackName: item.trackName,
        sectorName: item.sectorName,
        archetype: item.archetype,
        trackRank: item.trackRank,
        marketCap: item.marketCap ?? null,
        marketCapDerived: item.marketCapDerived,
        trackRank: item.trackRank ?? null,
        close: quote?.close ?? null,
        quoteDate: quote?.date ?? null,
        quoteSource: item.kline.source,
        quoteStale: !item.kline.current,
        status: item.blocked.length ? "blocked" : (item.status ?? "error"),
        blocked: item.blocked,
        failures: item.failures ?? [],
        score: item.score ?? null,
        weak: item.weak ?? null,
        valuation: item.valuationCheck ?? null,
        earnings: item.earnings ?? null,
        bounce: item.bounce ?? null,
        layers: item.valuation.layerLabel,
      };
    })
    .sort((left, right) => {
      const rank = { "bounce-watch": 0, "no-trigger": 1, "tight-wait-trigger": 2, expensive: 3, "weak-earnings": 4, "not-weak": 5, watch: 6, blocked: 7 };
      return (rank[left.status] ?? 9) - (rank[right.status] ?? 9)
        || (right.score ?? -1) - (left.score ?? -1)
        || (right.marketCap ?? 0) - (left.marketCap ?? 0);
    });

  const groupSummaries = [...groups.entries()].map(([trackId, members]) => ({
    trackId,
    trackName: members[0].trackName,
    sectorName: members[0].sectorName,
    coverage: members.length,
    unranked: members.filter((item) => !(item.marketCap > 0)).map((item) => item.code),
    leaders: [...members]
      .filter((item) => item.isLeader)
      .sort((left, right) => (left.trackRank ?? 99) - (right.trackRank ?? 99))
      .map((item) => ({
      code: item.code,
      name: item.name,
      marketCap: item.marketCap ?? null,
      marketCapDerived: item.marketCapDerived,
      drawdown252: item.tech?.available ? item.tech.drawdown252 : null,
      return60: item.tech?.available ? item.tech.return60 : null,
      peTtm: item.valuation?.metrics?.peTtm?.current ?? null,
      pePercentile5y: item.valuation?.metrics?.peTtm?.percentile5y ?? null,
      ttmGrowth: item.fin?.available ? item.fin.ttmGrowth : null,
      status: item.blocked.length ? "blocked" : (item.status ?? "error"),
      score: item.score ?? null,
    })),
  })).sort((left, right) => left.trackId.localeCompare(right.trackId));

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    disclaimer: "研究筛选，不是目标价、不是买卖指令、不构成收益预测；历史分位便宜不等于内在低估。",
    inputs: {
      universe: config.universe,
      universeAsOf: universe.asOf ?? null,
      market: settings.market,
      klineDir: config["kline-dir"],
      incomeDir: config["income-dir"],
      offline,
      cacheWritten: writeCache && !offline,
    },
    settings: {
      ...settings,
      maxPercentileSevere: settings.maxPercentileSevere,
      maxPercentileMild: settings.maxPercentileMild,
    },
    counts: {
      tracks: groups.size,
      candidates: candidates.length,
      leaders: leaders.length,
      byStatus: results.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      }, {}),
      fetch: {
        fromNetwork: [...klines.values()].filter((item) => item.fetched).length,
        failed: [...klines.values()].filter((item) => item.fetchError && item.fetchError !== "offline").length,
        missing: [...klines.values()].filter((item) => item.source === "missing").length,
        stale: [...klines.values()].filter((item) => item.source !== "missing" && !item.current).length,
      },
    },
    warnings,
    tracks: groupSummaries,
    results,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }
  if (writeReport || asJson) {
    const suffix = config.track ? `-${settings.tracks.join("_")}` : "";
    const base = resolve(paths.outDir, `赛道龙头超跌筛选_${todayUtc()}${suffix}`);
    writeJsonAtomic(`${base}.json`, report);
    if (writeReport) writeFileSync(`${base}.md`, `${renderMarkdown(report)}\n`);
    if (!asJson) console.log(`\n已写入：${base}.json${writeReport ? ` 与 .md` : ""}`);
  }
  if (strictFresh && report.counts.fetch.stale > 0) {
    console.error(`\n--strict-fresh：仍有 ${report.counts.fetch.stale} 只票的行情没刷新到最新，退出码 2`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  "bounce-watch": "四关全过",
  "no-trigger": "等止跌信号",
  "tight-wait-trigger": "口径宽松待确认",
  expensive: "估值严格不便宜",
  "weak-earnings": "盈利恶化",
  "not-weak": "不够弱势",
  watch: "多关未过",
  blocked: "缺数据",
};

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# 赛道龙头「超跌 + 估值合理 + 反弹条件」筛选 — ${report.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`> ${report.disclaimer}`);
  lines.push("");
  lines.push(`- 观察池：${report.inputs.universe}（asOf ${report.inputs.universeAsOf ?? "—"}），市场 ${report.inputs.market}`);
  lines.push(`- 覆盖：${report.counts.tracks} 个赛道 / ${report.counts.candidates} 只证券，龙头 ${report.counts.leaders} 只`);
  lines.push(`- 数据：联网刷新 ${report.counts.fetch.fromNetwork} 只，刷新失败 ${report.counts.fetch.failed} 只，无缓存 ${report.counts.fetch.missing} 只，行情未到最新 ${report.counts.fetch.stale} 只（以 ${report.generatedAt.slice(0, 10)} 为交易日前沿判断）`);
  lines.push(`- 口径：回撤 ≥ ${pct(-report.settings.minDrawdown, 0)}、120 日下跌、RSI14 < ${report.settings.rsiOverbought}；估值用 ${pct(report.settings.maxPercentileSevere, 0)} / ${pct(report.settings.maxPercentileMild, 0)} 两档 5 年分位；TTM 利润同比 ≥ ${pct(report.settings.minTtmGrowth, 0)}`);
  if (report.warnings?.length) {
    lines.push(`- 注意：${report.warnings.length} 个赛道有成员因缺行情/市值未参与排名（见文末「数据覆盖提醒」），这些赛道实际比较的样本数少于观察池人数。`);
  }
  lines.push("");

  const bucket = (status) => report.results.filter((item) => item.status === status);
  lines.push("## 零、摘要");
  lines.push("");
  const fullPass = bucket("bounce-watch").length;
  lines.push(`**四关全过 ${fullPass} 只。** 严格档 = 权重估值指标 5 年分位都 ≤ ${pct(report.settings.maxPercentileSevere, 0)}；宽松档 = 主指标 ≤ ${pct(report.settings.maxPercentileSevere, 0)} 且次级指标 ≤ ${pct(report.settings.maxPercentileMild, 0)}。各状态数量：${Object.entries(report.counts.byStatus).map(([key, value]) => `${STATUS_LABEL[key] ?? key} ${value}`).join(" · ")}。`);
  lines.push("");
  lines.push("## 一、候选清单（先看这组）");
  lines.push("");
  lines.push("四关全过：赛道龙头 + 弱势 + 估值不贵 + 盈利未恶化 + 至少一个**确认**性质的止跌/修复信号。");
  lines.push("");
  const numerals = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const picks = bucket("bounce-watch");
  if (picks.length === 0) {
    lines.push("**本次没有四关全过的标的。** 这不是「没机会」，而是「用这套纪律现在没有机会」；下面按差哪一关分组列出原因。");
    lines.push("");
  } else {
    lines.push(`| 排名分 | 代码 | 名称 | 赛道 | 回撤252d | 120d | RSI14 | PE(TTM) | 5年分位 | PB | PB分位 | TTM利润同比 | 最新单季同比 | 反弹信号 |`);
    lines.push("| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const item of picks) lines.push(resultRow(item));
    lines.push("");
  }

  // 章节序号按「实际有内容的章节」统一编号（含第一节），避免跳号
  const rawSections = [
    ["no-trigger", "估值宽松/严格档、盈利、弱势都符合，但价格仍在下跌且没有任何止跌/修复信号（最值得盯盘的一档：等确认信号，不猜底）"],
    ["tight-wait-trigger", "只有次级估值指标超过 35% 分位、其余都符合（结论依赖口径，谨慎）"],
    ["expensive", "跌得多、盈利也还在，但严格口径下估值不便宜（等价格或等业绩；注意周期股的 PE 分位会失真）"],
    ["weak-earnings", "价格便宜但盈利在恶化（低 PE 不等于低估，本轮剔除）"],
    ["not-weak", "估值与盈利都可以，但没有满足「弱势」条件（不适合当超跌反弹）"],
    ["watch", "多关未过（只留档，不做优先研究）"],
    ["blocked", "数据不够，未做判断"],
  ];
  let sectionIndex = 1; // 第一节是候选清单
  for (const [status, title] of rawSections) {
    const items = bucket(status);
    if (!items.length) continue;
    sectionIndex += 1;
    lines.push(`## ${numerals[sectionIndex - 1] ?? sectionIndex}、${title}`);
    lines.push("");
    for (const item of items) {
      lines.push(`- **${item.name}**（${item.code}，${item.trackName}${item.trackRank ? `，赛道第 ${item.trackRank}` : ""}）— 分 ${item.score ?? "—"}`);
      lines.push(`  - ${summaryOf(item)}`);
    }
    lines.push("");
  }

  lines.push("## 赛道 Top N 全景");
  lines.push("");
  lines.push("| 赛道 | 代码 | 名称 | 市值(亿元) | 回撤252d | 60d | PE(TTM) | PE分位 | TTM增长 | 状态 |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const group of report.tracks) {
    for (const leader of group.leaders) {
      lines.push(
        `| ${group.trackId} ${group.trackName} | ${leader.code} | ${leader.name} | ${leader.marketCap ? `${(leader.marketCap / 1e8).toFixed(0)}${leader.marketCapDerived ? "*" : ""}` : "—"}`
        + ` | ${pct(leader.drawdown252)} | ${pct(leader.return60)} | ${ratio(leader.peTtm, 1)} | ${pct(leader.pePercentile5y, 0)} | ${pct(leader.ttmGrowth)} | ${leader.status} |`,
      );
    }
  }
  lines.push("");
  if (report.warnings?.length) {
    lines.push("## 数据覆盖提醒");
    lines.push("");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push("## 局限");
  lines.push("");
  for (const line of [
    "- 总市值是「赛道 Top3」的排名依据；带 `*` 的是雪球最后一日缺 `market_capital`、用最近有效市值/收盘价反推股本再乘最新收盘得到的估算值。",
    "- 行内带 `※` 的 PE/PB 是该股最后一个有值的交易日（而不是最后K线日），说明雪球近几日没有给出该倍数。",
    "- PE/PB 历史分位是相对自身历史，不是跨行业可比估值；周期股（原型 cyclical_commodity）的 PE 分位受盈利周期扭曲，必须按中枢利润复核。",
    "- 银行、保险用 PB 主口径；预盈利/不动产运营不套通用 PE。",
    "- 「反弹信号」只是价格结构上的止跌迹象，不是基本面反转证据；`最新单季同比` 由东财累计口径做差得到，注意 `报告期` 的时效（见每行）。",
    "- 观察池每个赛道只有 2–5 只样本，Top3 只是观察池内排序，不等于全市场龙头。",
  ]) lines.push(line);
  return lines.join("\n");
}

function resultRow(item) {
  const m = item.valuation?.metrics ?? [];
  const pe = m.find((entry) => entry.key === "peTtm") ?? null;
  const pb = m.find((entry) => entry.key === "pb") ?? null;
  // 倍数口径日与最后K线不一致时加 ※（跨了 1 个交易日以上）
  const peLabel = pe?.current == null ? "—" : `${ratio(pe.current, 1)}${pe.staleMultiple ? "※" : ""}`;
  const pbLabel = pb?.current == null ? "—" : `${ratio(pb.current, 2)}${pb.staleMultiple ? "※" : ""}`;
  const weak = item.weak ?? {};
  const earn = item.earnings ?? {};
  return [
    item.score ?? "—",
    item.code,
    item.name,
    item.trackName,
    pct(weak.drawdown252),
    pct(weak.return120),
    ratio(weak.rsi14, 1),
    peLabel,
    pct(pe?.percentile ?? null, 0),
    pbLabel,
    pct(pb?.percentile ?? null, 0),
    pct(earn.ttmGrowth),
    pct(earn.latestQuarterYoY),
    (item.bounce?.confirm ?? []).map((signal) => signal.label).join("；") || (item.bounce?.watch ?? []).map((signal) => `观察：${signal.label}`).join("；") || "—",
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function summaryOf(item) {
  if (item.status === "blocked") return `缺数据：${item.blocked.join("；")}`;
  const parts = [];
  const weak = item.weak ?? {};
  parts.push(`252d 回撤 ${pct(weak.drawdown252)}，120d ${pct(weak.return120)}，RSI14 ${ratio(weak.rsi14, 1)}`);
  const metrics = (item.valuation?.metrics ?? []).map((entry) => `${entry.key === "peTtm" ? "PE" : "PB"} 5年分位 ${pct(entry.percentile, 0)}`).join("、");
  if (metrics) parts.push(metrics);
  if (item.valuation?.breached?.length) parts.push(`超出阈值：${item.valuation.breached.map((entry) => `${entry.key} ${pct(entry.percentile, 0)}`).join("、")}`);
  if (item.valuation?.note) parts.push(item.valuation.note);
  const earn = item.earnings ?? {};
  if (earn.ttmGrowth !== null && earn.ttmGrowth !== undefined) parts.push(`TTM 利润同比 ${pct(earn.ttmGrowth)}（${earn.reportDate ?? "—"}）`);
  if (earn.latestQuarterYoY !== null && earn.latestQuarterYoY !== undefined) parts.push(`最新单季利润同比 ${pct(earn.latestQuarterYoY)}（${earn.latestQuarterDate}）`);
  if (item.bounce?.confirm?.length) parts.push(`确认信号：${item.bounce.confirm.map((signal) => signal.label).join("；")}`);
  if (item.bounce?.watch?.length) parts.push(`观察信号：${item.bounce.watch.map((signal) => signal.label).join("；")}`);
  if (item.quoteStale) parts.push(`⚠ 行情截至 ${item.quoteDate}`);
  return parts.join("；");
}

function helpText() {
  return `赛道龙头超跌筛选（研究用途，不是买卖指令）

node scripts/analyze-track-leader-oversold.mjs [选项]

  --json                    输出 JSON（同时写 reports/research/*.json）
  --write-report            同时写 Markdown 报告
  --offline                 只用本地K线缓存，绝不联网
  --no-write-cache          从雪球拉到新K线后不写回缓存
  --strict-fresh            仍有行情未到最新时退出码 2（适合放进定时任务）
  --track IT-05,CS-01       只分析指定赛道（逗号分隔）
  --market CN               市场，默认 CN
  --top-n 3                 每个赛道取前 N 只龙头，默认 3
  --rank-by market-cap      龙头排序：market-cap（总市值）或 growth（市值×TTM增长）
  --min-drawdown 0.25       相对 252 日最高收盘价的回撤门槛（正数）
  --rsi-overbought 60       RSI14 高于此值视为已反弹、不追
  --max-percentile-severe 0.20   任一权重指标 5 年分位须 ≤ 此值（便宜）
  --max-percentile-mild 0.35     若介于 severe 与 mild 之间，标记为 fair（仍不进候选）
  --min-ttm-growth 0.00    TTM 利润同比下限
  --stale-days 7            缓存与「今天」相差超过多少天就去刷新
  --concurrency 4           雪球并发
  --base-url http://127.0.0.1:8000  预留：如未来改用本地 API 行情

K线来源只有雪球（AGENTS.md 规定）；Cookie 读取顺序：
LOCAL_XUEQIU_CREDENTIAL_STORE / data/local/runtime/xueqiu-credential.json → 环境变量 XUEQIU_COOKIE → .dev.vars。
`;
}

// 只在被直接执行时跑主流程；被测试 import 时只导出纯函数。
const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
