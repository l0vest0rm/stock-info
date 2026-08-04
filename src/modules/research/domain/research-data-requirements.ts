import requirementConfig from "../../../../config/research-data-requirements.json";

export type ResearchDataRequirementStatus = "available" | "partial" | "missing" | "stale" | "conflict" | "source_error";
export type ResearchSourceHealthStatus = "available" | "partial" | "missing" | "stale" | "conflict" | "source_error";

type SourceConfig = {
  sourceId: string;
  label: string;
  policy: string;
  statePath: string;
  observedAtPath?: string;
  errorPath?: string;
  conflictCountPath?: string;
  maxAgeDays?: number;
};

type RequirementConfig = {
  requirementId: string;
  category: string;
  label: string;
  primarySources: string[];
  crossSources: string[];
  frequency: string;
  epistemicType: string;
  allOf: string[];
  anyOf?: string[];
  conflictPaths?: string[];
  asOfPath?: string;
  missingImpact: string;
  nextEvidence: string;
};

type Config = { version: string; sources: SourceConfig[]; requirements: RequirementConfig[] };
const config = requirementConfig as Config;

export type ResearchSourceHealth = {
  sourceId: string;
  label: string;
  policy: string;
  status: ResearchSourceHealthStatus;
  observedAt: number | null;
  ageDays: number | null;
  conflictCount: number;
  detail: string;
};

export type ResearchDataRequirement = {
  requirementId: string;
  category: string;
  label: string;
  primarySources: ResearchSourceHealth[];
  crossSources: ResearchSourceHealth[];
  frequency: string;
  epistemicType: string;
  status: ResearchDataRequirementStatus;
  asOf: number | null;
  staleAfterDays: number | null;
  conflictCount: number;
  missingImpact: string;
  nextEvidence: string;
};

export type ResearchDataRequirementCoverage = {
  ruleVersion: string;
  asOf: number;
  requirements: ResearchDataRequirement[];
  sourceHealth: ResearchSourceHealth[];
};

type Signals = Record<string, unknown>;

/**
 * A configuration-driven fact-requirement read model.  It deliberately keeps
 * availability, conflicts, freshness and their conclusion impact separate;
 * there is no aggregate completion percentage to hide a blocking input.
 */
export function buildResearchDataRequirementCoverage(input: { asOf?: number; signals: Signals }): ResearchDataRequirementCoverage {
  const asOf = validTimestamp(input.asOf) ?? Date.now();
  const sourceHealth = config.sources.map((source) => buildSourceHealth(source, input.signals, asOf));
  const bySource = new Map(sourceHealth.map((source) => [source.sourceId, source]));
  const requirements = config.requirements.map((requirement) => buildRequirement(requirement, input.signals, bySource, asOf));
  return { ruleVersion: required(config.version, "data-requirement config version"), asOf, requirements, sourceHealth };
}

function buildRequirement(requirement: RequirementConfig, signals: Signals, bySource: Map<string, ResearchSourceHealth>, now: number): ResearchDataRequirement {
  const primarySources = lookupSources(requirement.primarySources, bySource);
  const crossSources = lookupSources(requirement.crossSources, bySource);
  const all = requirement.allOf.map((path) => signalState(readPath(signals, path)));
  const any = (requirement.anyOf ?? []).map((path) => signalState(readPath(signals, path)));
  const conflictCount = (requirement.conflictPaths ?? []).reduce((total, path) => total + count(readPath(signals, path)), 0);
  const sourceError = [...primarySources, ...crossSources].some((source) => source.status === "source_error");
  const asOf = parseTimestamp(requirement.asOfPath ? readPath(signals, requirement.asOfPath) : null);
  const staleAfterDays = minimumPositive([...primarySources, ...crossSources].map((source) => sourceAgePolicy(source.sourceId)));
  const stale = asOf !== null && staleAfterDays !== null && ageDays(asOf, now) > staleAfterDays;
  const allAvailable = all.length > 0 && all.every((state) => state === "available");
  const anyAvailable = any.length === 0 || any.some((state) => state === "available");
  const someSignal = [...all, ...any].some((state) => state === "available" || state === "partial");
  // A source can have a conflict for a different fact/period.  Only the
  // config-declared conflict paths may escalate this requirement; source
  // health still exposes every source conflict beside the requirement.
  const status: ResearchDataRequirementStatus = conflictCount > 0 ? "conflict"
    : sourceError ? "source_error"
      : allAvailable && anyAvailable ? stale ? "stale" : "available"
        : someSignal ? "partial" : "missing";
  return {
    requirementId: required(requirement.requirementId, "data requirement id"), category: required(requirement.category, "data requirement category"), label: required(requirement.label, "data requirement label"),
    primarySources, crossSources, frequency: required(requirement.frequency, "data requirement frequency"), epistemicType: required(requirement.epistemicType, "data requirement epistemic type"),
    status, asOf, staleAfterDays, conflictCount,
    missingImpact: required(requirement.missingImpact, "data requirement missing impact"), nextEvidence: required(requirement.nextEvidence, "data requirement next evidence"),
  };
}

