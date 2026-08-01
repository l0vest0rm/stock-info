export const evidenceGrades = ["official_confirmed", "multi_source_confirmed", "single_source_lead", "conflicting", "stale", "unavailable"] as const;
export type EvidenceGrade = typeof evidenceGrades[number];
export const actionTypes = ["research", "establish", "add", "reduce", "exit", "rebalance", "review"] as const;
export type ActionType = typeof actionTypes[number];
export type EvidenceInput = {
  sourceId: string;
  sourceName?: string;
  sourceKind?: string;
  externalId?: string | null;
  url: string;
  title: string;
  excerpt?: string | null;
  publishedAt: number;
  fetchedAt?: number;
  entities?: string[];
  metadata?: Record<string, unknown>;
  evidenceGrade?: EvidenceGrade;
};
export type SituationEvidence = Required<Omit<EvidenceInput, "sourceName" | "sourceKind" | "fetchedAt" | "entities" | "metadata" | "evidenceGrade">> & {
  evidenceId: string; fetchedAt: number; entities: string[]; metadata: Record<string, unknown>; evidenceGrade: EvidenceGrade; status: string; createdAt: number;
};
export type SituationEvent = { eventId: string; canonicalKey: string; title: string; occurredAt: number; region: string; eventType: string; status: "lead" | "confirmed" | "conflicting" | "expired" | "retracted"; importance: "low" | "medium" | "high" | "unclassified"; summary: string | null; firstSeenAt: number; lastSeenAt: number; createdAt: number; updatedAt: number; evidence: SituationEvidence[] };
export type SituationImpact = { impactId: string; eventId: string | null; signalId: string | null; targetType: "market" | "industry" | "company" | "portfolio"; targetId: string; direction: "support" | "pressure" | "mixed" | "unknown"; transmission: string; confidence: number; rationale: Record<string, unknown>; expiresAt: number | null; createdAt: number };
export type SituationSignal = { signalId: string; subjectType: "market" | "industry" | "company" | "portfolio"; subjectId: string; ruleId: string; ruleVersion: string; state: string; score: number | null; confidence: number; observedAt: number; expiresAt: number | null; input: Record<string, unknown>; explanation: Record<string, unknown>; createdAt: number };
export type SituationCandidate = { candidateId: string; ownerKey: string; asOf: number; actionType: ActionType; targetType: "market" | "industry" | "company" | "portfolio"; targetId: string; priority: number; status: "open" | "blocked" | "expired" | "resolved"; prerequisites: unknown[]; proposedPlan: Record<string, unknown>; invalidations: unknown[]; evidence: unknown[]; ruleVersion: string; expiresAt: number | null; createdAt: number; updatedAt: number; latestDisposition: { disposition: string; note: string | null; createdAt: number } | null };

export function validOwnerKey(value: string): boolean { return /^[A-Za-z0-9:_-]{1,80}$/.test(value); }
export function validEvidenceInput(value: unknown): value is EvidenceInput {
  if (!isRecord(value) || !validId(value.sourceId) || !validUrl(value.url) || !nonEmptyString(value.title) || !Number.isFinite(Number(value.publishedAt))) return false;
  return value.evidenceGrade === undefined || evidenceGrades.includes(value.evidenceGrade as EvidenceGrade);
}
export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:_-]{1,120}$/.test(value); }
function validUrl(value: unknown): boolean { try { const url = new URL(String(value)); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
