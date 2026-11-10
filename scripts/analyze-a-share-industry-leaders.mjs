#!/usr/bin/env node
/**
 * 全 A 股「细分行业龙头 Top N · 跌得多 · 估值合理 · 有反弹条件」可重复筛选。
 *
 * 和 scripts/analyze-track-leader-oversold.mjs 的区别：
 *   - 那个脚本的「赛道 Top3」是 config/investment-universe.json 观察池内排序（78 只）；
 *   - 这个脚本先拉全 A 股行业快照，按东财行业分组、按总市值选出行业内 Top N，
 *     再只对入围的龙头取K线和财报做判定，覆盖全市场而不是人工池。
 *
 * 数据来源与边界（见 AGENTS.md）：
 *   - 行业归属 + 总市值：东财行情快照（只用于选龙头，不作为价格来源）
 *   - 日K / PE(TTM) / PB：雪球（唯一A股K线来源），Cookie 从本地凭据仓读取
 *   - 利润表：东财 F10，与后端 finance/providers.rs 同家族
 *   - 缺 Cookie、雪球人机验证、利润表缺失都会显式标 blocked，不静默降级
 *
 * 用法：
 *   node scripts/analyze-a-share-industry-leaders.mjs
 *   node scripts/analyze-a-share-industry-leaders.mjs --write-report
 *   node scripts/analyze-a-share-industry-leaders.mjs --offline        # 只用本地缓存
 *   node scripts/analyze-a-share-industry-leaders.mjs --limit-tracks 5 --json
 *   node scripts/analyze-a-share-industry-leaders.mjs --industry 半导体,白酒Ⅱ
 *   node scripts/analyze-a-share-industry-leaders.mjs --min-drawdown 0.35 --max-percentile-severe 0.15
 *
 * 输出是研究筛选清单，不是目标价、不是买卖指令、不构成收益预测。
 * 全部参数见 --help。
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

import {
  buildFinancialSummary,
  daysBetween,
  pct,
  ratio,
} from "./lib/oversold-metrics.mjs";
import { createKlineResolver, pool, readJson, todayUtc, writeJsonAtomic } from "./lib/kline-store.mjs";
import {
  DEFAULT_SETTINGS,
  STATUS_LABEL,
  STATUS_ORDER,
  buildCandidate,
  evaluateCandidate,
  selectIndustryLeaders,
} from "./lib/industry-leader-screen.mjs";
import { fetchIncomeRows, fetchIndustrySnapshot, reportFamily } from "./lib/a-share-data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const DEFAULTS = {
  "kline-dir": "data/local/market-data/kline/qfq",
  "income-dir": "data/local/market-data/industry-income",
  "snapshot-cache-dir": "data/local/market-data/industry-snapshot",
  "credential-store": "data/local/runtime/xueqiu-credential.json",
  "mappings": "shared/finance-mappings.json",
  "out-dir": "reports/research",
  "industry": "",
  "limit-tracks": "0",
  "top-n": String(DEFAULT_SETTINGS.topN),
  "min-members": String(DEFAULT_SETTINGS.minMembers),
  "min-market-cap": String(DEFAULT_SETTINGS.minMarketCap),
  "min-drawdown": String(DEFAULT_SETTINGS.minDrawdown),
  "rsi-overbought": String(DEFAULT_SETTINGS.rsiOverbought),
  "max-percentile-severe": String(DEFAULT_SETTINGS.maxPercentileSevere),
  "max-percentile-mild": String(DEFAULT_SETTINGS.maxPercentileMild),
  "min-ttm-growth": String(DEFAULT_SETTINGS.minTtmGrowth),
  "min-quarter-growth": String(DEFAULT_SETTINGS.minQuarterGrowth),
  "max-lag-sessions": "2",
  // 刷新触发用「日历天」，判断新鲜度用「交易日」。默认 1 天：
  // 只要缓存不是今天/昨天的，就联网对齐一次，避免 5 个交易日前的数据被当成本日行情。
  "stale-days": "1",
  "timeout-ms": "20000",
  "concurrency": "6",
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
const allowUnconfirmed = flag("--allow-unconfirmed-bounce");

const number = (key, min = -Infinity) => {
  const value = Number(config[key]);
  if (!Number.isFinite(value) || value < min) throw new Error(`--${key} 需要 >= ${min} 的数字，收到 ${config[key]}`);
  return value;
};

const settings = {
  ...DEFAULT_SETTINGS,
  topN: Math.trunc(number("top-n", 1)),
  minMembers: Math.trunc(number("min-members", 1)),
  minMarketCap: number("min-market-cap", 0),
  minDrawdown: number("min-drawdown", 0),
  rsiOverbought: number("rsi-overbought"),
  maxPercentileSevere: number("max-percentile-severe", 0),
  maxPercentileMild: number("max-percentile-mild", 0),
  minTtmGrowth: number("min-ttm-growth"),
  minQuarterGrowth: number("min-quarter-growth"),
  requireBounceConfirm: !allowUnconfirmed,
  maxLagSessions: Math.trunc(number("max-lag-sessions", 0)),
  staleDays: Math.trunc(number("stale-days", 0)),
  timeoutMs: Math.trunc(number("timeout-ms", 1000)),
  concurrency: Math.trunc(number("concurrency", 1)),
};
if (settings.maxPercentileMild < settings.maxPercentileSevere) {
  throw new Error("--max-percentile-mild 不能小于 --max-percentile-severe");
}

const paths = {
  klineDir: resolve(root, config["kline-dir"]),
  incomeDir: resolve(root, config["income-dir"]),
  snapshotCacheDir: resolve(root, config["snapshot-cache-dir"]),
  credentialStore: resolve(root, config["credential-store"]),
  mappings: resolve(root, config.mappings),
  outDir: resolve(root, config["out-dir"]),
};

const industries = config.industry ? String(config.industry).split(",").map((value) => value.trim()).filter(Boolean) : [];

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
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const mappings = readJson(paths.mappings) ?? {};
  const notes = [];

  // 1. 全 A 股行业快照 → 行业内 Top N
  const snapshot = await fetchIndustrySnapshot({
    cacheDir: paths.snapshotCacheDir,
    maxAgeMs: offline ? Number.POSITIVE_INFINITY : 6 * 3600_000,
  });
  if (snapshot.fromCache) notes.push("行业快照来自本地缓存；要强制刷新请加 --no-snapshot-cache 或删除缓存目录");
  const selection = selectIndustryLeaders(snapshot.rows, {
    topN: settings.topN,
    minMembers: settings.minMembers,
    minMarketCap: settings.minMarketCap,
    industries,
  });
  let tracks = selection.tracks;
  if (industries.length) {
    const found = new Set(tracks.map((track) => track.industry));
    const missing = industries.filter((name) => !found.has(name));
    if (missing.length) notes.push(`指定的行业未找到或样本不足：${missing.join("、")}`);
  }
  if (Number(config["limit-tracks"]) > 0) {
    // 按行业总市值排序，只取前 N 个行业，用于快速试跑
    const limit = Math.trunc(Number(config["limit-tracks"]));
    tracks = [...tracks]
      .sort((left, right) => sum(right.leaders) - sum(left.leaders))
      .slice(0, limit);
    notes.push(`--limit-tracks=${limit}：只分析了总市值最大的 ${tracks.length} 个行业`);
  }
  if (!tracks.length) throw new Error("没有可分析的行业：请放宽 --min-members / --min-market-cap 或检查 --industry");

  const leaderRows = tracks.flatMap((track) => track.leaders);
  const codes = [...new Set(leaderRows.map((row) => row.code))];

  // 2. 每只龙头：K线（雪球）+ 利润表（东财，带缓存）
  const results = await pool(leaderRows, settings.concurrency, async (leader) => {
    const track = tracks.find((item) => item.industry === leader.industry);
    const kline = await ensureKline(leader.code);
    const rows = kline.rows ?? [];
    const blocked = [];
    if (kline.fetchError && kline.fetchError !== "offline" && !kline.fetched) {
      blocked.push(`行情刷新失败：${kline.fetchError}`);
    }

    let fin;
    try {
      const income = await fetchIncomeRows(leader.code, {
        family: reportFamily(leader.code, mappings),
        cacheDir: paths.incomeDir,
        maxAgeMs: offline ? Number.POSITIVE_INFINITY : 7 * 86_400_000,
        offline,
      });
      fin = buildFinancialSummary(income.rows, rows.at(-1)?.date ?? todayUtc());
    } catch (error) {
      fin = { available: false, reason: error instanceof Error ? error.message : String(error) };
    }

    const item = buildCandidate(
      {
        code: leader.code,
        name: leader.name,
        industry: leader.industry,
        industryRank: leader.industryRank,
        industryMembers: track?.memberCount ?? null,
        marketCap: leader.marketCap,
        close: leader.close ?? rows.at(-1)?.close ?? null,
        quoteDate: rows.at(-1)?.date ?? null,
        quoteSource: kline.source,
        layer: track?.layer,
      },
      { rows, financialRows: fin, blocked },
    );
    const verdict = evaluateCandidate(item, settings);
    return {
      ...item,
      ...verdict,
      // 最近若干根K线的日期，用于事后按「交易日」而不是日历天判断新鲜度
      recentDates: rows.slice(-30).map((row) => row.date),
      klineSessions: rows.length,
      quoteError: kline.fetchError,
      fetchError: kline.fetchError,
    };
  });

  // 2.1 行情新鲜度：用本次全样本的交易日历，而不是「日历天数 vs 今天」。
  // 停牌、长假、单只票缺几天都会让日历天数失真；交易日口径才对齐真实盘口。
  applyFreshness(results, settings, notes);

  const ordered = [...results].sort((left, right) => {
    const rank = (item) => STATUS_ORDER.indexOf(item.status);
    return rank(left) - rank(right) || (right.score ?? -1) - (left.score ?? -1) || (right.marketCap ?? 0) - (left.marketCap ?? 0);
  });

  const byStatus = ordered.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    disclaimer: "研究筛选，不是目标价、不是买卖指令、不构成收益预测；历史分位便宜不等于内在低估。",
    inputs: {
      universe: "全 A 股（东财行业快照）",
      snapshotFetchedAt: new Date(snapshot.fetchedAt).toISOString(),
      snapshotFromCache: snapshot.fromCache,
      industryFilter: industries,
      klineSource: "xueqiu",
      financialSource: "eastmoney_f10",
      offline,
      cacheWritten: writeCache && !offline,
    },
    settings,
    counts: {
      industries: tracks.length,
      leaders: ordered.length,
      snapshotRows: snapshot.rows.length,
      byStatus,
      fetch: {
        fromNetwork: results.filter((item) => item.quoteSource?.includes("xueqiu")).length,
        failed: results.filter((item) => item.quoteError && item.quoteError !== "offline").length,
        stale: results.filter((item) => item.quoteStale).length,
        blocked: results.filter((item) => item.status === "blocked").length,
      },
    },
    notes: [...notes, ...selection.warnings],
    industries: tracks.map((track) => ({
      industry: track.industry,
      memberCount: track.memberCount,
      layer: track.layer.label,
      leaders: track.leaders.map((leader) => ({
        code: leader.code,
        name: leader.name,
        marketCap: leader.marketCap,
        industryRank: leader.industryRank,
      })),
    })),
    results: ordered.map(serialize),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
  }
  if (writeReport || asJson) {
    const base = resolve(paths.outDir, `全A行业龙头超跌筛选_${todayUtc()}`);
    writeJsonAtomic(`${base}.json`, report);
    if (writeReport && !asJson) writeFileSync(`${base}.md`, `${renderMarkdown(report)}\n`);
    if (!asJson) console.log(`\n已写入：${base}.json`);
  }
  if (strictFresh && report.counts.fetch.stale > 0) {
    console.error(`\n--strict-fresh：仍有 ${report.counts.fetch.stale} 只票的行情没刷新到最新，退出码 2`);
    process.exit(2);
  }
}

const sum = (rows) => rows.reduce((total, row) => total + (row.marketCap ?? 0), 0);

/**
 * 用本次样本的交易日历给每只票标「落后几个交易日」。
 * - frontier = 样本里最新的K线日期（市场盘口前沿），不是日历上的今天
 * - lag = 该票最后K线距离 frontier 的交易日数
 * - 停牌不当作数据缺陷，但会显式标出来，避免把「停牌」误读成「便宜」
 */
function applyFreshness(results, settings, notes) {
  const calendar = [...new Set(results.flatMap((item) => item.recentDates ?? []))].sort();
  const frontier = calendar.at(-1) ?? null;
  const positionOf = new Map(calendar.map((date, index) => [date, index]));
  const frontierIndex = frontier ? positionOf.get(frontier) : -1;

  for (const item of results) {
    const date = item.quoteDate ?? null;
    const index = date ? positionOf.get(date) : undefined;
    // 超出 30 根窗口的老数据，按「远落后」处理，不给精确数字
    const lag = index === undefined || frontierIndex < 0 ? null : frontierIndex - index;
    item.sessionsBehind = lag;
    item.quoteStale = item.klineSessions >= 260 && (lag === null ? true : lag > settings.maxLagSessions);
    if (item.quoteStale && !item.blocked.some((reason) => reason.includes("行情"))) {
      item.blocked = [...item.blocked, lag === null
        ? `行情过旧（最后K线 ${date ?? "—"}，早于本次交易日历窗口）`
        : `行情未刷新（最后K线 ${date}，落后 ${lag} 个交易日）`];
      if (item.status !== "blocked") item.status = "blocked";
      item.score = null;
    }
  }

  if (frontier) {
    const frontierLagDays = daysBetween(frontier, todayUtc());
    notes.push(`行情前沿：${frontier}（本次样本最新K线；距今 ${frontierLagDays ?? "—"} 个日历日）`);
    if (frontierLagDays !== null && frontierLagDays > 7) {
      notes.push(`⚠ 整个样本的行情前沿已落后 ${frontierLagDays} 天，请刷新K线缓存（去掉 --offline）后再做判断`);
    }
    const staleCount = results.filter((item) => item.quoteStale).length;
    if (staleCount) notes.push(`有 ${staleCount} 只票的行情落后超过 ${settings.maxLagSessions} 个交易日（可能停牌或缓存未更新），已标为缺数据`);
  }
}

