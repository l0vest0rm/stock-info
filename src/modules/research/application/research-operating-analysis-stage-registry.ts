import stageRegistryJson from "../../../../config/research-operating-analysis-stages.json";

export type ResearchAnalysisOutputKind = "json" | "markdown";
export type ResearchAnalysisExecution = "model" | "deterministic";
export type ResearchAnalysisStageKey = string;
export type ResearchAnalysisStageStatus = "complete" | "partial" | "blocked" | "not_applicable" | "failed";

export type ResearchAnalysisStageDefinition = {
  key: ResearchAnalysisStageKey;
  label: string;
  outputKind: ResearchAnalysisOutputKind;
  owner: string;
  execution: ResearchAnalysisExecution;
  webSearch: boolean;
  dependsOn: readonly ResearchAnalysisStageKey[];
  fallbackDependsOn: readonly ResearchAnalysisStageKey[];
  schemaVersion: string;
  reportHeadings: readonly string[];
};

type Registry = {
  registryVersion: string;
  targetProtocolVersion: string;
  targetPromptVersion: string;
  targetTaskType: string;
  legacy: { protocolVersion: string; promptVersion: string; taskType: string; stageKeys: string[] };
  stages: ResearchAnalysisStageDefinition[];
  waves: Record<"scopeEnvelope" | "companyScopeFallback", string[][]>;
};

const registry = stageRegistryJson as Registry;
const stageKeys = new Set(registry.stages.map((stage) => stage.key));
const legacyStageKeys = new Set(registry.legacy.stageKeys);

validateRegistry(registry);

export const RESEARCH_OPERATING_ANALYSIS_STAGE_REGISTRY_VERSION = registry.registryVersion;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION = registry.targetProtocolVersion;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION = registry.targetPromptVersion;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE = registry.targetTaskType;
export const RESEARCH_OPERATING_ANALYSIS_LEGACY_PROTOCOL_VERSION = registry.legacy.protocolVersion;
export const RESEARCH_OPERATING_ANALYSIS_LEGACY_PROMPT_VERSION = registry.legacy.promptVersion;
export const RESEARCH_OPERATING_ANALYSIS_LEGACY_TASK_TYPE = registry.legacy.taskType;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES: readonly ResearchAnalysisStageDefinition[] = Object.freeze(registry.stages.map((stage) => Object.freeze({
  ...stage,
  dependsOn: Object.freeze([...stage.dependsOn]),
  fallbackDependsOn: Object.freeze([...stage.fallbackDependsOn]),
  reportHeadings: Object.freeze([...stage.reportHeadings]),
})));
const stageMap = new Map(RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((stage) => [stage.key, stage]));

export function getResearchOperatingAnalysisStage(key: string): ResearchAnalysisStageDefinition {
  const stage = stageMap.get(String(key));
  if (!stage) throw new Error(`unsupported low-dependency research-analysis stage: ${key}`);
  return stage;
}

export function isResearchOperatingAnalysisTargetStage(key: string): boolean {
  return stageKeys.has(String(key));
}

export function isResearchOperatingAnalysisLegacyStage(key: string): boolean {
  return legacyStageKeys.has(String(key));
}

export function researchOperatingAnalysisDependencies(key: string, options: { scopeEnvelopeAvailable?: boolean } = {}): readonly ResearchAnalysisStageKey[] {
  const stage = getResearchOperatingAnalysisStage(key);
  return options.scopeEnvelopeAvailable === false ? stage.fallbackDependsOn : stage.dependsOn;
}

export function researchOperatingAnalysisWaves(options: { scopeEnvelopeAvailable?: boolean } = {}): readonly (readonly ResearchAnalysisStageDefinition[])[] {
  const name = options.scopeEnvelopeAvailable === false ? "companyScopeFallback" : "scopeEnvelope";
  return registry.waves[name].map((wave) => wave.map((key) => getResearchOperatingAnalysisStage(key)));
}

export function researchOperatingAnalysisTaskIdentity(targetId: string, options: { idempotencyKey?: string; promptVersion?: string } = {}) {
  const normalizedTargetId = String(targetId || "").trim();
  if (!normalizedTargetId) throw new Error("low-dependency research-analysis targetId is required");
  const promptVersion = options.promptVersion || RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION;
  if (promptVersion !== RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION) throw new Error("low-dependency research-analysis task cannot use the legacy prompt version");
  return {
    taskType: RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE,
    targetType: "security",
    targetId: normalizedTargetId,
    idempotencyKey: options.idempotencyKey || `research-operating-analysis-low-dependency:${normalizedTargetId}`,
    protocolVersion: RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION,
    promptVersion,
  } as const;
}

export function terminalResearchOperatingAnalysisStatuses(): readonly ResearchAnalysisStageStatus[] {
  return ["complete", "partial", "blocked", "not_applicable", "failed"];
}

function validateRegistry(value: Registry): void {
  if (!value.registryVersion || !value.targetProtocolVersion || !value.targetPromptVersion || !value.targetTaskType) throw new Error("research-analysis stage registry versions are required");
  if (!value.legacy || !value.legacy.protocolVersion || !value.legacy.promptVersion || !value.legacy.taskType || !Array.isArray(value.legacy.stageKeys)) throw new Error("research-analysis legacy registry boundary is invalid");
  const seen = new Set<string>();
  for (const stage of value.stages) {
    if (!stage.key || seen.has(stage.key)) throw new Error(`duplicate research-analysis stage key: ${stage.key}`);
    seen.add(stage.key);
    if (!stage.owner || !stage.schemaVersion || !Array.isArray(stage.dependsOn) || !Array.isArray(stage.fallbackDependsOn) || !Array.isArray(stage.reportHeadings) || stage.reportHeadings.length === 0) throw new Error(`incomplete research-analysis stage contract: ${stage.key}`);
    if (!["json", "markdown"].includes(stage.outputKind) || !["model", "deterministic"].includes(stage.execution)) throw new Error(`invalid research-analysis stage contract: ${stage.key}`);
  }
  for (const stage of value.stages) {
    for (const dependency of [...stage.dependsOn, ...stage.fallbackDependsOn]) {
      if (!seen.has(dependency) || dependency === stage.key) throw new Error(`invalid research-analysis dependency ${dependency} for ${stage.key}`);
    }
  }
  for (const name of ["scopeEnvelope", "companyScopeFallback"] as const) {
    const waveKeys = value.waves[name]?.flat() || [];
    if (waveKeys.length !== seen.size || new Set(waveKeys).size !== seen.size || waveKeys.some((key) => !seen.has(key))) throw new Error(`research-analysis ${name} waves must cover every target stage exactly once`);
  }
  if (value.legacy.stageKeys.some((key) => seen.has(key))) throw new Error("legacy and low-dependency stage keys must remain disjoint");
}