function buildSourceHealth(source: SourceConfig, signals: Signals, now: number): ResearchSourceHealth {
  const state = signalState(readPath(signals, source.statePath));
  const observedAt = parseTimestamp(source.observedAtPath ? readPath(signals, source.observedAtPath) : null);
  const conflictCount = count(source.conflictCountPath ? readPath(signals, source.conflictCountPath) : 0);
  const error = text(source.errorPath ? readPath(signals, source.errorPath) : null);
  const stale = observedAt !== null && Number.isFinite(source.maxAgeDays) && ageDays(observedAt, now) > Number(source.maxAgeDays);
  const status: ResearchSourceHealthStatus = error || state === "source_error" ? "source_error"
    : conflictCount > 0 ? "conflict"
      : state === "available" ? stale ? "stale" : "available"
        : state === "partial" ? "partial" : "missing";
  const detail = error || (conflictCount > 0 ? `存在 ${conflictCount} 项已记录冲突。`
    : status === "stale" ? `最近观察已超过 ${source.maxAgeDays} 天时效策略。`
      : status === "missing" ? "当前公司/证券尚无可用观察；这不是对供应商全局状态的判断。"
        : source.policy);
  return {
    sourceId: required(source.sourceId, "source id"), label: required(source.label, "source label"), policy: required(source.policy, "source policy"), status,
    observedAt, ageDays: observedAt === null ? null : ageDays(observedAt, now), conflictCount, detail,
  };
}

function lookupSources(ids: string[], bySource: Map<string, ResearchSourceHealth>) {
  return ids.map((id) => {
    const source = bySource.get(id);
    if (!source) throw new Error(`data requirement refers to unknown source: ${id}`);
    return source;
  });
}

function sourceAgePolicy(sourceId: string): number | null {
  const source = config.sources.find((item) => item.sourceId === sourceId);
  return typeof source?.maxAgeDays === "number" && source.maxAgeDays > 0 ? source.maxAgeDays : null;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)[key] : undefined, value);
}

function signalState(value: unknown): "available" | "partial" | "missing" | "source_error" {
  if (value === true) return "available";
  const normalized = text(value).toLowerCase();
  if (["available", "ready", "verified", "confirmed"].includes(normalized)) return "available";
  if (["partial", "provisional", "needs_review", "unavailable"].includes(normalized)) return "partial";
  if (["source_error", "error", "failed"].includes(normalized)) return "source_error";
  return "missing";
}

function parseTimestamp(value: unknown): number | null {
  if (validTimestamp(value)) return validTimestamp(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validTimestamp(value: unknown): number | null {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function ageDays(timestamp: number, now: number): number { return Math.max(0, Math.floor((now - timestamp) / 86_400_000)); }
function count(value: unknown): number { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function required(value: string, label: string): string { const result = String(value || "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function minimumPositive(values: Array<number | null>): number | null { const positive = values.filter((value): value is number => typeof value === "number" && value > 0); return positive.length ? Math.min(...positive) : null; }
