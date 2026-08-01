#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.argv.slice(2).includes('--help')) {
  console.log(`Usage: node scripts/backtest-multi-asset-allocation.mjs [options]

Data and time:
  --config config/multi-asset-backtest.json
  --growth-code 300308.SZ --dividend-code 601088.SH --bond-code 000012.SH
  --from 2021-07-31 --to 2026-07-31 --horizon-days 252

Allocation and deployment:
  --allocation-sets 'growth=50,dividend=20,bond=20,cash=10;growth=35,dividend=25,bond=30,cash=10'
  --deploy-rungs 10:50,20:50 --funding-order cash,bond --deployment-target growth

Growth/dividend rotation:
  --rotation-mode none|price|valuation --rotation-weights 70/30 --price-lookback-days 60
  --valuation-file /absolute/path/to/valuation.csv
  valuation.csv columns: date,growthScore,dividendScore (lower score is cheaper; missing dates do not trade).
`);
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config ?? 'config/multi-asset-backtest.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const from = args.from ?? '2021-07-31';
const to = args.to ?? '2026-07-31';
const horizon = Number(args['horizon-days'] ?? '252');
const cost = Number(args['one-way-cost-bp'] ?? '15') / 10_000;
const baseUrl = args['base-url'] ?? 'https://tinfo.cc';
const output = path.resolve(args.output ?? 'docs/research/多资产配置回测.md');
const csvOutput = output.replace(/\.md$/i, '.csv');
const eventsOutput = output.replace(/\.md$/i, '-调仓明细.csv');

if (!Number.isInteger(horizon) || horizon < 20) throw new Error('--horizon-days must be an integer of at least 20');
if (!Number.isFinite(cost) || cost < 0 || cost > 0.01) throw new Error('--one-way-cost-bp must be between 0 and 100');

const assets = normalizeAssets(config.assets, args);
const allocationSets = args['allocation-sets'] ? parseAllocationSets(args['allocation-sets']) : normalizeAllocationSets(config.allocationSets);
const deployment = normalizeDeployment(config.deployment, args);
const rotation = await normalizeRotation(config.rotation, args);
const pricedRoles = Object.entries(assets).filter(([, asset]) => asset.kind !== 'cash').map(([role]) => role);
const priceRows = new Map(await Promise.all(pricedRoles.map(async (role) => [role, await fetchKline(baseUrl, assets[role].code, dateDaysBefore(from, Math.max(180, rotation.priceLookbackDays + 5)), to)])));
const calendar = intersectDates([...priceRows.values()]);
if (calendar.length <= horizon) throw new Error(`only ${calendar.length} shared price dates; need more than --horizon-days ${horizon}`);
const points = buildPoints(calendar, priceRows, assets);
const entries = monthlyEntryIndices(points, horizon, from);
if (!entries.length) throw new Error('no complete monthly entry windows for the selected range');

const episodes = [];
const events = [];
for (const allocation of allocationSets) {
  for (const entryIndex of entries) {
    const window = points.slice(entryIndex, entryIndex + horizon + 1);
    const baseline = simulateStatic(window, allocation.weights, cost);
    const result = simulateStrategy(window, allocation, deployment, rotation, cost);
    episodes.push({
      allocation: allocation.id,
      entryDate: window[0].date,
      exitDate: window.at(-1).date,
      returnPct: result.result.returnPct,
      maxDrawdownPct: result.result.maxDrawdownPct,
      baselineReturnPct: baseline.returnPct,
      baselineMaxDrawdownPct: baseline.maxDrawdownPct,
      deploymentTrades: result.events.filter((event) => event.type === 'deployment').length,
      rotationTrades: result.events.filter((event) => event.type === 'rotation').length,
    });
    for (const event of result.events) events.push({ allocation: allocation.id, entryDate: window[0].date, ...event });
  }
}

const summaries = summarizeEpisodes(allocationSets, episodes);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, renderReport({ configPath, assets, allocationSets, deployment, rotation, from, to, horizon, cost, summaries, csvOutput, eventsOutput }), 'utf8');
await writeFile(csvOutput, renderCsv(episodes), 'utf8');
await writeFile(eventsOutput, renderCsv(events), 'utf8');
console.log(JSON.stringify({ output, csvOutput, eventsOutput, dates: calendar.length, episodes: episodes.length, allocations: allocationSets.length }, null, 2));

function normalizeAssets(raw, overrides) {
  const assets = {};
  for (const role of ['growth', 'dividend', 'bond', 'cash']) {
    const source = raw?.[role];
    if (!source || typeof source !== 'object') throw new Error(`config.assets.${role} is required`);
    const override = overrides[`${role}-code`];
    const code = override ?? source.code;
    const kind = source.kind === 'cash' && !override ? 'cash' : 'market';
    if (kind === 'market' && !code) throw new Error(`a code is required for ${role}`);
    assets[role] = { role, kind, code: code ? String(code).toUpperCase() : null, label: String(source.label ?? role) };
  }
  return assets;
}

function normalizeAllocationSets(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('config.allocationSets must be a non-empty array');
  return raw.map((item, index) => normalizeAllocation(String(item?.id ?? `allocation-${index + 1}`), item?.weights));
}

function parseAllocationSets(value) {
  return String(value).split(';').filter(Boolean).map((part, index) => {
    const weights = {};
    for (const item of part.split(',')) {
      const [role, rawWeight] = item.split('=');
      if (!['growth', 'dividend', 'bond', 'cash'].includes(role)) throw new Error(`unknown allocation role: ${role}`);
      weights[role] = Number(rawWeight);
    }
    return normalizeAllocation(`cli-${index + 1}`, weights);
  });
}

function normalizeAllocation(id, raw) {
  const weights = Object.fromEntries(['growth', 'dividend', 'bond', 'cash'].map((role) => [role, Number(raw?.[role] ?? 0)]));
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Object.values(weights).some((value) => !Number.isFinite(value) || value < 0) || Math.abs(total - 100) > 1e-8) throw new Error(`${id}: growth/dividend/bond/cash weights must be non-negative and total 100`);
  return { id, weights };
}

function normalizeDeployment(raw, overrides) {
  const rungs = overrides['deploy-rungs'] ? parseRungs(overrides['deploy-rungs']) : (raw?.rungs ?? []).map((rung) => ({ lossPct: Number(rung.lossPct), reservePct: Number(rung.reservePct) }));
  if (!rungs.length) throw new Error('deployment requires at least one rung');
  const ordered = [...rungs].sort((a, b) => a.lossPct - b.lossPct);
  if (ordered.some((rung, index) => !Number.isFinite(rung.lossPct) || rung.lossPct <= 0 || !Number.isFinite(rung.reservePct) || rung.reservePct <= 0 || (index && rung.lossPct <= ordered[index - 1].lossPct))) throw new Error('deployment rungs must be strictly increasing positive lossPct:reservePct pairs');
  if (ordered.reduce((sum, rung) => sum + rung.reservePct, 0) > 100 + 1e-8) throw new Error('deployment rung reserve percentages must total at most 100');
  const fundingOrder = String(overrides['funding-order'] ?? raw?.fundingOrder?.join(',') ?? 'cash,bond').split(',').map((role) => role.trim());
  if (!fundingOrder.length || fundingOrder.some((role) => !['cash', 'bond'].includes(role)) || new Set(fundingOrder).size !== fundingOrder.length) throw new Error('--funding-order must be a non-duplicate sequence of cash and/or bond');
  const target = String(overrides['deployment-target'] ?? raw?.target ?? 'growth');
  if (!['growth', 'dividend', 'stock-pro-rata'].includes(target)) throw new Error('--deployment-target must be growth, dividend, or stock-pro-rata');
  const drawdownSleeve = String(overrides['drawdown-sleeve'] ?? raw?.drawdownSleeve ?? 'growth');
  if (!['growth', 'dividend'].includes(drawdownSleeve)) throw new Error('--drawdown-sleeve must be growth or dividend');
  return { rungs: ordered, fundingOrder, target, drawdownSleeve };
}

function parseRungs(value) {
  return String(value).split(',').map((part) => {
    const match = part.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error('--deploy-rungs must look like 10:50,20:50');
    return { lossPct: Number(match[1]), reservePct: Number(match[2]) };
  });
}

