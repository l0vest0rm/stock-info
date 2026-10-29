#!/usr/bin/env node
import { checkValuationDashboard } from './lib/check-valuation-dashboard.mjs';
import policy from '../config/investment-opportunity-policy.json' with { type: 'json' };

// Run after ./start-local.sh has made the Node API healthy.
const baseUrl = String(process.env.BASIC_TEST_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const code = "300308.SZ";
const timeoutMs = Number(process.env.BASIC_TEST_TIMEOUT_MS || 60000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function get(path) {
  const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  assert(response.ok && body?.code === 200, `${path}: HTTP ${response.status}, ${body?.msg || "invalid JSON response"}`);
  return body.data;
}

console.log(JSON.stringify(await checkValuationDashboard()));

const health = await get("/api/health");
assert(health?.d1 === true, "local database health check failed");

// The retained basic entry point also protects the valuation dashboard contract.
const dashboard = await get('/api/research/valuation-screen');
assert(dashboard.schemaVersion === 4 && Array.isArray(dashboard.targets), '估值看板契约版本错误');
assert(dashboard.mode === 'rolling' && /^[a-f0-9]{64}$/.test(dashboard.revision), '滚动模型或依赖版本缺失');
assert(Array.isArray(dashboard.pending) && dashboard.pending.every(code => dashboard.targets.includes(code)), '待刷新目标无效');
assert(dashboard.stale === (dashboard.pending.length > 0), '缓存新鲜度与待刷新列表不一致');
assert(dashboard.targets.length === dashboard.companies && new Set(dashboard.targets).size === dashboard.companies, '估值观察池目标重复或缺失');
for (const row of dashboard.rows) {
  assert(dashboard.targets.includes(row.code), '缓存混入观察池外证券');
  assert(row.computation?.revision === dashboard.revision && Number.isFinite(Date.parse(row.computation.computedAt)), '计算版本或时间缺失');
  assert(row.executable === false, '估值不得成为自动交易指令');
  assert(row.opportunity?.policyVersion === policy.version, '机会模型缺失或策略版本错误');
  assert(row.opportunity.signals.length === 4 && row.opportunity.future === null, '四类线索契约或未来留空错误');
  if (row.opportunity.stage === 'research_candidate') assert(row.opportunity.gates.every((g) => g.state === 'pass'), '候选必须通过全部量化门槛');
  if (!row.assessment) { assert(row.verdict === 'blocked', '缺失估值模型必须阻断'); continue; }
  const a = row.assessment;
  assert(a.future === null, '未覆盖的未来估值不得伪造');
  assert(Number.isFinite(Date.parse(a.computedAt)), '估值缺少计算时间');
  assert(a.history.windows.every((w) => w.percentile === null || (w.percentile >= 0 && w.percentile <= 1)), '历史分位越界');
  if (a.status !== 'unknown') {
    assert(a.quote?.date && a.range && Number.isFinite(a.current), '有效档位缺少行情/区间');
    assert(row.basis?.role === 'primary' && row.verdict !== 'blocked', '辅助方法或阻断结果不能产生估值档位');
  }
}
const invalid = await fetch(new URL('/api/research/valuation-screen/refresh/INVALID', baseUrl), { method: 'POST' });
assert(invalid.status === 400, '不得通过刷新端点抓取观察池外任意证券');
const { bandPosition, assessValuation } = await import('../src/modules/research/domain/valuation-assessment.ts');
for (const [cap, expected] of [[79, 'undervalued'], [80, 'fair_low'], [129, 'fair_low'], [130, 'fair'], [180, 'fair'], [216, 'expensive'], [217, 'very_expensive'], [-1, 'unknown'], [NaN, 'unknown']]) {
  assert(bandPosition(cap, 80, 180) === expected, `估值档位边界错误：${cap}`);
}
const baseBand = { key: 'pe_ttm', label: 'PE', role: 'primary', status: 'available', unit: 'multiple', range: { low: 8, high: 18 }, denominator: { value: 10, reportDate: '2026-06-30' }, assumptions: [] };
const input = { result: { verdict: 'watch', basis: { key: 'pe_ttm' }, position: { marketCap: 100 }, growth: { verdict: 'supports', ttmGrowth: .1 }, note: 'fixture' }, bands: { bands: [baseBand], warnings: [] }, series: { points: [] }, statements: [], bars: [], quote: null, historyComparable: true };
const assessed = assessValuation(input);
assert(assessed.conservativeMargin === -.25, '安全边际必须锚定价值下限，而非上限');
assert(assessed.history.windows.every((w) => w.percentile === null), '缺历史不得回填分位');
assert(assessValuation({ ...input, bands: { bands: [{ ...baseBand, role: 'auxiliary' }], warnings: [] } }).status === 'unknown', '辅助PE不得判定银行/保险低估');
assert(assessValuation({ ...input, result: { ...input.result, verdict: 'blocked' } }).status === 'unknown', '阻断结果不得产生估值档位');
const yieldResult = assessValuation({ ...input, result: { ...input.result, basis: { key: 'fcf_yield' } }, bands: { bands: [{ ...baseBand, key: 'fcf_yield', unit: 'percent', range: { low: 3, high: 6 } }], warnings: [] } });
assert(Math.abs(yieldResult.conservativeMargin - .4) < 1e-9, '收益率区间必须反向换算价值，再计算安全边际');
console.log(JSON.stringify({ valuationDashboard: 'passed', cachedRows: dashboard.rows.length, targets: dashboard.companies }));

const { checkInvestmentOpportunity } = await import('./lib/check-investment-opportunity.mjs');
console.log(JSON.stringify(checkInvestmentOpportunity()));

const kline = await get(`/api/kline?code=${code}&period=day&fq=normal&format=structured`);
assert(Array.isArray(kline) && kline.length > 0, "中际旭创 K 线数据为空");
const latestKline = kline.at(-1);
assert(typeof latestKline?.date === "string" && finitePositive(latestKline.close), "中际旭创最新 K 线无有效日期或收盘价");

const statements = {};
for (const type of ["income", "balance", "cashflow"]) {
  const model = await get(`/api/finance/${type}?code=${code}&format=read-model`);
  assert(model?.code === code && model.statementType === type, `${type} 财报代码或类型错误`);
  assert(model.sourcePolicy?.primaryProvider === "eastmoney", `${type} 财报主数据源不是东方财富`);
  assert(model.sourceHealth?.status === "healthy" && Array.isArray(model.rows) && model.rows.length > 0,
    `${type} 财报不可用：${model.sourceHealth?.message || model.sourceHealth?.reason || "无数据"}`);
  assert(model.fieldAvailability?.nonEmptyPayloadRows > 0 && model.latestReportDate, `${type} 财报缺少有效内容或报告期`);
  statements[type] = { rows: model.rows.length, latestReportDate: model.latestReportDate };
}

const overview = await get(`/api/company/overview?code=${code}`);
assert(overview?.code === code && overview.name?.includes("中际旭创"), "公司概览不是中际旭创");
assert(finitePositive(overview.latestPrice), "公司概览缺少最新价格");
assert(finitePositive(overview.marketCapYi), "公司概览缺少有效市值（亿元）");
assert(finitePositive(overview.peTtm), "公司概览缺少有效 PE(TTM)");

console.log(JSON.stringify({
  status: "passed",
  code,
  name: overview.name,
  kline: { rows: kline.length, latestDate: latestKline.date, latestClose: latestKline.close },
  statements,
  peTtm: overview.peTtm,
  marketCapYi: overview.marketCapYi,
}, null, 2));

// Existing provider forecasts must retain publication-relative years and access control.
const { normalizeForwardReference } = await import('../src/modules/company/domain/report-forward-reference.ts');
const normalizedForward = normalizeForwardReference({ publishDate: '2025-09-20', predictThisYearEps: '2', predictNextYearEps: '3', predictNextYearPe: '12', forecasts: [{ year: 2026, eps: 4 }] });
assert(normalizedForward.forecasts[0].year === 2025 && normalizedForward.forecasts[1].year === 2026, '预测年份必须锚定发布日期');
assert(normalizedForward.forecasts[1].eps === 4 && normalizedForward.forecasts[1].pe === 12, '已保存提取优先且保留提供商PE');
assert(normalizeForwardReference({ predictThisYearEps: '2' }).forecasts.length === 0, '无发布日期不得猜预测年份');
assert(normalizeForwardReference({ publishDate: '2026-01-01', predictThisYearEps: '' }).forecasts.length === 0, '空预测不得变成0');
const { projectCompanyReportItemsForSession } = await import('../src/modules/company/api/company-report-access.ts');
const anonymousReport = projectCompanyReportItemsForSession([{ code, infoCode: 'AP123', url: 'https://pdf.dfcfw.com/example.pdf' }], false)[0];
assert(anonymousReport.reportCarrier === '东方财富' && anonymousReport.reportLocked && !anonymousReport.url && !anonymousReport.infoCode && !anonymousReport.reportUrl, '来源标记不得绕过研报链接权限');
const reportReferences = await get(`/api/company/reports?code=${code}&readOnly=1`);
assert(Array.isArray(reportReferences) && reportReferences.length > 0, '只读研报参考缺失');
assert(reportReferences.every((r) => typeof r.reportCarrier === 'string'), '研报来源缺失');
assert(reportReferences.some((r) => r.forecasts?.some((f) => Number.isInteger(f.year) && Number.isFinite(f.eps))), '现有研报EPS未接入');
console.log(JSON.stringify({ forwardReferences: 'passed', reports: reportReferences.length }));
