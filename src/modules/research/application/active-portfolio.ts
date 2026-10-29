import type { Database } from '../../../platform/contracts';
import type { PortfolioVersion, PortfolioDecision, PortfolioRead } from '../../../../shared/active-portfolio';
import type { ValuationDashboard } from '../../../../shared/valuation-dashboard';
import { assessPortfolio, portfolioTemplate, validatePortfolio, comparePortfolioProposal } from '../domain/active-portfolio';

const namespace = 'private-active-portfolio-v1';
export class PortfolioConflict extends Error {}
export async function portfolioVersions(db: Database): Promise<PortfolioVersion[]> {
  const rows = await db.prepare('select value_json from kv_cache where namespace = ? order by key desc limit 100').bind(namespace).all<{ value_json: string }>();
  return rows.results.map(r => JSON.parse(r.value_json));
}
export async function readPortfolio(db: Database, dashboard: ValuationDashboard): Promise<PortfolioRead> {
  const versions = await portfolioVersions(db), current = versions[0] ?? null;
  return { current, template: portfolioTemplate(), assessment: assessPortfolio(current, dashboard), history: versions.map(v => ({ version: v.version, snapshotVersion: v.snapshotVersion, recordedAt: v.recordedAt })) };
}
export async function writePortfolio(db: Database, expectedVersion: number, command: unknown, dashboard: ValuationDashboard): Promise<PortfolioVersion> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('expectedVersion无效');
  const current = (await portfolioVersions(db))[0] ?? null;
  if ((current?.version ?? 0) !== expectedVersion) throw new PortfolioConflict('记录已更新；请重新读取后合并，原记录未覆盖');
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('命令无效');
  const input = command as Record<string, unknown>, now = Date.now(), recordedAt = new Date(now).toISOString();
  let next: PortfolioVersion;
  if (input.type === 'snapshot') {
    if (Object.keys(input).some(k => !['type', 'draft'].includes(k))) throw new Error('快照命令含额外字段');
    validatePortfolio(input.draft, now);
    next = { version: expectedVersion + 1, snapshotVersion: expectedVersion + 1, recordedAt, draft: input.draft, decisions: [], proposals: current?.proposals ?? [] };
  } else if (input.type === 'decision') {
    if (!current || Object.keys(input).some(k => !['type', 'taskId', 'choice', 'reason', 'until'].includes(k))) throw new Error('需先建立快照，且仅接受决策字段');
    if (!['keep', 'reviewed', 'defer'].includes(String(input.choice)) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) throw new Error('请选择处理方式并填写理由');
    const until = input.until;
    if (input.choice === 'defer' ? typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(until) || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= now : until !== null) throw new Error('延期须填写含时区的未来复核时间，其他处理方式until须为null');
    const task = assessPortfolio(current, dashboard, now).tasks.find(t => t.id === input.taskId);
    if (!task) throw new PortfolioConflict('待办依据已变化，请刷新后重新判断');
    const { decision: _decision, ...evidence } = task;
    const decision: PortfolioDecision = { taskId: task.id, choice: input.choice as PortfolioDecision['choice'], reason: input.reason.trim(), until: until as string | null, recordedAt, task: evidence };
    next = { ...current, version: expectedVersion + 1, recordedAt, decisions: [decision, ...current.decisions.filter(d => d.taskId !== task.id)].slice(0, 300) };
  } else if (input.type === 'proposal') {
    if (!current || Object.keys(input).some(k => !['type', 'proposal'].includes(k))) throw new Error('需先建立真实组合；方案命令字段无效');
    const compared = comparePortfolioProposal(current, input.proposal, dashboard, now);
    const proposal = { ...compared, id: `proposal-${expectedVersion + 1}`, basedOnSnapshot: current.snapshotVersion, createdAt: recordedAt, status: 'draft' as const, reviewReason: null };
    next = { ...current, version: expectedVersion + 1, recordedAt, proposals: [proposal, ...(current.proposals ?? [])].slice(0, 10) };
  } else if (input.type === 'review_proposal') {
    if (!current || Object.keys(input).some(k => !['type', 'id', 'status', 'reason'].includes(k)) || !['confirmed', 'rejected'].includes(String(input.status)) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) throw new Error('方案处理方式与理由无效');
    const proposal = current.proposals?.find(p => p.id === input.id);
    if (!proposal || proposal.status !== 'draft') throw new PortfolioConflict('方案不存在或已经处理');
    if (proposal.basedOnSnapshot !== current.snapshotVersion) throw new PortfolioConflict('真实快照已变化，须重新生成对比');
    if (input.status === 'confirmed') {
      const comparison = comparePortfolioProposal(current, { title: proposal.title, rationale: proposal.rationale, target: proposal.target, estimatedCosts: proposal.estimatedCosts, externalCashFlow: proposal.externalCashFlow }, dashboard, now);
      const taskIds = (assessment: typeof comparison.before) => JSON.stringify(assessment.tasks.map(t => t.id).sort());
      if (taskIds(comparison.before) !== taskIds(proposal.before) || taskIds(comparison.after) !== taskIds(proposal.after)) throw new PortfolioConflict('研究或风险依据已变化，请重新生成方案对比');
      if (comparison.comparison.fundingGap === null || Math.abs(comparison.comparison.fundingGap) > .01 || comparison.after.securityCount > 39 || now - Date.parse(current.draft.asOf) > 36 * 3600_000) throw new Error('方案资金不平衡、费用/估值缺失、持仓超限或快照过期；不能记录采纳');
    }
    // Confirmation is only a recorded human decision, never permission to execute.
    next = { ...current, version: expectedVersion + 1, recordedAt, proposals: current.proposals!.map(p => p.id === input.id ? { ...p, status: input.status as 'confirmed' | 'rejected', reviewReason: input.reason as string } : p) };
  } else throw new Error('不支持的命令；不接受交易执行指令');
  try {
    await db.prepare('insert into kv_cache(namespace,key,value_json,expires_at,updated_at) values(?,?,?,null,?)').bind(namespace, String(next.version).padStart(12, '0'), JSON.stringify(next), now).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) throw new PortfolioConflict('并发编辑冲突；未覆盖原记录，请刷新');
    throw error;
  }
  return next;
}