async function normalizeRotation(raw, overrides) {
  const mode = String(overrides['rotation-mode'] ?? raw?.mode ?? 'none');
  if (!['none', 'price', 'valuation'].includes(mode)) throw new Error('--rotation-mode must be none, price, or valuation');
  const [favored, other] = String(overrides['rotation-weights'] ?? `${raw?.stockWeights?.favored ?? 70}/${raw?.stockWeights?.other ?? 30}`).split('/').map(Number);
  if (!(favored >= 0) || !(other >= 0) || Math.abs(favored + other - 100) > 1e-8) throw new Error('--rotation-weights must total 100, for example 70/30');
  const priceLookbackDays = Number(overrides['price-lookback-days'] ?? raw?.priceLookbackDays ?? 60);
  if (!Number.isInteger(priceLookbackDays) || priceLookbackDays < 5) throw new Error('--price-lookback-days must be an integer of at least 5');
  const valuationFile = overrides['valuation-file'];
  const valuation = mode === 'valuation' ? await readValuationSeries(valuationFile) : new Map();
  return { mode, favored, other, priceLookbackDays, valuation };
}

async function readValuationSeries(file) {
  if (!file) throw new Error('--valuation-file is required for --rotation-mode valuation');
  const text = await readFile(path.resolve(file), 'utf8');
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const fields = header.split(',');
  const dateIndex = fields.indexOf('date'); const growthIndex = fields.indexOf('growthScore'); const dividendIndex = fields.indexOf('dividendScore');
  if (dateIndex < 0 || growthIndex < 0 || dividendIndex < 0) throw new Error('valuation file must have date,growthScore,dividendScore columns');
  const values = new Map();
  for (const line of lines) {
    const parts = line.split(','); const growth = Number(parts[growthIndex]); const dividend = Number(parts[dividendIndex]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts[dateIndex] ?? '') && Number.isFinite(growth) && Number.isFinite(dividend)) values.set(parts[dateIndex], { growth, dividend });
  }
  return values;
}

