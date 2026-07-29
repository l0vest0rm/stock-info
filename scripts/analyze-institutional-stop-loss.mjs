#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const baseUrl = args["base-url"] ?? "https://tinfo.cc";
const reportDate = args["report-date"] ?? "2026-06-30";
const asOf = args["as-of"] ?? new Date().toISOString().slice(0, 10);
const from = args.from ?? shiftYear(asOf, -1);
const output = path.resolve(args.output ?? `docs/research/机构重仓股止损分析-${reportDate}.md`);
const csvOutput = output.replace(/\.md$/i, ".csv");

const holdings = (
  await Promise.all([1, 2].map((page) => fetchData("/api/companies/holding/rank", {
    date: reportDate,
    type: "0",
    rank: "HOLD_VALUE",
    page: String(page),
  })))
).flat().slice(0, 100);

if (holdings.length !== 100) {
  throw new Error(`expected 100 holding rows, received ${holdings.length}`);
}
if (new Set(holdings.map((row) => row.SECUCODE)).size !== 100) {
  throw new Error("holding ranking contains duplicate security codes");
}
if (holdings.some((row, index) => index > 0 && Number(row.HOLD_VALUE) > Number(holdings[index - 1].HOLD_VALUE))) {
  throw new Error("holding ranking is not sorted by HOLD_VALUE descending");
}

const analyzed = await mapConcurrent(holdings, 6, async (holding, index) => {
  const rows = await fetchData("/api/kline", {
    code: holding.SECUCODE,
    period: "day",
    fq: "qfq",
    from,
    to: asOf,
  });
  return analyzeHolding(holding, rows, index + 1);
});

const report = renderReport(analyzed);
await writeFile(output, report, "utf8");
await writeFile(csvOutput, renderCsv(analyzed), "utf8");
console.log(JSON.stringify({ output, csvOutput, holdings: analyzed.length, reportDate, asOf }, null, 2));

