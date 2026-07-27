import { stat } from "node:fs/promises";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function latestQuarterlyReportDate(asOf) {
  assertDate(asOf, "as-of");
  const [year, month] = asOf.split("-").map(Number);
  if (month <= 3) return `${year - 1}-09-30`;
  if (month <= 6) return `${year}-03-31`;
  if (month <= 9) return `${year}-06-30`;
  return `${year}-09-30`;
}

export function previousReportDate(reportDate) {
  assertDate(reportDate, "report-date");
  const [year, month, day] = reportDate.split("-").map(Number);
  if (month === 3 && day === 31) return `${year - 1}-12-31`;
  if (month === 6 && day === 30) return `${year}-03-31`;
  if (month === 9 && day === 30) return `${year}-06-30`;
  throw new Error(`unsupported quarterly report date: ${reportDate}`);
}

export function quarterId(reportDate) {
  assertDate(reportDate, "report-date");
  const [year, month] = reportDate.split("-");
  const quarter = { "03": "Q1", "06": "Q2", "09": "Q3", "12": "Q4" }[month];
  if (!quarter) throw new Error(`unsupported quarter month: ${reportDate}`);
  return `${year}${quarter}`;
}

export function parseFundRankRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!Array.isArray(row) || row.length < 10) return [];
    const code = String(row[1] ?? "").trim();
    const name = stripHtml(String(row[2] ?? "")).trim();
    if (!/^\d{6}$/.test(code) || !name) return [];
    return [{
      rank: number(row[0]),
      code,
      name,
      navDate: String(row[3] ?? "").slice(0, 10),
      dailyReturnPct: nullableNumber(row[6]),
      oneWeekReturnPct: nullableNumber(row[7]),
      oneMonthReturnPct: nullableNumber(row[8]),
      threeMonthReturnPct: nullableNumber(row[9]),
      sixMonthReturnPct: nullableNumber(row[10]),
      oneYearReturnPct: nullableNumber(row[11]),
    }];
  });
}

export function dedupeFundShareClasses(funds, priority = ["A", "B", "C", ""]) {
  const grouped = new Map();
  for (const fund of funds) {
    const shareClass = fundShareClass(fund.name);
    const baseName = fundBaseName(fund.name);
    const key = normalizeFundGroupName(baseName);
    const candidate = { ...fund, baseName, shareClass };
    const current = grouped.get(key);
    if (!current || compareShareClassCandidate(candidate, current, priority) < 0) {
      grouped.set(key, candidate);
    }
  }
  return [...grouped.values()].sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
}

export function fundShareClass(name) {
  return String(name).trim().match(/([ABC])(?:类)?$/i)?.[1]?.toUpperCase() ?? "";
}

export function fundBaseName(name) {
  return String(name).trim().replace(/(?:[ABC])(?:类)?$/i, "").trim();
}

export function findFundReportNotice(notices, fundCode, reportDate) {
  const [year, month] = reportDate.split("-");
  const quarter = { "03": "1", "06": "2", "09": "3" }[month];
  const quarterlyPattern = quarter ? new RegExp(`${year}\\s*年?\\s*第?\\s*${quarter}\\s*季度报告`) : null;
  const annualPattern = month === "12" ? new RegExp(`${year}\\s*年(?:年度|年)报告`) : null;
  return (Array.isArray(notices) ? notices : [])
    .filter((item) => String(item.FUNDCODE ?? fundCode).trim() === fundCode)
    .filter((item) => !/(提示性公告|摘要|更新招募说明书)/.test(String(item.TITLE ?? "")))
    .find((item) => quarterlyPattern?.test(compactText(item.TITLE)) || annualPattern?.test(compactText(item.TITLE))) ?? null;
}

export function mapNotice(item, fundCode) {
  const id = String(item?.ID ?? "").trim();
  return {
    id,
    fundCode: String(item?.FUNDCODE ?? fundCode).trim() || fundCode,
    title: String(item?.TITLE ?? "").trim(),
    publishDate: String(item?.PUBLISHDATEDesc ?? "").slice(0, 10),
    detailUrl: id ? `https://fund.eastmoney.com/gonggao/${fundCode},${id}.html` : "",
    pdfUrl: id ? `https://pdf.dfcfw.com/pdf/H2_${id}_1.pdf` : "",
  };
}

