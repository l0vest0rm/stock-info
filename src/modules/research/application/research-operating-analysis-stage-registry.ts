import stageRegistryJson from "../../../../config/research-operating-analysis-stages.json";

export type ResearchAnalysisOutputKind = "json" | "markdown";
export type ResearchAnalysisExecution = "model" | "deterministic";
export type ResearchAnalysisStageKey = string;
export type ResearchAnalysisStageStatus = "complete" | "partial" | "blocked" | "not_applicable" | "failed";
export type ResearchAnalysisWorkPackageExecution = "model" | "deterministic";
export type ResearchAnalysisWorkPackageDefinition = {
  key: string;
  label: string;
  execution: ResearchAnalysisWorkPackageExecution;
  outputKind: string;
  promptVersion: string | null;
  stageKeys: readonly ResearchAnalysisStageKey[];
  reportReadyStageKeys: readonly ResearchAnalysisStageKey[];
  dependsOn: readonly string[];
  inputPackageKeys: readonly string[];
  webSearch: boolean;
  finalReport?: boolean;
  bypassed?: boolean;
  inputProjection: string;
};

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
  workPackageVersion: string;
  legacy: { protocolVersion: string; promptVersion: string; taskType: string; stageKeys: string[] };
  stages: ResearchAnalysisStageDefinition[];
  workPackages: ResearchAnalysisWorkPackageDefinition[];
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
export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION = registry.workPackageVersion;
export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES: readonly ResearchAnalysisWorkPackageDefinition[] = Object.freeze(registry.workPackages.map((definition) => Object.freeze({
  ...definition,
  promptVersion: definition.promptVersion || null,
  stageKeys: Object.freeze([...definition.stageKeys]),
  reportReadyStageKeys: Object.freeze([...(definition.reportReadyStageKeys || [])]),
  dependsOn: Object.freeze([...definition.dependsOn]),
  inputPackageKeys: Object.freeze([...(definition.inputPackageKeys || definition.dependsOn || [])]),
  finalReport: definition.finalReport === true,
  bypassed: definition.bypassed === true,
})));
const stageMap = new Map(RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((stage) => [stage.key, stage]));
const workPackageMap = new Map(RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.map((definition) => [definition.key, definition]));
const workPackageByStage = new Map(RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.flatMap((definition) => definition.stageKeys.map((key) => [key, definition])));

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

export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION = "research-operating-analysis.work-package-envelope.v1";

export function getResearchOperatingAnalysisWorkPackage(key: string): ResearchAnalysisWorkPackageDefinition {
  const definition = workPackageMap.get(String(key));
  if (!definition) throw new Error(`unsupported research-analysis work package: ${key}`);
  return definition;
}

export function isResearchOperatingAnalysisWorkPackage(key: string): boolean {
  return workPackageMap.has(String(key));
}

export function workPackageForStage(stageKey: string): ResearchAnalysisWorkPackageDefinition | null {
  return workPackageByStage.get(String(stageKey)) || null;
}

export function researchOperatingAnalysisGenerativeWorkPackages(): readonly ResearchAnalysisWorkPackageDefinition[] {
  return RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.filter((definition) => definition.execution === "model" && !definition.bypassed);
}

export function isFinalReportWorkPackage(key: string): boolean {
  return getResearchOperatingAnalysisWorkPackage(key).finalReport === true;
}

export function researchOperatingAnalysisWorkPackageStageKeys(key: string): readonly string[] {
  return getResearchOperatingAnalysisWorkPackage(key).stageKeys;
}

export function researchOperatingAnalysisWorkPackageWaves(): readonly (readonly ResearchAnalysisWorkPackageDefinition[])[] {
  const remaining = new Set(RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.map((definition) => definition.key));
  const waves: ResearchAnalysisWorkPackageDefinition[][] = [];
  while (remaining.size) {
    const ready = RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.filter((definition) => remaining.has(definition.key) && definition.dependsOn.every((dependency) => !remaining.has(dependency)));
    if (!ready.length) throw new Error("research-analysis work package dependency graph contains a cycle");
    waves.push(ready);
    ready.forEach((definition) => remaining.delete(definition.key));
  }
  return waves;
}

function validateRegistry(value: Registry): void {
  if (!value.registryVersion || !value.targetProtocolVersion || !value.targetPromptVersion || !value.targetTaskType || !value.workPackageVersion) throw new Error("research-analysis stage registry versions are required");
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
  const packageStageKeys = new Set<string>();
  for (const definition of value.workPackages) {
    if (!definition.key || !definition.label || !["model", "deterministic"].includes(definition.execution)) throw new Error(`invalid research-analysis work package: ${definition.key}`);
    if (!definition.stageKeys.length) throw new Error(`work package ${definition.key} must own at least one stage`);
    if (definition.finalReport && definition.execution !== "model") throw new Error(`final-report work package ${definition.key} must use model execution`);
    if (definition.bypassed && definition.execution !== "deterministic") throw new Error(`bypassed work package ${definition.key} must be deterministic`);
    if (definition.finalReport && (!definition.stageKeys.includes("report_assembly") || definition.outputKind !== "final_markdown")) throw new Error(`final-report work package ${definition.key} must own report_assembly as final_markdown`);
    for (const stageKey of definition.stageKeys) {
      if (!seen.has(stageKey)) throw new Error(`unknown work-package stage ${stageKey}`);
      if (packageStageKeys.has(stageKey)) throw new Error(`work-package stage is duplicated: ${stageKey}`);
      packageStageKeys.add(stageKey);
    }
    if (definition.execution === "model" && !definition.promptVersion) throw new Error(`model work package ${definition.key} requires promptVersion`);
    if (definition.execution === "deterministic" && definition.promptVersion) throw new Error(`deterministic work package ${definition.key} cannot declare promptVersion`);
    for (const dependency of definition.dependsOn) if (!value.workPackages.some((candidate) => candidate.key === dependency)) throw new Error(`unknown work package dependency ${dependency}`);
    for (const reportKey of definition.reportReadyStageKeys || []) if (!seen.has(reportKey)) throw new Error(`unknown work-package report-ready stage ${reportKey}`);
  }
  if (packageStageKeys.size !== seen.size) throw new Error("work packages must cover every target stage exactly once");
}
