import { D1SituationRepository } from "./situation-repository";
import { refreshOwnerCandidates } from "./situation-service";
import { buildMacroSituationSignals } from "./build-macro-situation-signals";
import { syncSituationKnowledgeEvidence } from "./sync-situation-knowledge";
import { D1MacroRepository } from "../../macro/application/macro-repository";
import type { Bindings } from "../../../types";

/**
 * The scheduler never fetches arbitrary news itself. Source adapters/importers
 * persist Evidence first; this job only expires stale work and re-evaluates
 * deterministic portfolio candidates from the evidence already available.
 */
export async function syncSituationData(env: Bindings, scheduledTime = Date.now()): Promise<{ owner: string; holdings: number; candidates: number; macroSignals: number; knowledge: Awaited<ReturnType<typeof syncSituationKnowledgeEvidence>> }> {
  const repository = new D1SituationRepository(env.DB);
  const owner = "local";
  const knowledge = await syncSituationKnowledgeEvidence(env, scheduledTime);
  const macroSignals = await buildMacroSituationSignals(new D1MacroRepository(env.DB), scheduledTime);
  for (const signal of macroSignals) {
    const signalId = `signal:${stableId(`${signal.subjectType}|${signal.subjectId}|${scheduledTime}`)}`;
    const direction = signal.state === "supportive" ? "support" : signal.state === "pressure" ? "pressure" : signal.state === "mixed" ? "mixed" : "unknown";
    await repository.putSignal({ signalId, subjectType: signal.subjectType, subjectId: signal.subjectId, ruleId: "macro-factor-exposure", ruleVersion: "2026-08-01.1", state: signal.state, score: signal.score, confidence: signal.confidence, observedAt: scheduledTime, expiresAt: scheduledTime + 2 * 86_400_000, input: signal.input, explanation: signal.explanation, createdAt: scheduledTime });
    await repository.putImpact({ impactId: `impact:${stableId(`${signalId}|${signal.subjectType}|${signal.subjectId}`)}`, eventId: null, signalId, targetType: signal.subjectType, targetId: signal.subjectId, direction, transmission: "macro_factor", confidence: signal.confidence, rationale: { signalId, state: signal.state, score: signal.score, name: signal.name }, expiresAt: scheduledTime + 2 * 86_400_000, createdAt: scheduledTime });
    await repository.putSnapshot({ snapshotId: `snapshot:${stableId(`${signal.subjectType}|${signal.subjectId}|${scheduledTime}`)}`, asOf: scheduledTime, scopeType: signal.subjectType, scopeId: signal.subjectId, state: signal.state, confidence: signal.confidence, summary: { headline: `${signal.name}：${stateLabel(signal.state)}`, name: signal.name, score: signal.score, signalId, explanation: signal.explanation, input: signal.input }, ruleVersion: "2026-08-01.1", createdAt: scheduledTime });
  }
  const holdings = await repository.listHoldingProfiles(owner);
  const candidates = await refreshOwnerCandidates(repository, owner, holdings.map((item) => item.code), scheduledTime);
  return { owner, holdings: holdings.length, candidates: candidates.length, macroSignals: macroSignals.length, knowledge };
}

function stateLabel(state: string): string { return state === "supportive" ? "环境偏支持" : state === "pressure" ? "环境有压力" : state === "mixed" ? "信号分歧" : "数据不足"; }
function stableId(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }
