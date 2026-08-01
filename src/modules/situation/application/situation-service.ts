import topicProfiles from "../config/topic-profiles.json";
import personalActionPolicy from "../config/personal-action-policy.json";
import type { ActionType, EvidenceInput, SituationCandidate, SituationEvidence, SituationEvent, SituationImpact } from "../domain/model";
import { D1SituationRepository } from "./situation-repository";

type TopicProfile = { id: string; eventType: string; terms: string[]; importance: SituationEvent["importance"]; transmission: string; targets: Array<{ type: SituationImpact["targetType"]; id: string; direction: SituationImpact["direction"] }> };
type ActionPolicy = { version: string; companyWeight: { activeCap: number; rebalanceThreshold: number }; urgentExitTerms: string[]; entryRequirements: string[]; addRequirements: string[] };
type HoldingInput = { currentWeight?: number; targetWeight?: number; maxWeight?: number; thesisIntact?: boolean; researchComplete?: boolean; fundamentalsConfirmed?: boolean; marketConfirmed?: boolean; valuationEntryReady?: boolean; valuationAddReady?: boolean; valuationTrimReady?: boolean; invalidations?: string[] };
const profiles = topicProfiles as TopicProfile[];
const actionPolicy = personalActionPolicy as ActionPolicy;
export const SITUATION_RULE_VERSION = "2026-08-01.1";

export async function ingestEvidence(repository: D1SituationRepository, input: EvidenceInput, now = Date.now()): Promise<{ evidence: SituationEvidence; event: SituationEvent | null; created: boolean }> {
  const evidence: SituationEvidence = {
    evidenceId: `evidence:${crypto.randomUUID()}`,
    sourceId: input.sourceId,
    externalId: input.externalId ?? null,
    url: input.url,
    title: input.title.trim(),
    excerpt: input.excerpt?.trim() || null,
    publishedAt: Number(input.publishedAt),
    fetchedAt: input.fetchedAt && Number.isFinite(input.fetchedAt) ? input.fetchedAt : now,
    entities: [...new Set((input.entities ?? []).map(normalizeEntity).filter(Boolean))],
    metadata: input.metadata ?? {},
    evidenceGrade: input.evidenceGrade ?? "single_source_lead",
    status: "active",
    createdAt: now,
  };
  await repository.upsertSource({ sourceId: input.sourceId, name: input.sourceName?.trim() || input.sourceId, kind: input.sourceKind?.trim() || "scheduled_search", now });
  const persisted = await repository.putEvidence(evidence);
  if (!persisted.created) return { evidence: persisted.evidence, event: null, created: false };
  const profile = matchProfile(evidence);
  if (!profile) return { evidence, event: null, created: true };
  const dateKey = new Date(evidence.publishedAt).toISOString().slice(0, 10);
  const canonicalKey = `${profile.id}:${dateKey}:${canonicalTitle(evidence.title)}`;
  const eventBase: Omit<SituationEvent, "evidence"> = {
    eventId: `event:${crypto.randomUUID()}`, canonicalKey, title: evidence.title, occurredAt: evidence.publishedAt,
    region: String(evidence.metadata.region ?? "global"), eventType: profile.eventType,
    status: evidence.evidenceGrade === "official_confirmed" ? "confirmed" : evidence.evidenceGrade === "conflicting" ? "conflicting" : "lead",
    importance: profile.importance, summary: evidence.excerpt, firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now,
  };
  let event = await repository.upsertEvent(eventBase);
  await repository.linkEventEvidence(event.eventId, evidence.evidenceId, evidence.evidenceGrade === "conflicting" ? "conflicting" : "primary", gradeConfidence(evidence.evidenceGrade), now);
  event = (await repository.getEvent(event.eventId, now))!;
  const sourceCount = new Set(event.evidence.filter((item) => item.evidenceGrade !== "conflicting").map((item) => item.sourceId)).size;
  const upgradedStatus: SituationEvent["status"] = event.evidence.some((item) => item.evidenceGrade === "conflicting") ? "conflicting" : event.evidence.some((item) => item.evidenceGrade === "official_confirmed") || sourceCount >= 2 ? "confirmed" : "lead";
  if (event.status !== upgradedStatus) {
    event = await repository.upsertEvent({ ...event, status: upgradedStatus, lastSeenAt: now, updatedAt: now });
  }
  for (const target of profile.targets) await repository.putImpact(makeImpact(event, target, profile.transmission, now));
  for (const code of evidence.entities.filter(isCompanyCode)) await repository.putImpact(makeImpact(event, { type: "company", id: code, direction: profile.id === "company-governance-risk" ? "pressure" : "unknown" }, profile.transmission, now));
  return { evidence, event, created: true };
}