export function parseFundTotalShares(reportText) {
  const matched = String(reportText).match(/报告期末基金份额总额\s*([\d,]+(?:\.\d+)?)\s*份/);
  return matched ? nullableNumber(matched[1]) : null;
}

export function extractManagementDiscussion(reportText, maxChars = 12_000) {
  const text = String(reportText ?? "").trim();
  if (!text) return "";
  const start = text.search(/4\.4(?:\.1)?\s*报告期内基金(?:的)?投资策略和运作分析/);
  const fallbackStart = text.search(/报告期内基金(?:的)?投资策略和运作分析/);
  const from = start >= 0 ? start : fallbackStart >= 0 ? fallbackStart : 0;
  const section = text.slice(from);
  const end = section.search(/§\s*5\s*投资组合报告/);
  return (end >= 0 ? section.slice(0, end) : section).slice(0, maxChars).trim();
}

export function selectDisclosedHoldings(holdings, reportText, limit = 10) {
  const rows = Array.isArray(holdings) ? holdings : [];
  const codes = extractTopHoldingBareCodes(reportText, limit);
  if (!codes.size) return rows.slice(0, limit);
  return rows.filter((holding) => codes.has(String(holding.code).split(".")[0].replace(/^A/i, "")));
}

export function extractTopHoldingBareCodes(reportText, limit = 10) {
  const text = String(reportText ?? "");
  const header = text.search(/前十名股票投资明细|所有股票投资明细/);
  if (header < 0) return new Set();
  const afterHeader = text.slice(header);
  const end = afterHeader.slice(1).search(/\n\s*5\.4\s/);
  const section = end >= 0 ? afterHeader.slice(0, end + 1) : afterHeader.slice(0, 20_000);
  const codes = new Set();
  for (const match of section.matchAll(/^\s*(\d+)\s+([A-Za-z]?\d{5,6})\s+/gm)) {
    if (Number(match[1]) <= limit) codes.add(match[2].replace(/^A/i, ""));
  }
  return codes;
}

export function normalizePositionPeriods(periods) {
  const byDate = new Map();
  for (const period of Array.isArray(periods) ? periods : []) {
    const reportDate = String(period?.updateDate ?? "").slice(0, 10);
    if (!DATE_PATTERN.test(reportDate) || byDate.has(reportDate)) continue;
    const holdings = (Array.isArray(period.data) ? period.data : []).flatMap((row) => {
      if (!Array.isArray(row) || row.length < 4) return [];
      const code = String(row[0] ?? "").trim();
      const name = String(row[1] ?? "").trim();
      if (!code || !name) return [];
      return [{ code, name, weightPct: number(row[2]), shares: number(row[3]) }];
    });
    byDate.set(reportDate, { reportDate, holdings });
  }
  return byDate;
}

export function analyzePositionChanges({
  currentHoldings,
  previousHoldings,
  currentFundShares,
  previousFundShares,
  returnsByCode,
  actionThresholdPct = 10,
  assessmentThresholdPct = 3,
}) {
  const current = new Map((currentHoldings ?? []).map((item) => [item.code, item]));
  const previous = new Map((previousHoldings ?? []).map((item) => [item.code, item]));
  const codes = [...new Set([...current.keys(), ...previous.keys()])];
  return codes.map((code) => {
    const currentItem = current.get(code) ?? null;
    const previousItem = previous.get(code) ?? null;
    const returns = returnsByCode?.[code] ?? {};
    const action = classifyAction({
      currentItem,
      previousItem,
      currentFundShares,
      previousFundShares,
      actionThresholdPct,
    });
    const averageWeightPct = ((currentItem?.weightPct ?? 0) + (previousItem?.weightPct ?? 0)) / 2;
    const periodReturnPct = nullableNumber(returns.periodReturnPct);
    const postReportReturnPct = nullableNumber(returns.postReportReturnPct);
    return {
      code,
      name: currentItem?.name ?? previousItem?.name ?? code,
      action: action.label,
      actionCode: action.code,
      perFundShareChangePct: action.perFundShareChangePct,
      previousWeightPct: previousItem?.weightPct ?? 0,
      currentWeightPct: currentItem?.weightPct ?? 0,
      periodReturnPct,
      postReportReturnPct,
      estimatedContributionPct: periodReturnPct === null ? null : round(averageWeightPct * periodReturnPct / 100),
      shortTermAssessment: assessAction(action.code, postReportReturnPct, assessmentThresholdPct),
    };
  }).sort((a, b) => b.currentWeightPct - a.currentWeightPct || b.previousWeightPct - a.previousWeightPct);
}

export function returnBetweenKlines(rows, startDate, endDate) {
  const points = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!Array.isArray(row) || row.length < 2) return [];
    const timestamp = Number(row[0]);
    const close = nullableNumber(row[1]);
    if (!Number.isFinite(timestamp) || close === null || close <= 0) return [];
    return [{ date: new Date(timestamp).toISOString().slice(0, 10), close }];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const start = points.filter((point) => point.date <= startDate).at(-1);
  const end = points.filter((point) => point.date <= endDate).at(-1);
  if (!start || !end) return null;
  return round((end.close / start.close - 1) * 100);
}

export function buildOutputFilename(fundName, fundCode, reportDate) {
  const safeName = String(fundName)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return `${safeName}-${fundCode}-${quarterId(reportDate)}.md`;
}

export function renderFundIndexMarkdown({ asOf, reportDate, quarter, funds, holdingsStatisticsFilename = "" }) {
  const rows = [...(funds ?? [])].sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
  const lines = [
    `# 基金季度分析索引（${quarter}）`,
    "",
    `> 数据截至：${asOf}；持仓报告期：${reportDate}；已生成报告：${rows.length} 只。`,
    "",
    ...(holdingsStatisticsFilename
      ? [`[查看跨基金持仓统计](./${encodeURI(holdingsStatisticsFilename)})`, ""]
      : []),
    "| 近3月排名 | 近3月收益 | 近1月收益 | 近6月收益 | 基金名称 | 代码 | 份额类别 | 净值日期 | 季报发布日期 | 分析报告 |",
    "|---:|---:|---:|---:|---|---|---|---|---|---|",
  ];
  for (const fund of rows) {
    const href = `./${encodeURI(fund.outputFilename)}`;
    lines.push(
      `| ${fund.rank} | ${formatIndexPercent(fund.threeMonthReturnPct)} | ${formatIndexPercent(fund.oneMonthReturnPct)} | ${formatIndexPercent(fund.sixMonthReturnPct)} | ${escapeTable(fund.name)} | ${fund.code} | ${fund.shareClass || "-"} | ${fund.navDate || "-"} | ${fund.reportPublishDate || "-"} | [查看](${href}) |`,
    );
  }
  if (!rows.length) lines.push("| - | - | - | - | 暂无已生成报告 | - | - | - | - | - |");
  lines.push(
    "",
    "## 口径",
    "",
    "- 排名和收益率来自本次运行的近三个月基金排名快照。",
    "- A/B/C 份额已按配置去重；排名保留所选份额在原始 Top 100 中的名次。",
    "- 列表只收录已经成功生成或此前已存在的单基金季度报告。",
    "",
  );
  return lines.join("\n");
}

export function aggregateCurrentFundHoldings(evidences) {
  const holdings = new Map();
  for (const evidence of Array.isArray(evidences) ? evidences : []) {
    const fund = evidence?.fund ?? {};
    const seen = new Set();
    for (const position of evidence?.positions?.current ?? []) {
      const code = String(position?.code ?? "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const current = holdings.get(code) ?? {
        code,
        name: String(position?.name ?? code).trim() || code,
        fundCount: 0,
        totalWeightPct: 0,
        averageWeightPct: 0,
        maxWeightPct: 0,
        funds: [],
      };
      const weightPct = nullableNumber(position?.weightPct) ?? 0;
      current.fundCount += 1;
      current.totalWeightPct += weightPct;
      current.maxWeightPct = Math.max(current.maxWeightPct, weightPct);
      current.funds.push({
        code: String(fund.code ?? ""),
        name: String(fund.name ?? fund.code ?? ""),
        rank: nullableNumber(fund.rank),
        weightPct,
      });
      holdings.set(code, current);
    }
  }
  return [...holdings.values()]
    .map((item) => ({
      ...item,
      totalWeightPct: round(item.totalWeightPct),
      averageWeightPct: round(item.totalWeightPct / item.fundCount),
      maxWeightPct: round(item.maxWeightPct),
      funds: item.funds.sort((a, b) => b.weightPct - a.weightPct || (a.rank ?? Infinity) - (b.rank ?? Infinity)),
    }))
    .sort((a, b) => b.fundCount - a.fundCount || b.totalWeightPct - a.totalWeightPct || a.code.localeCompare(b.code));
}

export function buildHoldingMarketSnapshot(rows, asOf, periods) {
  const points = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!Array.isArray(row) || row.length < 2) return [];
    const timestamp = Number(row[0]);
    const close = nullableNumber(row[1]);
    if (!Number.isFinite(timestamp) || close === null || close <= 0) return [];
    return [{ date: new Date(timestamp).toISOString().slice(0, 10), close }];
  }).filter((point) => point.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const latest = points.at(-1) ?? null;
  const performance = {};
  for (const period of periods ?? []) {
    performance[period.key] = latest ? returnBetweenKlines(rows, period.startDate, latest.date) : null;
  }
  return {
    price: latest?.close ?? null,
    priceDate: latest?.date ?? "",
    performance,
  };
}

export function aggregateReportForecasts(reportItems, { years, minYear, maxYears, currentPrice, marketCapYi }) {
  const selectedYears = Array.isArray(years) ? new Set(years.map(Number)) : null;
  const grouped = new Map();
  for (const report of Array.isArray(reportItems) ? reportItems : []) {
    const reportKey = String(report?.infoCode ?? report?.url ?? report?.title ?? "");
    for (const forecast of Array.isArray(report?.forecasts) ? report.forecasts : []) {
      const year = Number(forecast?.year);
      if (!Number.isInteger(year) || (selectedYears ? !selectedYears.has(year) : year < minYear)) continue;
      const current = grouped.get(year) ?? {
        year,
        reportKeys: new Set(),
        revenue: [],
        netProfit: [],
        eps: [],
        reportedPe: [],
      };
      if (reportKey) current.reportKeys.add(reportKey);
      appendPositive(current.revenue, forecast?.revenue);
      appendPositive(current.netProfit, forecast?.netProfit);
      appendPositive(current.eps, forecast?.eps);
      appendPositive(current.reportedPe, forecast?.pe);
      grouped.set(year, current);
    }
  }
  const rows = [...grouped.values()]
    .sort((a, b) => a.year - b.year)
    .slice(0, selectedYears ? selectedYears.size : maxYears)
    .map((item) => {
      const revenueYi = average(item.revenue);
      const netProfitYi = average(item.netProfit);
      const eps = average(item.eps);
      const pe = marketCapYi > 0 && netProfitYi > 0
        ? round(marketCapYi / netProfitYi)
        : currentPrice > 0 && eps > 0
          ? round(currentPrice / eps)
          : null;
      return {
        year: item.year,
        revenueYi,
        netProfitYi,
        eps,
        pe,
        reportedPe: average(item.reportedPe),
        sampleCount: item.reportKeys.size,
        revenueSampleCount: item.revenue.length,
        netProfitSampleCount: item.netProfit.length,
      };
    });
  for (let index = 0; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    rows[index].revenueGrowthPct = growthPct(rows[index].revenueYi, previous?.revenueYi);
    rows[index].netProfitGrowthPct = growthPct(rows[index].netProfitYi, previous?.netProfitYi);
  }
  return rows;
}

export function renderFundHoldingsStatisticsHtml({
  asOf,
  reportDate,
  quarter,
  fundsAnalyzed,
  holdings,
  periods,
  forecastYears,
  baseUrl,
  warnings = [],
}) {
  const columns = [
    numericHtmlColumn("持有基金数", (holding) => holding.fundCount, (holding) => String(holding.fundCount)),
    textHtmlColumn("标的", (holding) => holding.name, (holding) => {
      const url = `${String(baseUrl).replace(/\/$/, "")}/company.html?code=${encodeURIComponent(holding.code)}`;
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(holding.name)}</a>`;
    }),
    textHtmlColumn("代码", (holding) => holding.code),
    percentHtmlColumn("权重合计", (holding) => holding.totalWeightPct),
    percentHtmlColumn("平均权重", (holding) => holding.averageWeightPct),
    percentHtmlColumn("最高权重", (holding) => holding.maxWeightPct),
    numericHtmlColumn("当前价", (holding) => holding.market?.price, (holding) => {
      const price = holding.market?.price;
      return Number.isFinite(price) ? `${Number(price).toFixed(2)}<small>${escapeHtml(holding.market?.priceDate || "-")}</small>` : "-";
    }),
    ...(periods ?? []).map((period) => percentHtmlColumn(period.label, (holding) => holding.market?.performance?.[period.key])),
    ...(forecastYears ?? []).flatMap((year) => [
      forecastValueHtmlColumn(`${year}E营收`, "亿元", year, "revenueYi", "revenueSampleCount"),
      forecastPercentHtmlColumn(`${year}E营收增速`, year, "revenueGrowthPct"),
      forecastValueHtmlColumn(`${year}E归母净利润`, "亿元", year, "netProfitYi", "netProfitSampleCount"),
      forecastPercentHtmlColumn(`${year}E净利润增速`, year, "netProfitGrowthPct"),
      forecastValueHtmlColumn(`${year}E PE`, "", year, "pe", null),
    ]),
  ];
  const header = columns.map((column, index) =>
    `<th scope="col" data-column="${index}" data-type="${column.type}" tabindex="0">${escapeHtml(column.label)}${column.unit ? `<small>${escapeHtml(column.unit)}</small>` : ""}<span class="sort-indicator" aria-hidden="true"></span></th>`,
  ).join("");
  const rows = holdings.map((holding) => `<tr>${columns.map((column) => {
    const sortValue = column.sortValue(holding);
    const sortable = sortValue === null || sortValue === undefined || sortValue === "" ? "" : String(sortValue);
    return `<td data-sort-value="${escapeHtml(sortable)}" class="${column.type === "number" ? "number" : "text"}">${column.render(holding)}</td>`;
  }).join("")}</tr>`).join("\n");
  const warningHtml = warnings.length
    ? `<section><h2>数据缺失</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>基金持仓统计（${escapeHtml(quarter)}）</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18212f; background: #f5f7fa; }
    body { margin: 0; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .summary { margin: 0 0 8px; color: #52606d; }
    .hint { margin: 0 0 16px; color: #66788a; font-size: 13px; }
    .table-wrap { max-height: calc(100vh - 150px); overflow: auto; border: 1px solid #d8dee8; border-radius: 8px; background: white; }
    table { border-collapse: separate; border-spacing: 0; min-width: 2600px; width: 100%; font-size: 13px; }
    th, td { padding: 9px 10px; border-right: 1px solid #e5e9f0; border-bottom: 1px solid #e5e9f0; white-space: nowrap; }
    th { position: sticky; top: 0; z-index: 2; background: #eef2f7; text-align: right; cursor: pointer; user-select: none; box-shadow: 0 1px 0 #cbd3df; }
    th:nth-child(2), th:nth-child(3) { text-align: left; }
    th:hover, th:focus { background: #dfe7f1; outline: none; }
    th[aria-sort="ascending"] .sort-indicator::after { content: " ▲"; }
    th[aria-sort="descending"] .sort-indicator::after { content: " ▼"; }
    th small, td small { display: block; color: #718096; font-weight: normal; font-size: 11px; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; }
    td.text { text-align: left; }
    tbody tr:nth-child(even) { background: #fafbfd; }
    tbody tr:hover { background: #edf5ff; }
    a { color: #1769aa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    section { margin-top: 24px; max-width: 1200px; }
    section h2 { font-size: 18px; }
    section li { margin: 6px 0; }
    .notes { color: #52606d; font-size: 13px; line-height: 1.65; }
  </style>
</head>
<body>
  <h1>基金持仓统计（${escapeHtml(quarter)}）</h1>
  <p class="summary">数据截至：${escapeHtml(asOf)}；基金持仓报告期：${escapeHtml(reportDate)}；纳入基金：${fundsAnalyzed} 只；持仓标的：${holdings.length} 个。</p>
  <p class="hint">点击任意列名可升序或降序排列；缺失值始终排在末尾。</p>
  <div class="table-wrap">
    <table id="holdings-table">
      <thead><tr>${header}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${columns.length}">暂无可用持仓</td></tr>`}</tbody>
    </table>
  </div>
  <section class="notes">
    <h2>口径与限制</h2>
    <ul>
      <li>持有基金数只统计纳入本次季度分析且出现在季报公开持仓明细中的基金；权重合计是跨基金权重的百分点求和，不代表组合实际配置比例。</li>
      <li>股价涨跌幅使用东财前复权日 K 线，以区间起点之前最近一个交易日收盘价至数据截止日最近收盘价计算。</li>
      <li>未来营收、归母净利润和 EPS 来自最近研报逐年预测的简单平均；n 是该字段有效样本数。预测增速按相邻预测年度计算，首个预测年度没有可比基数时留空。</li>
      <li>当前口径 PE 优先使用当前总市值除以预测归母净利润；总市值缺失时才使用当前股价除以预测 EPS。负值或缺失预测不计算 PE。</li>
      <li>研报接口目前主要覆盖 A 股最近 90 天、最多 10 篇研报；港股及缺少研报覆盖的标的保留空值。</li>
    </ul>
  </section>
  ${warningHtml}
  <script>
    (() => {
      const table = document.getElementById("holdings-table");
      const body = table.tBodies[0];
      const headers = [...table.tHead.rows[0].cells];
      const sortBy = (header) => {
        const column = Number(header.dataset.column);
        const direction = header.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
        headers.forEach((item) => item.removeAttribute("aria-sort"));
        header.setAttribute("aria-sort", direction);
        const multiplier = direction === "ascending" ? 1 : -1;
        const type = header.dataset.type;
        const rows = [...body.rows];
        rows.sort((left, right) => {
          const a = left.cells[column]?.dataset.sortValue ?? "";
          const b = right.cells[column]?.dataset.sortValue ?? "";
          if (a === "" && b === "") return 0;
          if (a === "") return 1;
          if (b === "") return -1;
          const compared = type === "number"
            ? Number(a) - Number(b)
            : a.localeCompare(b, "zh-CN", { numeric: true });
          return compared * multiplier;
        });
        rows.forEach((row) => body.appendChild(row));
      };
      headers.forEach((header) => {
        header.addEventListener("click", () => sortBy(header));
        header.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); sortBy(header); }
        });
      });
    })();
  </script>
</body>
</html>`;
}

export async function outputAlreadyExists(path) {
  try {
    const file = await stat(path);
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

export function renderPrompt(template, values) {
  let rendered = String(template);
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value));
  }
  const unresolved = [...rendered.matchAll(/{{([A-Z0-9_]+)}}/g)].map((match) => match[1]);
  if (unresolved.length) throw new Error(`unresolved prompt placeholders: ${[...new Set(unresolved)].join(", ")}`);
  return rendered;
}

export function stripMarkdownFence(value) {
  const text = String(value ?? "").trim();
  const matched = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (matched?.[1] ?? text).trim();
}

export function validateGeneratedReport(markdown, fund) {
  const text = String(markdown ?? "").trim();
  if (!text.startsWith("# ")) throw new Error(`LLM report for ${fund.code} is missing a Markdown title`);
  const hasName = text.includes(fund.name) || (fund.baseName && text.includes(fund.baseName));
  if (!text.includes(fund.code) || !hasName) {
    throw new Error(`LLM report for ${fund.code} is missing fund identity`);
  }
  return text;
}

function classifyAction({ currentItem, previousItem, currentFundShares, previousFundShares, actionThresholdPct }) {
  if (!previousItem) return { code: "entered_top", label: "新进前十大", perFundShareChangePct: null };
  if (!currentItem) return { code: "exited_top", label: "退出前十大", perFundShareChangePct: null };
  if (!(currentFundShares > 0) || !(previousFundShares > 0) || !(previousItem.shares > 0)) {
    return { code: "unknown", label: "无法判断（缺少全基金份额）", perFundShareChangePct: null };
  }
  const changePct = ((currentItem.shares / currentFundShares) / (previousItem.shares / previousFundShares) - 1) * 100;
  if (changePct > actionThresholdPct) return { code: "increased", label: "加仓", perFundShareChangePct: round(changePct) };
  if (changePct < -actionThresholdPct) return { code: "decreased", label: "减仓", perFundShareChangePct: round(changePct) };
  return { code: "unchanged", label: "基本持平", perFundShareChangePct: round(changePct) };
}

function assessAction(actionCode, postReturnPct, thresholdPct) {
  if (postReturnPct === null || actionCode === "unknown") return "证据不足";
  if (Math.abs(postReturnPct) < thresholdPct || actionCode === "unchanged") return "中性";
  if (["increased", "entered_top"].includes(actionCode)) return postReturnPct > 0 ? "短期正确" : "短期错误";
  if (["decreased", "exited_top"].includes(actionCode)) return postReturnPct < 0 ? "短期正确" : "短期错误";
  return "中性";
}

function compareShareClassCandidate(left, right, priority) {
  const leftPriority = classPriority(left.shareClass, priority);
  const rightPriority = classPriority(right.shareClass, priority);
  return leftPriority - rightPriority || left.rank - right.rank || left.code.localeCompare(right.code);
}

function classPriority(shareClass, priority) {
  const index = priority.indexOf(shareClass);
  return index >= 0 ? index : priority.length;
}

function normalizeFundGroupName(value) {
  return String(value).replace(/[\s·・]/g, "").toLowerCase();
}

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, "").replaceAll("&amp;", "&").replaceAll("&nbsp;", " ");
}

function formatIndexPercent(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}%` : "-";
}

function appendPositive(target, value) {
  const parsed = nullableNumber(value);
  if (parsed !== null && parsed > 0) target.push(parsed);
}

function average(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function growthPct(current, previous) {
  return current > 0 && previous > 0 ? round((current / previous - 1) * 100) : null;
}

function textHtmlColumn(label, getValue, render = (holding) => escapeHtml(getValue(holding) ?? "-")) {
  return { label, unit: "", type: "text", sortValue: getValue, render };
}

function numericHtmlColumn(label, getValue, render = (holding) => formatNumber(getValue(holding))) {
  return { label, unit: "", type: "number", sortValue: getValue, render };
}

function percentHtmlColumn(label, getValue) {
  return numericHtmlColumn(label, getValue, (holding) => formatIndexPercent(getValue(holding)));
}

function forecastValueHtmlColumn(label, unit, year, key, sampleKey) {
  const getForecast = (holding) => (holding.forecasts ?? []).find((item) => item.year === year);
  return {
    label,
    unit,
    type: "number",
    sortValue: (holding) => getForecast(holding)?.[key],
    render: (holding) => {
      const forecast = getForecast(holding);
      const value = forecast?.[key];
      const sampleCount = sampleKey ? forecast?.[sampleKey] : null;
      return Number.isFinite(value)
        ? `${Number(value).toFixed(2)}${sampleCount ? `<small>n=${sampleCount}</small>` : ""}`
        : "-";
    },
  };
}

function forecastPercentHtmlColumn(label, year, key) {
  const getValue = (holding) => (holding.forecasts ?? []).find((item) => item.year === year)?.[key];
  return percentHtmlColumn(label, getValue);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "-";
}

function escapeTable(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function number(value) {
  return nullableNumber(value) ?? 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "" || value === "---") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function assertDate(value, label) {
  if (!DATE_PATTERN.test(String(value))) throw new Error(`${label} must use YYYY-MM-DD: ${value}`);
}
