import { portfolioSecurityCode } from '../../../../shared/active-portfolio';
import type { PortfolioDraft, PortfolioVersion, PortfolioAssessment, PortfolioTask, PortfolioProposal, PortfolioProposalInput } from '../../../../shared/active-portfolio';
import type { ValuationDashboard } from '../../../../shared/valuation-dashboard';
import universe from '../../../../config/investment-universe.json';

const currencies = ['CNY', 'HKD', 'USD', 'KRW'];
const securities = new Map(universe.companies.flatMap(c => c.securities.map(s => [portfolioSecurityCode(s), c] as const)));
export function portfolioTemplate(): PortfolioDraft {
  return { strategy: 'diversified_active', baseCurrency: 'CNY', asOf: '', source: '',
    rules: { maxHoldings: 39, maxCompanyWeight: null, maxSectorWeight: null, benchmark: '' }, positions: [], cash: [] };
}
function object(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !(k in value))) throw new Error('字段缺失或含不支持的额外字段');
}
function text(value: unknown, max = 200): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e15; }
function optionalPositive(value: unknown) { return value === null || positive(value); }
export function validatePortfolio(draft: unknown, now = Date.now()): asserts draft is PortfolioDraft {
  object(draft, ['strategy', 'baseCurrency', 'asOf', 'source', 'rules', 'positions', 'cash']);
  if (draft.strategy !== 'diversified_active' || !currencies.includes(draft.baseCurrency)) throw new Error('策略或基准币种无效');
  const calendarDate = typeof draft.asOf === 'string' ? draft.asOf.slice(0, 10) : '';
  const calendarValid = /^\d{4}-\d{2}-\d{2}$/.test(calendarDate) && new Date(calendarDate).toISOString().slice(0, 10) === calendarDate;
  if (!calendarValid || !text(draft.asOf) || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(draft.asOf) || !Number.isFinite(Date.parse(draft.asOf)) || Date.parse(draft.asOf) > now) throw new Error('快照时间必须是含时区的非未来时间');
  if (!text(draft.source, 1000)) throw new Error('请填写快照来源及核对口径');
  object(draft.rules, ['maxHoldings', 'maxCompanyWeight', 'maxSectorWeight', 'benchmark']);
  if (draft.rules.maxHoldings !== 39 || [draft.rules.maxCompanyWeight, draft.rules.maxSectorWeight].some(v => v !== null && (!positive(v) || v > 1)) || typeof draft.rules.benchmark !== 'string' || draft.rules.benchmark.length > 200) throw new Error('持仓上限固定39；权重上限须为0至1之间的正数或留空');
  if (!Array.isArray(draft.positions) || !Array.isArray(draft.cash) || draft.positions.length > 200 || draft.cash.length > 100 || !draft.positions.length && !draft.cash.length) throw new Error('请录入持仓或现金；明细超出支持范围');
  const seen = new Set<string>();
  for (const p of draft.positions) {
    object(p, ['account', 'code', 'quantity', 'price', 'currency', 'fxToBase']);
    if (!text(p.account, 80) || p.account !== p.account.trim() || !text(p.code, 40) || !/^(?:\d{6}\.(?:SH|SZ|BJ|KS|KQ)|\d{5}\.HK|[A-Z0-9.-]+\.US)$/.test(p.code) || !positive(p.quantity) || !optionalPositive(p.price)) throw new Error('持仓账户、证券代码、数量或价格无效');
    const suffix = p.code.split('.').at(-1)!;
    const expectedCurrency = ({ SH: 'CNY', SZ: 'CNY', BJ: 'CNY', HK: 'HKD', US: 'USD', KS: 'KRW', KQ: 'KRW' } as Record<string, string>)[suffix];
    if (p.currency !== expectedCurrency) throw new Error('持仓价格币种必须匹配证券交易币种');
    const key = JSON.stringify([p.account, p.code]);
    if (seen.has(key)) throw new Error('同账户同证券不能重复；请先合并数量'); seen.add(key);
  }
  const cashSeen = new Set<string>();
  for (const c of draft.cash) {
    object(c, ['account', 'currency', 'amount', 'fxToBase']);
    if (!text(c.account, 80) || c.account !== c.account.trim() || typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount < 0 || c.amount > 1e15) throw new Error('现金金额或账户无效；暂不支持融资与负债账户');
    const key = JSON.stringify([c.account, c.currency]);
    if (cashSeen.has(key)) throw new Error('同账户同币种现金不能重复'); cashSeen.add(key);
  }
  for (const entry of [...draft.positions, ...draft.cash]) {
    if (!currencies.includes(entry.currency) || !optionalPositive(entry.fxToBase) || entry.currency === draft.baseCurrency && entry.fxToBase !== 1) throw new Error('币种或汇率无效；汇率为1单位原币折合基准币，本币必须为1');
  }
}
export function assessPortfolio(current: PortfolioVersion | null, dashboard: ValuationDashboard, now = Date.now()): PortfolioAssessment {
  const tasks: PortfolioTask[] = [];
  const add = (kind: PortfolioTask['kind'], subject: string, title: string, reason: string, evidence: string[], action: string) => {
    // Only semantic changes reopen decisions, not every dashboard computation/poll.
    const id = JSON.stringify([current?.snapshotVersion ?? 0, kind, subject, reason, evidence]);
    const decision = current?.decisions.find(d => d.taskId === id) ?? null;
    tasks.push({ id, kind, subject, title, reason, evidence, action, decision });
  };
  const result: PortfolioAssessment = { nav: null, equityValue: null, cashValue: null, securityCount: 0, companyCount: 0, companies: [], sectors: [], tasks, executable: false,
    limitations: ['分散化主动组合，不复制指数；39只是上限，不要求凑满。', '权重分母为录入的股票市值加现金；不代表未录入的家庭资产。价格、汇率和数量来自人工核对快照，不自动当作最新行情。', '仅覆盖单公司与一级行业集中度；共同因子、币种风险、税费、可交易性与相关性尚未完成验证，不能据此认定组合已充分分散。', '仅提供站内复核待办和决策留痕，不发送外部推送、不自动交易、不生成已执行成交或组合业绩。'] };
  if (!current) { add('setup', 'portfolio', '先建立真实组合快照', '尚无实际持仓与现金，不能从观察池推导调仓。', [], '录入持仓、现金、汇率和组合规则'); return result; }
  const d = current.draft;
  const complete = d.positions.every(p => p.price !== null && p.fxToBase !== null) && d.cash.every(c => c.fxToBase !== null);
  if (!complete) add('data', 'valuation', '组合市值存在缺口', '价格或汇率缺失；总资产及全部权重留空，不以部分资产作分母。', [], '补齐同口径价格和汇率');
  if (now - Date.parse(d.asOf) > 36 * 3600_000 || Date.parse(d.asOf) > now) add('data', 'snapshot', '持仓快照需核对', '快照超过36小时或时间异常；显示的权重仅代表旧快照。', [d.asOf], '核对最新数量、价格、现金和汇率后保存新快照');
  if (complete) {
    result.equityValue = d.positions.reduce((n, p) => n + p.quantity * p.price! * p.fxToBase!, 0);
    result.cashValue = d.cash.reduce((n, c) => n + c.amount * c.fxToBase!, 0);
    result.nav = result.equityValue + result.cashValue;
    if (!Number.isFinite(result.nav) || result.nav <= 0) { result.nav = result.cashValue = result.equityValue = null; add('data', 'nav', '总资产不可计算', '总资产必须为有限正数。', [], '核对资产金额'); }
  }
  const companyValues = new Map<string, { id: string; name: string; value: number }>();
  const sectorValues = new Map<string, { id: string; name: string; value: number }>();
  for (const p of d.positions) {
    const company = securities.get(p.code), id = company?.id ?? p.code;
    const value = complete ? p.quantity * p.price! * p.fxToBase! : 0;
    const previous = companyValues.get(id);
    companyValues.set(id, { id, name: company?.displayName ?? p.code, value: (previous?.value ?? 0) + value });
    const sectorId = company?.primarySectorId ?? 'unknown';
    sectorValues.set(sectorId, { id: sectorId, name: universe.sectors.find(s => s.id === sectorId)?.name ?? '未覆盖行业', value: (sectorValues.get(sectorId)?.value ?? 0) + value });
    if (company && (company.classificationStatus !== 'verified' || !company.securities.find(s => portfolioSecurityCode(s) === p.code)?.identityVerified)) add('data', p.code + ':identity', '证券身份或行业分类待核验', '研究归类不能代替交易权利核验。', [p.code], '核实上市身份、证券权利和行业证据');
    if (!company) add('data', p.code, '持仓未纳入研究覆盖', '观察池外证券的公司合并、行业及研究覆盖待核验。', [p.code], '先补研究身份与分类，不自动剔除真实持仓');
  }
  const weight = (v: { id: string; name: string; value: number }) => ({ ...v, value: result.nav !== null ? v.value : null, weight: result.nav !== null ? v.value / result.nav : null });
  result.companies = [...companyValues.values()].map(weight);
  result.sectors = [...sectorValues.values()].map(weight);
  result.securityCount = new Set(d.positions.map(p => p.code)).size; result.companyCount = companyValues.size;
  if (result.securityCount > 39) add('risk', 'count', '持仓数量超过39只', `当前${result.securityCount}只证券；多账户同证券合并计数。`, [], '人工评估精简方案，不自动卖出');
  for (const [key, rows, label] of [['maxCompanyWeight', result.companies, '单公司'], ['maxSectorWeight', result.sectors, '行业']] as const) {
    const limit = d.rules[key];
    if (limit === null) add('setup', key, `${label}权重上限待配置`, '未配置不等于通过风险约束。', [], '按个人风险承受能力设置上限');
    else for (const row of rows) if (row.weight !== null && row.weight > limit) add('risk', key + ':' + row.id, `${row.name}超过${label}上限`, `快照权重${(row.weight * 100).toFixed(2)}%，上限${(limit * 100).toFixed(2)}%。`, [d.asOf], '比较维持、新增资金调整与减持；先核实快照，勿直接生成交易');
  }
  if (!d.rules.benchmark.trim()) add('setup', 'benchmark', '评价基准待确定', '基准用于评价，不用于机械配仓。', [], '填写长期评价基准及评价期限');
  for (const code of new Set(d.positions.map(p => p.code))) {
    if (!securities.has(code)) continue;
    const row = dashboard.rows.find(r => r.code === code);
    const age = row ? now - Date.parse(row.computation.computedAt) : NaN;
    if (!row?.opportunity || row.computation.revision !== dashboard.revision || !Number.isFinite(age) || age < 0 || age >= dashboard.freshnessMs || dashboard.pending.includes(code)) {
      add('data', code, `${code}研究数据待更新`, '缺少当前有效研究结果，不能解释为经营恶化或安全。', [], '等待后台刷新或检查数据源；不更换行情来源'); continue;
    }
    const op = row.opportunity, flow = op.workflow;
    const evidence = [`研究版本:${row.researchVersion ?? 0}`, `政策:${op.policyVersion}`, `依赖:${row.computation.revision}`, `论点:${flow.thesisStatus}`, ...op.gates.map(g => `${g.key}:${g.state}:${g.reasons.join('；')}`)];
    if (flow.thesisStatus === 'invalidated' || flow.queue === 'review_risk') add('risk', code, `${code}持仓论点或经营风险待复核`, flow.nextAction, evidence, '查看公司证据链，确认原论点是否失效；复核不等于卖出');
    else if (flow.queue === 'repair_data') add('data', code, `${code}研究证据存在缺口`, flow.nextAction, evidence, '修复证据后再判断，不从缺失值推导买卖');
    else if (flow.thesisStatus !== 'reviewed') add('research', code, `${code}持仓论点待验证`, flow.nextAction, evidence, '完成论点与失效条件复核；未复核不自动换仓');
  }
  const heldCompanies = new Set(d.positions.map(p => securities.get(p.code)?.id ?? p.code));
  for (const row of dashboard.rows) {
    const company = securities.get(row.code), op = row.opportunity;
    const age = now - Date.parse(row.computation.computedAt);
    if (!company || heldCompanies.has(company.id) || !op || op.stage !== 'research_candidate' || op.workflow.thesisStatus !== 'reviewed' || !op.gates.every(g => g.state === 'pass') || dashboard.pending.includes(row.code) || row.computation.revision !== dashboard.revision || !Number.isFinite(age) || age < 0 || age >= dashboard.freshnessMs) continue;
    add('research', row.code, `${company.displayName}进入组合适配研究`, '量化初筛与人工论点复核通过，但尚未证明适合当前组合。', [`研究版本:${row.researchVersion ?? 0}`, `政策:${op.policyVersion}`, `依赖:${row.computation.revision}`], '比较维持不动、新增资金与替换持仓；先核验行业/共同风险、交易成本及账户可交易性，不直接买入');
  }
  const rank = { risk: 0, data: 1, setup: 2, research: 3 };
  result.tasks = [...new Map(tasks.map(t => [t.id, t])).values()].sort((a, b) => rank[a.kind] - rank[b.kind]);
  return result;
}

/** Compare a user-authored what-if basket. It never mutates actual holdings. */
export function comparePortfolioProposal(current: PortfolioVersion, input: unknown, dashboard: ValuationDashboard, now = Date.now()): Omit<PortfolioProposal, 'id' | 'createdAt' | 'basedOnSnapshot' | 'status' | 'reviewReason'> {
  object(input, ['title', 'rationale', 'target', 'estimatedCosts', 'externalCashFlow']);
  if (!text(input.title, 120) || !text(input.rationale, 2000)) throw new Error('方案名称和比较理由必填');
  validatePortfolio(input.target, now);
  if (input.estimatedCosts !== null && (typeof input.estimatedCosts !== 'number' || !Number.isFinite(input.estimatedCosts) || input.estimatedCosts < 0 || input.estimatedCosts > 1e15)) throw new Error('费用必须为非负基准币金额或未知');
  if (typeof input.externalCashFlow !== 'number' || !Number.isFinite(input.externalCashFlow) || Math.abs(input.externalCashFlow) > 1e15) throw new Error('新增/提取资金金额无效');
  const proposal = input as PortfolioProposalInput, target = proposal.target;
  if (target.baseCurrency !== current.draft.baseCurrency || target.asOf !== current.draft.asOf || (['maxHoldings', 'maxCompanyWeight', 'maxSectorWeight', 'benchmark'] as const).some(key => target.rules[key] !== current.draft.rules[key])) throw new Error('方案须沿用原快照的时间、基准币种和规则；不能靠改规则消除超限');
  const before = assessPortfolio(current, dashboard, now);
  const after = assessPortfolio({ ...current, draft: target, decisions: [] }, dashboard, now);
  const issues: string[] = [];
  const currenciesByAccount = new Map<string, Set<string>>();
  for (const entry of [...current.draft.positions, ...current.draft.cash, ...target.positions, ...target.cash]) {
    const values = currenciesByAccount.get(entry.account) ?? new Set<string>(); values.add(entry.currency); currenciesByAccount.set(entry.account, values);
  }
  if ([...currenciesByAccount.values()].some(v => v.size > 1)) issues.push('账户涉及多币种，须人工核验换汇、币种现金和账户交易权限。');
  const securityPrices = new Map<string, number | null>();
  for (const position of [...current.draft.positions, ...target.positions]) {
    if (securityPrices.has(position.code) && securityPrices.get(position.code) !== position.price) throw new Error('同一证券跨账户比较必须使用相同价格；请先核对真实快照');
    securityPrices.set(position.code, position.price);
  }
  const changes: PortfolioProposal['comparison']['changes'] = [];
  const keys = new Set([...current.draft.positions, ...target.positions].map(p => JSON.stringify([p.account, p.code])));
  let gross = 0, amountsKnown = true;
  for (const key of keys) {
    const [account, code] = JSON.parse(key);
    const old = current.draft.positions.find(p => p.account === account && p.code === code);
    const next = target.positions.find(p => p.account === account && p.code === code);
    const quote = next ?? old!;
    // Same valuation basis is mandatory; price moves are not purchases or sales.
    if (old && next && (old.price !== next.price || old.fxToBase !== next.fxToBase || old.currency !== next.currency)) throw new Error('同一持仓的价格/汇率不能在方案中变化；请先更新真实快照');
    const difference = (next?.quantity ?? 0) - (old?.quantity ?? 0);
    if (!difference) continue;
    const valueChange = quote.price === null || quote.fxToBase === null ? null : difference * quote.price * quote.fxToBase;
    changes.push({ account, code, beforeQuantity: old?.quantity ?? 0, afterQuantity: next?.quantity ?? 0, valueChange });
    if (valueChange === null) amountsKnown = false; else gross += Math.abs(valueChange);
  }
  // Existing FX rates must also remain consistent across cash and securities.
  const rates = new Map<string, number | null>();
  for (const e of [...current.draft.positions, ...current.draft.cash, ...target.positions, ...target.cash]) {
    if (rates.has(e.currency) && rates.get(e.currency) !== e.fxToBase) throw new Error('同一比较口径的同币种汇率必须一致');
    rates.set(e.currency, e.fxToBase);
  }
  const fundingGap = before.nav !== null && after.nav !== null && proposal.estimatedCosts !== null ? after.nav + proposal.estimatedCosts - before.nav - proposal.externalCashFlow : null;
  if (fundingGap === null) issues.push('估值或费用未齐，资金守恒尚未验证。');
  else if (Math.abs(fundingGap) > .01) issues.push('目标股票与现金、费用、新增资金不平衡；不得当作可执行方案。');
  const accounts = new Set([...current.draft.positions, ...current.draft.cash, ...target.positions, ...target.cash].map(p => p.account));
  if (accounts.size > 1) issues.push('跨账户资金可用性/调拨尚未核验；总资产平衡不代表每个账户可执行。');
  if (before.tasks.some(t => t.kind === 'data' || t.kind === 'setup')) issues.push('原组合存在数据或配置缺口，先完成核对。');
  if (after.tasks.some(t => ['data', 'setup', 'risk'].includes(t.kind))) issues.push('目标组合仍有数据、规则或风险待办，请逐项复核。');
  issues.push('共同风险、交易单位、流动性及实际税费需人工复核；确认方案不等于成交，也不会修改真实持仓。');
  return { ...proposal, before, after, comparison: { changes, turnover: amountsKnown && before.nav !== null ? gross / before.nav : null, fundingGap, issues }, executable: false };
}