function serialize(item) {
  return {
    code: item.code,
    name: item.name,
    industry: item.industry,
    industryRank: item.industryRank,
    industryMembers: item.industryMembers,
    layer: item.layer?.label ?? null,
    marketCap: item.marketCap ?? null,
    close: item.tech?.close ?? item.close ?? null,
    quoteDate: item.quoteDate ?? null,
    quoteSource: item.quoteSource ?? null,
    quoteStale: Boolean(item.quoteStale),
    sessionsBehind: item.sessionsBehind ?? null,
    status: item.status,
    failures: item.failures ?? [],
    blocked: item.blocked ?? [],
    score: item.score ?? null,
    weak: item.weak ?? null,
    valuation: item.valuation ?? null,
    earnings: item.earnings ?? null,
    bounce: item.bounce ?? null,
    quotes: {
      peTtm: item.quotes?.peTtm ?? null,
      pb: item.quotes?.pb ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# 全 A 行业龙头「超跌 + 估值合理 + 反弹条件」筛选 — ${report.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`> ${report.disclaimer}`);
  lines.push("");
  lines.push(`- 样本：${report.counts.snapshotRows} 只 A 股（东财行业快照，${report.inputs.snapshotFromCache ? "本地缓存" : "本次拉取"}）→ ${report.counts.industries} 个行业 → 行业 Top${report.settings.topN} 共 ${report.counts.leaders} 只`);
  lines.push(`- 行业门槛：每行业至少 ${report.settings.minMembers} 只达标成员，成员总市值 ≥ ${(report.settings.minMarketCap / 1e8).toFixed(0)} 亿；排除 ST/退市风险`);
  lines.push(`- 价格来源：雪球日K（前复权）；财务：东财 F10。行情未刷新 ${report.counts.fetch.stale} 只，刷新失败 ${report.counts.fetch.failed} 只，缺数据 ${report.counts.fetch.blocked} 只`);
  lines.push(`- 口径：252 日回撤 ≤ -${pct(report.settings.minDrawdown, 0)}、120 日下跌、RSI14 < ${report.settings.rsiOverbought}；PE/PB 5 年分位严格档 ≤ ${pct(report.settings.maxPercentileSevere, 0)}、宽松档 ≤ ${pct(report.settings.maxPercentileMild, 0)}；TTM 利润同比 ≥ ${pct(report.settings.minTtmGrowth, 0)}，最新单季同比 ≥ ${pct(report.settings.minQuarterGrowth, 0)}${report.settings.requireBounceConfirm ? "；必须有止跌/修复的确认信号" : ""}`);
  lines.push("");

  const bucket = (status) => report.results.filter((item) => item.status === status);
  lines.push("## 零、摘要");
  lines.push("");
  const passes = bucket("bounce-watch");
  lines.push(`**四关全过 ${passes.length} 只。** 各状态数量：${STATUS_ORDER.filter((key) => report.counts.byStatus[key]).map((key) => `${STATUS_LABEL[key]} ${report.counts.byStatus[key]}`).join(" · ") || "无"}。`);
  lines.push("");

  lines.push("## 一、候选清单（先看这组）");
  lines.push("");
  lines.push("四关全过：行业龙头 + 弱势 + 估值不贵 + 盈利未恶化 + 至少一个**确认**性质的止跌/修复信号。");
  lines.push("");
  if (passes.length === 0) {
    lines.push("**本次没有四关全过的标的。** 这不是「没机会」，而是「用这套纪律现在没有机会」；下面按差哪一关分组列出原因。");
    lines.push("");
  } else {
    lines.push("| 行业 | 分 | 代码 | 名称 | 行业排名 | 回撤252d | 120d | RSI14 | PE(TTM) | PE分位 | PB | PB分位 | TTM利润同比 | 单季同比 | 反弹信号 |");
    lines.push("| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const item of passes) lines.push(tableRow(item));
    lines.push("");
  }

  const sections = [
    ["no-trigger", "估值、盈利、弱势都符合，但价格还没给出任何止跌/修复信号（等确认，不猜底）"],
    ["tight-wait-trigger", "只有次级估值指标超过严格档、其余都符合（结论依赖口径，谨慎）"],
    ["expensive", "跌得多、盈利也还在，但严格口径下估值不便宜（等价格或等业绩）"],
    ["weak-quarter", "TTM 利润还是正的，但最近一个单季同比明显转差（滚动口径掩盖了最新季度，先剔除）"],
    ["weak-earnings", "价格便宜但盈利在恶化（低 PE 不等于低估，本轮剔除）"],
    ["not-weak", "估值与盈利都可以，但没有满足「弱势」条件（不适合当超跌反弹）"],
    ["watch", "多关未过（只留档，不做优先研究）"],
    ["blocked", "数据不够，未做判断"],
  ];
  const numerals = ["二", "三", "四", "五", "六", "七", "八", "九", "十"];
  let index = 0;
  for (const [status, title] of sections) {
    const items = bucket(status);
    if (!items.length) continue;
    lines.push(`## ${numerals[index] ?? index + 2}、${title}`);
    lines.push("");
    index += 1;
    for (const item of items.slice(0, 40)) {
      lines.push(`- **${item.name}**（${item.code}，${item.industry}，行业第 ${item.industryRank} / ${item.industryMembers} 只）— 分 ${item.score ?? "—"}`);
      lines.push(`  - ${summaryOf(item)}`);
    }
    if (items.length > 40) lines.push(`- ……另有 ${items.length - 40} 只同状态标的，见 JSON 输出`);
    lines.push("");
  }

  lines.push("## 行业 Top N 全景");
  lines.push("");
  lines.push("| 行业 | 排名 | 代码 | 名称 | 市值(亿元) | 状态 | 分 |");
  lines.push("| --- | ---: | --- | --- | ---: | --- | ---: |");
  const byCode = new Map(report.results.map((item) => [item.code, item]));
  for (const group of report.industries) {
    for (const leader of group.leaders) {
      const result = byCode.get(leader.code);
      lines.push(`| ${group.industry} | ${leader.industryRank} | ${leader.code} | ${leader.name} | ${(leader.marketCap / 1e8).toFixed(0)} | ${STATUS_LABEL[result?.status] ?? result?.status ?? "—"} | ${result?.score ?? "—"} |`);
    }
  }
  lines.push("");

  if (report.notes?.length) {
    lines.push("## 数据提醒");
    lines.push("");
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push("## 局限");
  lines.push("");
  for (const line of [
    "- 行业分类用东财一级/二级行业名（如「半导体」「白酒Ⅱ」），只决定「谁是龙头」；跨行业估值不可直接比较。",
    "- 「龙头」= 行业内总市值前 N，不是市场份额或技术领先的证明。",
    "- PE/PB 分位是相对自身 5 年历史，周期股的 PE 分位会被盈利周期扭曲，必须按中枢利润复核。",
    "- 银行/保险/证券用 PB 主口径；房地产 PE 参考意义弱。",
    "- TTM 利润由东财累计报表滚动得到，最新单季由单季度家族或累计差得到；报告期以输出为准。",
    "- 「反弹信号」只是价格结构上的止跌迹象，不是基本面反转；`--allow-unconfirmed-bounce` 会放宽这一关。",
  ]) lines.push(line);
  return lines.join("\n");
}

function tableRow(item) {
  const pe = item.quotes?.peTtm ?? {};
  const pb = item.quotes?.pb ?? {};
  const weak = item.weak ?? {};
  const earn = item.earnings ?? {};
  const signals = [...(item.bounce?.confirm ?? [])].map((signal) => signal.label);
  return [
    item.industry,
    item.score ?? "—",
    item.code,
    item.name,
    item.industryRank,
    pct(weak.drawdown252),
    pct(weak.return120),
    ratio(weak.rsi14, 1),
    ratio(pe.current, 1),
    pct(pe.percentile, 0),
    ratio(pb.current, 2),
    pct(pb.percentile, 0),
    pct(earn.ttmGrowth),
    pct(earn.latestQuarterYoY),
    signals.join("；") || "—",
  ].join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function summaryOf(item) {
  if (item.status === "blocked") return `缺数据：${item.blocked.join("；")}`;
  const parts = [];
  const weak = item.weak ?? {};
  parts.push(`252d 回撤 ${pct(weak.drawdown252)}，120d ${pct(weak.return120)}，RSI14 ${ratio(weak.rsi14, 1)}`);
  const valuation = item.valuation ?? {};
  const metrics = (valuation.metrics ?? []).map((entry) => `${entry.key === "peTtm" ? "PE" : "PB"} ${pct(entry.percentile, 0)}`).join("、");
  if (metrics) parts.push(`5年分位 ${metrics}`);
  if (valuation.breaches?.length) parts.push(`超出严格档：${valuation.breaches.map((entry) => `${entry.key} ${pct(entry.percentile, 0)}`).join("、")}`);
  if (valuation.note) parts.push(valuation.note);
  const earn = item.earnings ?? {};
  if (earn.ttmGrowth !== null && earn.ttmGrowth !== undefined) parts.push(`TTM 利润同比 ${pct(earn.ttmGrowth)}（${earn.reportDate ?? "—"}）`);
  if (earn.latestQuarterYoY !== null && earn.latestQuarterYoY !== undefined) parts.push(`最新单季同比 ${pct(earn.latestQuarterYoY)}（${earn.latestQuarterDate}）`);  if (item.bounce?.confirm?.length) parts.push(`确认信号：${item.bounce.confirm.map((signal) => signal.label).join("；")}`);
  if (item.bounce?.watch?.length) parts.push(`观察信号：${item.bounce.watch.map((signal) => signal.label).join("；")}`);
  if (item.quoteStale) parts.push(`⚠ 行情截至 ${item.quoteDate}`);
  return parts.join("；");
}

function helpText() {
  return `全 A 行业龙头超跌筛选（研究用途，不是买卖指令）

node scripts/analyze-a-share-industry-leaders.mjs [选项]

  --json                    输出 JSON（同时写 reports/research/*.json）
  --write-report            同时写 Markdown 报告
  --offline                 只用本地缓存，绝不联网
  --no-write-cache          拉到的新K线/财报不回写缓存
  --strict-fresh            仍有行情未到最新时退出码 2
  --allow-unconfirmed-bounce  放宽「必须有确认信号」这一关（默认需要）
  --industry 半导体,白酒Ⅱ    只分析指定行业（逗号分隔，东财行业名）
  --limit-tracks 5          按总市值只取前 N 个行业（快速试跑）
  --top-n 3                 每行业取前 N 只龙头，默认 3
  --min-members 3           行业达标成员少于该值则跳过，默认 3
  --min-market-cap 5e9      成员总市值门槛（元），默认 50 亿
  --min-drawdown 0.25       相对 252 日最高收盘价的回撤门槛（正数）
  --rsi-overbought 60       RSI14 高于此值视为已反弹、不追
  --max-percentile-severe 0.20   严格档：所有权重指标 5 年分位须 ≤ 此值
  --max-percentile-mild 0.35     宽松档：主指标 ≤ severe 且次级指标 ≤ mild
  --min-ttm-growth 0.00    TTM 利润同比下限
  --min-quarter-growth -0.3  最新单季利润同比下限（防止 TTM 掩盖单季转差）
  --max-lag-sessions 2      K线落后最新交易日超过几个交易日算「未刷新」
  --stale-days 1            缓存日历天数阈值（超过就联网刷新；离线模式忽略）
  --concurrency 6           雪球/东财并发
  --snapshot-cache-dir     行业快照缓存目录
  --credential-store       雪球 Cookie 文件
  --mappings               shared/finance-mappings.json（银行/券商/保险报表家族）

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