function analyzeHolding(holding, rawRows, rank) {
  const rows = rawRows
    .map((row) => ({
      date: new Date(row[0]).toISOString().slice(0, 10),
      close: finite(row[1]),
      open: finite(row[2]),
      high: finite(row[3]),
      low: finite(row[4]),
    }))
    .filter((row) => row.close > 0 && row.high > 0 && row.low > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (rows.length < 65) {
    throw new Error(`${holding.SECUCODE} has only ${rows.length} usable kline rows`);
  }

  const close = rows.at(-1).close;
  const closes = rows.map((row) => row.close);
  const ma20 = average(closes.slice(-20));
  const ma60 = average(closes.slice(-60));
  const ma20FiveDaysAgo = average(closes.slice(-25, -5));
  const ret5 = percentChange(close, closes.at(-6));
  const ret20 = percentChange(close, closes.at(-21));
  const ret60 = percentChange(close, closes.at(-61));
  const high60 = Math.max(...closes.slice(-60));
  const drawdown60 = percentChange(close, high60);
  const atr = average(trueRanges(rows).slice(-14));
  const atrPct = atr / close * 100;
  const prior20Low = Math.min(...rows.slice(-21, -1).map((row) => row.low));
  const broke20Low = close < prior20Low;
  const consecutiveDown = countConsecutiveDown(closes);
  const signals = [
    close < ma20,
    ma20 < ma60,
    ma20 < ma20FiveDaysAgo,
    ret20 < 0,
    drawdown60 <= -10,
    broke20Low,
  ];
  const riskScore = signals.filter(Boolean).length;
  const risk = riskScore >= 5 ? "高风险" : riskScore >= 3 ? "下跌" : riskScore >= 1 ? "转弱" : "稳健";
  const atrMultiple = riskScore >= 5 ? 1.5 : riskScore >= 3 ? 2 : riskScore >= 1 ? 2.5 : 3;
  const volatilityStop = close - atrMultiple * atr;
  const supportStop = prior20Low - 0.5 * atr;
  const stopPrice = Math.max(volatilityStop, supportStop);
  const stopDistancePct = (stopPrice / close - 1) * 100;
  const action = broke20Low
    ? `已触发20日低点；若下一收盘仍低于${formatPrice(prior20Low)}，减仓/退出`
    : `${riskScore >= 5 ? "优先降仓；" : ""}收盘跌破${formatPrice(stopPrice)}执行止损`;

  return {
    rank,
    code: holding.SECUCODE,
    name: holding.SECURITY_NAME_ABBR,
    institutionCount: Number(holding.HOULD_NUM),
    holdValueYi: Number(holding.HOLD_VALUE) / 1e8,
    holdChange: holding.HOLDCHA ?? "—",
    rows: rows.length,
    firstDate: rows[0].date,
    priceDate: rows.at(-1).date,
    close,
    ret5,
    ret20,
    ret60,
    drawdown60,
    ma20,
    ma60,
    atrPct,
    prior20Low,
    broke20Low,
    consecutiveDown,
    riskScore,
    risk,
    stopPrice,
    stopDistancePct,
    action,
  };
}

function renderReport(rows) {
  const counts = Object.fromEntries(["高风险", "下跌", "转弱", "稳健"].map((risk) => [risk, rows.filter((row) => row.risk === risk).length]));
  const declining = rows.filter((row) => row.risk === "高风险" || row.risk === "下跌");
  const triggered = rows.filter((row) => row.broke20Low);
  const median20 = median(rows.map((row) => row.ret20));
  const medianDrawdown = median(rows.map((row) => row.drawdown60));
  const medianAtr = median(rows.map((row) => row.atrPct));
  const highestRisk = [...rows].sort((a, b) => b.riskScore - a.riskScore || a.ret20 - b.ret20).slice(0, 15);
  const coverageStart = rows.map((row) => row.firstDate).sort().at(-1);
  const coverageEnd = rows.map((row) => row.priceDate).sort().at(0);
  const reportLines = [
    `# 机构重仓股持续下跌与止损分析（${reportDate}）`,
    "",
    `> 生成日期：${asOf}；持仓报告期：${reportDate}；共同可比行情截止：${coverageEnd}。本报告是量化风险研究，不构成个性化投资建议。`,
    "",
    "## 结论摘要",
    "",
    `- 100 只样本中，高风险 ${counts["高风险"]} 只、处于下跌 ${counts["下跌"]} 只、转弱 ${counts["转弱"]} 只、稳健 ${counts["稳健"]} 只；合计 ${declining.length} 只已形成较明确的短中期弱势。`,
    `- ${triggered.length} 只收盘价已经跌破此前 20 个交易日最低价。对这组股票，继续向下“挪动止损线”会失去纪律意义，规则应改为观察下一交易日能否收回原 20 日低点；不能收回则执行减仓或退出。`,
    `- 样本近 20 日收益中位数为 ${formatPct(median20)}，距 60 日最高收盘价的回撤中位数为 ${formatPct(medianDrawdown)}，14 日 ATR 中位数为股价的 ${formatPct(medianAtr, false)}。统一使用固定 5% 止损会对高波动股过紧、对低波动股过松。`,
    "- 机构持仓市值高只说明公开资金暴露较大，不构成价格托底。季度披露存在时滞；止损判断以实时价格破位为主，机构榜单只用于定义样本。",
    "",
    "## 建议采用的止损纪律",
    "",
    "1. 每日只按收盘价确认，避免盘中假跌破；但遇到跌停、重大基本面恶化或交易计划明确要求硬止损时，不等待收盘。",
    "2. 正常参考线取两者较高者：`前20日最低价 - 0.5×ATR14` 与 `当前价 - N×ATR14`。风险分数 5–6 使用 N=1.5，3–4 使用 N=2，1–2 使用 N=2.5，0 使用 N=3。该线只用于本次分析日首次设定；设定后必须冻结并只上移，不能在后续下跌中按新现价重新下调。",
    "3. 已跌破前 20 日低点：下一收盘仍未收回该位置，至少减半；同时满足“价低于 MA20、MA20 低于 MA60、MA20 下行”的高风险股，优先退出，不用补仓摊薄成本。",
    "4. 单笔最大可承受亏损先固定为账户权益的 0.5%–1%。仓位上限 = 可承受亏损金额 ÷（买入价 − 止损价）；如果计算出的仓位过小，说明该股波动不适合当前账户。",
    "5. 盈利仓使用跟踪止损，只上移不下移；亏损仓不得因为“机构重仓”放宽止损。财报、减持、监管或行业逻辑变化属于基本面止损，应覆盖技术价位。",
    "",
    "## 当前风险最高的 15 只",
    "",
    "|排名|股票|机构数|风险分|近20日|60日回撤|ATR14|20日低点状态|执行建议|",
    "|---:|---|---:|---:|---:|---:|---:|---|---|",
    ...highestRisk.map((row) => `|${row.rank}|${row.name} ${row.code}|${row.institutionCount}|${row.riskScore}/6|${formatPct(row.ret20)}|${formatPct(row.drawdown60)}|${formatPct(row.atrPct, false)}|${row.broke20Low ? "已跌破" : "未跌破"}|${row.action}|`),
    "",
    "## 100 只逐股结果",
    "",
    "|排名|股票|机构数|持仓市值(亿)|收盘/日期|近5日|近20日|近60日|60日回撤|连续下跌日|风险|参考止损|建议|",
    "|---:|---|---:|---:|---|---:|---:|---:|---:|---:|---|---:|---|",
    ...rows.map((row) => `|${row.rank}|${row.name} ${row.code}|${row.institutionCount}|${row.holdValueYi.toFixed(1)}|${formatPrice(row.close)} / ${row.priceDate}|${formatPct(row.ret5)}|${formatPct(row.ret20)}|${formatPct(row.ret60)}|${formatPct(row.drawdown60)}|${row.consecutiveDown}|${row.risk} ${row.riskScore}/6|${row.broke20Low ? "已触发" : `${formatPrice(row.stopPrice)} (${formatPct(row.stopDistancePct)})`}|${row.action}|`),
    "",
    "## 口径与限制",
    "",
    `- 样本：仓库接口 \`${baseUrl}/api/companies/holding/rank\`，报告期 ${reportDate}，全机构汇总（type=0），按持仓市值 HOLD_VALUE 降序取前 100；HOULD_NUM 仅作为机构/产品覆盖数量的辅助字段。`,
    `- 行情：仓库接口 \`${baseUrl}/api/kline\`，日线、前复权（qfq），请求区间 ${from} 至 ${asOf}；100 只股票实际共同覆盖至少 ${coverageStart} 至 ${coverageEnd}，每只至少 ${Math.min(...rows.map((row) => row.rows))} 根有效日 K。`,
    "- 风险分共 6 项：收盘低于 MA20、MA20 低于 MA60、MA20 五日斜率向下、近20日收益为负、距60日高点回撤至少10%、跌破此前20日低点。分数 5–6 为高风险、3–4 为下跌、1–2 为转弱、0 为稳健。",
    "- “参考止损”是分析日首次建立的下一步风控触发价，不是预测的最低价，也未考虑个人成本价、税费、滑点、跌停无法成交及盘中流动性。此后只能上移；已触发的股票不再给出低于现价的新止损价，以免形成无限下移。",
    "- 季度机构持仓是滞后披露，报告日后的增减仓不可见；榜单随披露进度或上游修订可能变化。",
    "",
    `逐股机器可读数据见同名 CSV：\`${path.basename(csvOutput)}\`。`,
    "",
  ];
  return reportLines.join("\n");
}

function renderCsv(rows) {
  const fields = ["rank", "code", "name", "institutionCount", "holdValueYi", "priceDate", "close", "ret5", "ret20", "ret60", "drawdown60", "ma20", "ma60", "atrPct", "prior20Low", "broke20Low", "consecutiveDown", "riskScore", "risk", "stopPrice", "stopDistancePct", "action"];
  return [fields.join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n") + "\n";
}

async function fetchData(route, params) {
  const url = new URL(route, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      const body = await response.json();
      if (body.code !== 200 || !Array.isArray(body.data)) throw new Error(`invalid response from ${url}`);
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function trueRanges(rows) {
  return rows.map((row, index) => index === 0
    ? row.high - row.low
    : Math.max(row.high - row.low, Math.abs(row.high - rows[index - 1].close), Math.abs(row.low - rows[index - 1].close)));
}

function countConsecutiveDown(closes) {
  let count = 0;
  for (let index = closes.length - 1; index > 0 && closes[index] < closes[index - 1]; index -= 1) count += 1;
  return count;
}

function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return (sorted[49] + sorted[50]) / 2; }
function percentChange(value, base) { return (value / base - 1) * 100; }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function formatPrice(value) { return value >= 100 ? value.toFixed(2) : value >= 10 ? value.toFixed(3) : value.toFixed(4); }
function formatPct(value, signed = true) { return `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}%`; }
function shiftYear(date, amount) { const [year, tail] = date.split(/-(.*)/s); return `${Number(year) + amount}-${tail}`; }
function csvCell(value) { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) throw new Error(`unexpected argument: ${values[index]}`);
    parsed[values[index].slice(2)] = values[++index];
  }
  return parsed;
}