async function fetchKline(base, code, fromDate, toDate) {
  const data = await fetchJson(base, '/api/kline', { code, period: 'day', fq: 'qfq', from: fromDate, to: toDate });
  return data.map((row) => ({ date: new Date(Number(row[0])).toISOString().slice(0, 10), close: Number(row[1]) })).filter((row) => Number.isFinite(row.close) && row.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

function intersectDates(series) {
  const common = new Set(series[0].map((row) => row.date));
  for (const rows of series.slice(1)) for (const date of [...common]) if (!rows.some((row) => row.date === date)) common.delete(date);
  return [...common].sort();
}

function buildPoints(calendar, priceRows, assets) {
  const byRole = new Map([...priceRows.entries()].map(([role, rows]) => [role, new Map(rows.map((row) => [row.date, row.close]))]));
  return calendar.map((date) => ({ date, prices: Object.fromEntries(['growth', 'dividend', 'bond', 'cash'].map((role) => [role, assets[role].kind === 'cash' ? 1 : byRole.get(role).get(date)])) }));
}

function monthlyEntryIndices(rows, days, firstDate) {
  const result = []; const months = new Set();
  for (let index = 0; index + days < rows.length; index += 1) { if (rows[index].date < firstDate) continue; const month = rows[index].date.slice(0, 7); if (!months.has(month)) { months.add(month); result.push(index); } }
  return result;
}

function simulateStatic(rows, weights, cost) { return simulate(rows, weights, null, null, cost).result; }
function simulateStrategy(rows, allocation, deployment, rotation, cost) { return simulate(rows, allocation.weights, deployment, rotation, cost); }

function simulate(rows, weights, deployment, rotation, cost) {
  const holdings = initialHoldings(rows[0].prices, weights, cost); const initialReserve = deployment ? deployment.fundingOrder.reduce((sum, role) => sum + weights[role] / 100, 0) : 0;
  const events = []; let peak = nav(holdings, rows[0].prices); let maxDrawdown = 0; const usedRungs = new Set(); let lastRotationMonth = '';
  for (let index = 1; index < rows.length; index += 1) {
    const point = rows[index]; const prior = rows[index - 1];
    if (deployment) for (const [rungIndex, rung] of deployment.rungs.entries()) if (!usedRungs.has(rungIndex) && prior.prices[deployment.drawdownSleeve] <= rows[0].prices[deployment.drawdownSleeve] * (1 - rung.lossPct / 100)) {
      const amount = initialReserve * rung.reservePct / 100; const funded = fund(holdings, prior.prices, point.prices, amount, deployment.fundingOrder, cost);
      if (funded > 0) { buyTarget(holdings, point.prices, funded, deployment.target, weights, cost); events.push({ date: point.date, type: 'deployment', detail: `跌${rung.lossPct}%`, amountPct: funded * 100 }); }
      usedRungs.add(rungIndex);
    }
    const month = point.date.slice(0, 7);
    if (rotation && rotation.mode !== 'none' && month !== lastRotationMonth) {
      const favored = rotationFavorite(rows, index - 1, rotation); if (favored && rotateStocks(holdings, point.prices, favored, rotation, cost)) events.push({ date: point.date, type: 'rotation', detail: `favored-${favored}` });
      lastRotationMonth = month;
    }
    const currentNav = nav(holdings, point.prices); peak = Math.max(peak, currentNav); maxDrawdown = Math.min(maxDrawdown, currentNav / peak - 1);
  }
  const final = liquidate(holdings, rows.at(-1).prices, cost); peak = Math.max(peak, final); maxDrawdown = Math.min(maxDrawdown, final / peak - 1);
  return { result: { returnPct: (final - 1) * 100, maxDrawdownPct: maxDrawdown * 100 }, events };
}

function initialHoldings(prices, weights, cost) { return Object.fromEntries(['growth', 'dividend', 'bond', 'cash'].map((role) => [role, role === 'cash' ? weights[role] / 100 : weights[role] / 100 / prices[role] / (1 + cost)])); }
function nav(holdings, prices) { return Object.entries(holdings).reduce((sum, [role, quantity]) => sum + quantity * prices[role], 0); }
function liquidate(holdings, prices, cost) { return Object.entries(holdings).reduce((sum, [role, quantity]) => sum + (role === 'cash' ? quantity : quantity * prices[role] * (1 - cost)), 0); }
function fund(holdings, prior, prices, amount, order, cost) { let remaining = amount; let funded = 0; for (const role of order) { const available = holdings[role] * prices[role] * (role === 'cash' ? 1 : 1 - cost); const take = Math.min(available, remaining); if (take <= 0) continue; holdings[role] -= role === 'cash' ? take : take / prices[role] / (1 - cost); remaining -= take; funded += take; } return funded; }
function buy(holdings, role, prices, amount, cost) { const quantity = amount / prices[role] / (role === 'cash' ? 1 : 1 + cost); holdings[role] += quantity; }
function buyTarget(holdings, prices, amount, target, weights, cost) { if (target === 'stock-pro-rata') { const total = weights.growth + weights.dividend; if (total <= 0) return; buy(holdings, 'growth', prices, amount * weights.growth / total, cost); buy(holdings, 'dividend', prices, amount * weights.dividend / total, cost); } else buy(holdings, target, prices, amount, cost); }
function rotationFavorite(rows, index, rotation) { if (rotation.mode === 'valuation') { const values = rotation.valuation.get(rows[index].date); return !values ? null : values.growth <= values.dividend ? 'growth' : 'dividend'; } if (index < rotation.priceLookbackDays) return null; const past = rows[index - rotation.priceLookbackDays].prices; const current = rows[index].prices; return current.growth / past.growth >= current.dividend / past.dividend ? 'growth' : 'dividend'; }
function rotateStocks(holdings, prices, favored, rotation, cost) { const other = favored === 'growth' ? 'dividend' : 'growth'; const stockValue = holdings.growth * prices.growth + holdings.dividend * prices.dividend; const targetValue = stockValue * rotation.favored / 100; const currentValue = holdings[favored] * prices[favored]; if (currentValue >= targetValue) return false; const need = targetValue - currentValue; const sold = Math.min(need, holdings[other] * prices[other] * (1 - cost)); if (sold <= 0) return false; holdings[other] -= sold / prices[other] / (1 - cost); buy(holdings, favored, prices, sold, cost); return true; }

function summarizeEpisodes(allocations, episodes) { return allocations.map((allocation) => { const rows = episodes.filter((row) => row.allocation === allocation.id); const rate = (predicate) => rows.filter(predicate).length / rows.length; return { ...allocation, count: rows.length, deployRate: rate((row) => row.deploymentTrades > 0), rotationRate: rate((row) => row.rotationTrades > 0), returnBetterRate: rate((row) => row.returnPct > row.baselineReturnPct), returnGain5Rate: rate((row) => row.returnPct - row.baselineReturnPct >= 5), returnLoss5Rate: rate((row) => row.returnPct - row.baselineReturnPct <= -5), drawdownBetterRate: rate((row) => row.maxDrawdownPct > row.baselineMaxDrawdownPct), drawdownBetter3Rate: rate((row) => row.maxDrawdownPct - row.baselineMaxDrawdownPct >= 3), bothRate: rate((row) => row.returnPct > row.baselineReturnPct && row.maxDrawdownPct > row.baselineMaxDrawdownPct) }; }); }

function renderReport({ configPath, assets, allocationSets, deployment, rotation, from, to, horizon, cost, summaries, csvOutput, eventsOutput }) { return `# 多资产配置回测\n\n> 生成日期：${new Date().toISOString().slice(0, 10)}；行情范围：${from} 至 ${to}；滚动持有：${horizon} 个交易日。\n\n## 资产与策略\n\n- 成长：${assets.growth.label}（${assets.growth.code}）；红利：${assets.dividend.label}（${assets.dividend.code}）；债券：${assets.bond.label}（${assets.bond.code}）；现金：${assets.cash.label}。\n- 基准为同一初始配置后静态持有。策略的下跌加仓：${deployment.drawdownSleeve}跌${deployment.rungs.map((rung) => `${rung.lossPct}%用储备${rung.reservePct}%`).join('、')}；资金顺序：${deployment.fundingOrder.join('→')}；买入目标：${deployment.target}。\n- 成长/红利轮动：${rotation.mode === 'none' ? '关闭' : rotation.mode === 'price' ? `月度价格强弱，回看${rotation.priceLookbackDays}日，偏好权重${rotation.favored}/${rotation.other}` : `月度估值信号，偏好权重${rotation.favored}/${rotation.other}`}。估值模式只在用户提供的估值日期交易，缺失数据不交易。\n- 交易信号基于前一日数据、下一交易日价格成交；单边成本${Math.round(cost * 10000)}bp。结果使用逐笔发生比例，不使用平均或中位收益/回撤。\n\n## 结果\n\n| 初始配置 | 窗口 | 发生加仓 | 发生轮动 | 收益更高 | 收益多≥5pct | 收益少≥5pct | 回撤更低 | 回撤改善≥3pct | 双优 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${summaries.map((row) => `| ${row.id} | ${row.count} | ${pct(row.deployRate)} | ${pct(row.rotationRate)} | ${pct(row.returnBetterRate)} | ${pct(row.returnGain5Rate)} | ${pct(row.returnLoss5Rate)} | ${pct(row.drawdownBetterRate)} | ${pct(row.drawdownBetter3Rate)} | ${pct(row.bothRate)} |`).join('\n')}\n\n## 限制\n\n1. 当前默认成长、红利、债券是指数代理；可用命令行代码参数替换成长或红利为单一股票。\n2. 估值轮动需要明确、可复现的用户输入估值文件；不从价格或模型推断估值。\n3. 配置来源：\`${path.relative(process.cwd(), configPath)}\`；逐笔结果：\`${path.basename(csvOutput)}\`；调仓事件：\`${path.basename(eventsOutput)}\`。\n`; }
function renderCsv(rows) { const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))]; return [fields.join(','), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))].join('\n') + '\n'; }
function pct(value) { return `${(value * 100).toFixed(2)}%`; }
function csvCell(value) { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function dateDaysBefore(date, days) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() - days); return value.toISOString().slice(0, 10); }
function parseArgs(values) { const parsed = {}; for (let index = 0; index < values.length; index += 1) { if (!values[index].startsWith('--')) throw new Error(`unexpected argument: ${values[index]}`); parsed[values[index].slice(2)] = values[++index]; } return parsed; }
async function fetchJson(base, pathname, query) { const url = new URL(pathname, base); for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value); let lastError; for (let attempt = 1; attempt <= 3; attempt += 1) { try { const response = await fetch(url); const body = await response.json(); if (!response.ok || body.code !== 200 || !Array.isArray(body.data)) throw new Error(`${response.status} ${url}`); return body.data; } catch (error) { lastError = error; } } throw lastError; }