export async function refreshOwnerCandidates(repository: D1SituationRepository, ownerKey: string, codes: string[], asOf = Date.now()): Promise<SituationCandidate[]> {
  const normalizedCodes = [...new Set(codes.map(normalizeEntity).filter(isCompanyCode))];
  const events = await repository.listEvents({ asOf, limit: 100 });
  const profiles = await repository.listHoldingProfiles(ownerKey, normalizedCodes);
  const profilesByCode = new Map(profiles.map((item) => [item.code, parseHoldingInput(item.profile)]));
  const knownCodes = new Set(profilesByCode.keys());
  const portfolioRules = await repository.getPortfolioRules(ownerKey);
  const impacts = await repository.listImpacts({ asOf, targetType: "company", targetIds: normalizedCodes });
  const created: SituationCandidate[] = [];
  for (const event of events) {
    const related = normalizedCodes.filter((code) => event.evidence.some((evidence) => evidence.entities.includes(code)) || impacts.some((impact) => impact.eventId === event.eventId && impact.targetId === code));
    for (const code of related) {
      const actionType: ActionType = "review";
      const candidate = candidateForEvent(ownerKey, event, code, actionType, knownCodes.has(code), asOf);
      await repository.putCandidate(candidate);
      created.push(candidate);
      const profile = profilesByCode.get(code);
      if (profile && (fraction(profile.currentWeight) ?? 0) > 0 && isUrgentExitEvent(event)) {
        const exitCandidate = candidateForProfile(ownerKey, code, "exit", profile, asOf, { event });
        await repository.putCandidate(exitCandidate);
        created.push(exitCandidate);
      }
    }
    if (event.status === "confirmed" && event.eventType === "industry") {
      const impactTargets = await repository.listImpacts({ asOf, eventId: event.eventId });
      for (const impact of impactTargets.filter((item) => item.targetType === "industry")) {
        const candidate = candidateForEvent(ownerKey, event, impact.targetId, "research", true, asOf);
        await repository.putCandidate(candidate);
        created.push(candidate);
      }
    }
  }
  for (const [code, profile] of profilesByCode) {
    const profileCandidates = profileActionCandidates(ownerKey, code, profile, portfolioRules, asOf);
    await repository.resolveProfileCandidates(ownerKey, code, profileCandidates.map((item) => item.candidateId), `${SITUATION_RULE_VERSION}/`, asOf);
    for (const candidate of profileCandidates) {
      await repository.putCandidate(candidate);
      created.push(candidate);
    }
  }
  await repository.putSnapshot({ snapshotId: `snapshot:${crypto.randomUUID()}`, asOf, scopeType: "portfolio", scopeId: ownerKey,
    state: created.some((item) => item.priority >= 80) ? "needs_attention" : created.length ? "watch" : "calm",
    confidence: normalizedCodes.length ? Math.min(1, profiles.length / normalizedCodes.length) : 0,
    summary: { codes: normalizedCodes, profileCoverage: { configured: profiles.length, requested: normalizedCodes.length }, generatedCandidates: created.map((item) => item.candidateId) }, ruleVersion: SITUATION_RULE_VERSION, createdAt: asOf });
  return repository.listCandidates(ownerKey, asOf, { targetIds: [...normalizedCodes, "semiconductor"] });
}

export function summarizeSituation(input: { candidates: SituationCandidate[]; events: SituationEvent[]; sources: Array<{ state: string }>; asOf: number }) {
  const failedSources = input.sources.filter((item) => item.state === "failed").length;
  const urgent = input.candidates.filter((item) => item.priority >= 80 && item.status === "open");
  const state = urgent.length ? "needs_attention" : failedSources ? "data_degraded" : input.candidates.length ? "watch" : "calm";
  return { state, confidence: input.sources.length ? (input.sources.length - failedSources) / input.sources.length : 0, urgentCount: urgent.length,
    headline: urgent.length ? "存在需要优先核查的持仓或风险事件" : failedSources ? "部分来源不可用，结论已降级" : input.candidates.length ? "存在待核查的市场与行业变化" : "当前没有满足执行条件的交易动作", asOf: input.asOf };
}

function candidateForEvent(ownerKey: string, event: SituationEvent, targetId: string, actionType: ActionType, hasProfile: boolean, asOf: number): SituationCandidate {
  const evidence = event.evidence.map((item) => ({ evidenceId: item.evidenceId, title: item.title, url: item.url, grade: item.evidenceGrade }));
  const priority = event.status === "conflicting" ? 65 : event.importance === "high" ? 80 : event.importance === "medium" ? 55 : 35;
  const idSeed = `${ownerKey}|${event.eventId}|${targetId}|${actionType}`;
  return { candidateId: `candidate:${stableId(idSeed)}`, ownerKey, asOf, actionType, targetType: actionType === "research" ? "industry" : "company", targetId,
    priority, status: hasProfile || actionType === "research" ? "open" : "blocked",
    prerequisites: hasProfile || actionType === "research" ? ["核对最新原始证据", "确认价格、估值和组合约束"] : ["补充该公司的持仓档案、逻辑证伪条件和目标仓位"],
    proposedPlan: { summary: actionType === "research" ? "进入行业研究，等待基本面、市场确认和估值条件齐备。" : "先复核持仓逻辑与证据；未满足个人规则前不执行买卖。", eventId: event.eventId },
    invalidations: ["事件证据被撤回或出现冲突", "后续公告/数据未确认", "不通过个人集中度或风险预算检查"], evidence, ruleVersion: SITUATION_RULE_VERSION,
    expiresAt: asOf + 7 * 86_400_000, createdAt: asOf, updatedAt: asOf, latestDisposition: null };
}
function profileActionCandidates(ownerKey: string, code: string, profile: HoldingInput, rules: Record<string, unknown> | null, asOf: number): SituationCandidate[] {
  const currentWeight = fraction(profile.currentWeight); const targetWeight = fraction(profile.targetWeight); const configuredMax = fraction(profile.maxWeight);
  const activeCap = fraction(rules?.companyActiveCap) ?? configuredMax ?? actionPolicy.companyWeight.activeCap;
  const rebalanceThreshold = fraction(rules?.companyRebalanceThreshold) ?? Math.max(actionPolicy.companyWeight.rebalanceThreshold, activeCap);
  const cashWeight = fraction(rules?.cashWeight);
  if (currentWeight !== null && currentWeight > 0 && profile.thesisIntact === false) return [candidateForProfile(ownerKey, code, "exit", profile, asOf, { reason: "持仓档案已标记核心逻辑失效" })];
  if (currentWeight !== null && currentWeight >= rebalanceThreshold) return [candidateForProfile(ownerKey, code, "rebalance", profile, asOf, { reason: `当前权重 ${(currentWeight * 100).toFixed(1)}% 已达到再平衡线 ${(rebalanceThreshold * 100).toFixed(1)}%`, activeCap })];
  if (currentWeight !== null && targetWeight !== null && currentWeight > targetWeight || profile.valuationTrimReady === true) return [candidateForProfile(ownerKey, code, "reduce", profile, asOf, { reason: profile.valuationTrimReady ? "持仓档案已标记估值兑现/减仓条件成立" : "当前权重高于目标仓位", activeCap })];
  if (currentWeight === 0 && meets(profile, actionPolicy.entryRequirements) && cashWeight !== null && cashWeight > 0) return [candidateForProfile(ownerKey, code, "establish", profile, asOf, { reason: "研究、基本面、市场与估值入场条件均已由持仓档案确认", activeCap })];
  if (currentWeight !== null && currentWeight > 0 && targetWeight !== null && currentWeight < targetWeight && currentWeight < activeCap && meets(profile, actionPolicy.addRequirements)) return [candidateForProfile(ownerKey, code, "add", profile, asOf, { reason: "核心逻辑、估值加仓条件与目标仓位均已由持仓档案确认", activeCap })];
  return [];
}
function candidateForProfile(ownerKey: string, code: string, actionType: ActionType, profile: HoldingInput, asOf: number, context: Record<string, unknown>): SituationCandidate {
  const priority = actionType === "exit" ? 100 : actionType === "rebalance" ? 90 : actionType === "reduce" ? 75 : actionType === "add" || actionType === "establish" ? 60 : 50;
  const targetWeight = fraction(profile.targetWeight); const maxWeight = fraction(profile.maxWeight) ?? actionPolicy.companyWeight.activeCap;
  const event = context.event as SituationEvent | undefined;
  const idSeed = `${ownerKey}|profile|${code}|${actionType}`;
  return { candidateId: `candidate:${stableId(idSeed)}`, ownerKey, asOf, actionType, targetType: "company", targetId: code, priority, status: "open",
    prerequisites: actionType === "exit" ? ["核对原始公告/持仓逻辑与可交易性", "记录无法立即执行的停牌、涨跌停或流动性限制"] : ["核对最新价格、估值、现金和交易后集中度", "按预先登记的分批与交易时段执行"],
    proposedPlan: { summary: actionSummary(actionType), targetWeight, maxWeight, context },
    invalidations: profile.invalidations?.length ? profile.invalidations : ["个人档案中的逻辑、估值、现金或集中度条件发生变化", "原始证据被撤回或后续数据否定"],
    evidence: event ? event.evidence.map((item) => ({ evidenceId: item.evidenceId, title: item.title, url: item.url, grade: item.evidenceGrade })) : [{ type: "holding_profile", code, context }],
    ruleVersion: `${SITUATION_RULE_VERSION}/${actionPolicy.version}`, expiresAt: asOf + (actionType === "exit" ? 2 : 7) * 86_400_000, createdAt: asOf, updatedAt: asOf, latestDisposition: null };
}
function actionSummary(actionType: ActionType): string { return ({ establish: "满足建仓前提；请按目标仓位与分批计划复核后执行。", add: "满足加仓前提；请先确认剩余风险预算和集中度空间。", reduce: "出现减仓或估值兑现条件；请复核目标权重和交易成本。", exit: "触发逻辑证伪或高可靠风险条件；请优先评估退出与执行限制。", rebalance: "仓位超过再平衡线；请按主动上限复核降仓计划。", research: "进入研究。", review: "需要核查。" })[actionType]; }
function parseHoldingInput(profile: Record<string, unknown>): HoldingInput { return { currentWeight: numeric(profile.currentWeight), targetWeight: numeric(profile.targetWeight), maxWeight: numeric(profile.maxWeight), thesisIntact: bool(profile.thesisIntact), researchComplete: bool(profile.researchComplete), fundamentalsConfirmed: bool(profile.fundamentalsConfirmed), marketConfirmed: bool(profile.marketConfirmed), valuationEntryReady: bool(profile.valuationEntryReady), valuationAddReady: bool(profile.valuationAddReady), valuationTrimReady: bool(profile.valuationTrimReady), invalidations: Array.isArray(profile.invalidations) ? profile.invalidations.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4) : [] }; }
function meets(profile: HoldingInput, requirements: string[]): boolean { return requirements.every((key) => profile[key as keyof HoldingInput] === true); }
function fraction(value: unknown): number | null { const numericValue = numeric(value); return numericValue !== undefined && numericValue >= 0 && numericValue <= 1 ? numericValue : null; }
function numeric(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function bool(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function isUrgentExitEvent(event: SituationEvent): boolean { if (event.status !== "confirmed" || event.eventType !== "company") return false; const text = event.evidence.map((item) => `${item.title} ${item.excerpt ?? ""}`).join(" ").toLocaleLowerCase("zh-CN"); return actionPolicy.urgentExitTerms.some((term) => text.includes(term.toLocaleLowerCase("zh-CN"))); }
function makeImpact(event: SituationEvent, target: { type: SituationImpact["targetType"]; id: string; direction: SituationImpact["direction"] }, transmission: string, now: number): SituationImpact {
  return { impactId: `impact:${stableId(`${event.eventId}|${target.type}|${target.id}|${transmission}`)}`, eventId: event.eventId, signalId: null, targetType: target.type, targetId: target.id, direction: target.direction, transmission, confidence: event.status === "confirmed" ? 0.7 : 0.35, rationale: { eventId: event.eventId, status: event.status, transmission }, expiresAt: now + 14 * 86_400_000, createdAt: now };
}
function matchProfile(evidence: SituationEvidence): TopicProfile | null { const text = `${evidence.title} ${evidence.excerpt ?? ""}`.toLocaleLowerCase("zh-CN"); return profiles.find((profile) => profile.terms.some((term) => text.includes(term.toLocaleLowerCase("zh-CN")))) ?? null; }
function canonicalTitle(title: string): string { return title.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 48) || "event"; }
function gradeConfidence(grade: string): number { return grade === "official_confirmed" ? 1 : grade === "multi_source_confirmed" ? 0.75 : grade === "single_source_lead" ? 0.4 : 0.1; }
function normalizeEntity(value: string): string { return value.trim().toUpperCase(); }
function isCompanyCode(value: string): boolean { return /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK|[A-Z.]{1,12}\.US)$/.test(value); }
function stableId(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }
