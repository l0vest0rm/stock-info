import stageRegistry from "../../config/research-operating-analysis-stages.json" with { type: "json" };
import {
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES as WORK_PACKAGE_DEFINITIONS,
  getResearchOperatingAnalysisWorkPackage,
  isResearchOperatingAnalysisWorkPackage,
  researchOperatingAnalysisGenerativeWorkPackages,
  researchOperatingAnalysisWorkPackageStageKeys,
  researchOperatingAnalysisWorkPackageWaves,
  workPackageForStage,
  isFinalReportWorkPackage,
  normalizeFinalReportMarkdown,
  parseWorkPackageEnvelopeJson,
  projectWorkPackageStages,
  normalizeWorkPackageEnvelope,
} from "./research-operating-analysis-work-packages.mjs";

const terminalStatuses = ["complete", "partial", "blocked", "not_applicable", "failed"];
const stageKeys = new Set(stageRegistry.stages.map((stage) => stage.key));
const legacyStageKeys = new Set(stageRegistry.legacy.stageKeys);

validateRegistry(stageRegistry);

export const RESEARCH_OPERATING_ANALYSIS_STAGE_REGISTRY_VERSION = stageRegistry.registryVersion;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION = stageRegistry.targetProtocolVersion;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION = stageRegistry.targetPromptVersion;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE = stageRegistry.targetTaskType;
export const RESEARCH_OPERATING_ANALYSIS_LEGACY_PROTOCOL_VERSION = stageRegistry.legacy.protocolVersion;
export const RESEARCH_OPERATING_ANALYSIS_LEGACY_PROMPT_VERSION = stageRegistry.legacy.promptVersion;
export const RESEARCH_OPERATING_ANALYSIS_LEGACY_TASK_TYPE = stageRegistry.legacy.taskType;
export const RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES = Object.freeze(stageRegistry.stages.map((stage) => freezeStage(stage)));
export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE = RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION;
export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION = RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION;
export const RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES = WORK_PACKAGE_DEFINITIONS;

const byKey = new Map(RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((stage) => [stage.key, stage]));

export function getResearchOperatingAnalysisStage(key) {
  const stage = byKey.get(String(key));
  if (!stage) throw new Error(`unsupported low-dependency research-analysis stage: ${String(key)}`);
  return stage;
}
export function isResearchOperatingAnalysisTargetStage(key) {
  return stageKeys.has(String(key));
}

export function isResearchOperatingAnalysisLegacyStage(key) {
  return legacyStageKeys.has(String(key));
}

export function researchOperatingAnalysisDependencies(key, { scopeEnvelopeAvailable = true } = {}) {
  const stage = getResearchOperatingAnalysisStage(key);
  return [...(scopeEnvelopeAvailable ? stage.dependsOn : stage.fallbackDependsOn)];
}

export function researchOperatingAnalysisWaves({ scopeEnvelopeAvailable = true } = {}) {
  const name = scopeEnvelopeAvailable ? "scopeEnvelope" : "companyScopeFallback";
  return stageRegistry.waves[name].map((wave) => wave.map((key) => getResearchOperatingAnalysisStage(key)));
}

export function researchOperatingAnalysisTaskIdentity(targetId, { idempotencyKey, promptVersion = RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION } = {}) {
  const normalizedTargetId = String(targetId || "").trim();
  if (!normalizedTargetId) throw new Error("low-dependency research-analysis targetId is required");
  if (promptVersion !== RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION) throw new Error("low-dependency research-analysis task cannot use the legacy prompt version");
  return {
    taskType: RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE,
    targetType: "security",
    targetId: normalizedTargetId,
    idempotencyKey: String(idempotencyKey || `research-operating-analysis-low-dependency:${normalizedTargetId}`),
    protocolVersion: RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION,
    promptVersion,
  };
}

export function terminalResearchOperatingAnalysisStatuses() {
  return [...terminalStatuses];
}

export {
  getResearchOperatingAnalysisWorkPackage,
  isResearchOperatingAnalysisWorkPackage,
  researchOperatingAnalysisGenerativeWorkPackages,
  researchOperatingAnalysisWorkPackageStageKeys,
  researchOperatingAnalysisWorkPackageWaves,
  workPackageForStage,
  isFinalReportWorkPackage,
  normalizeFinalReportMarkdown,
  parseWorkPackageEnvelopeJson,
  projectWorkPackageStages,
  normalizeWorkPackageEnvelope,
};

function validateRegistry(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.stages)) throw new Error("research-analysis stage registry is invalid");
  if (!String(value.registryVersion || "").trim() || !String(value.targetProtocolVersion || "").trim() || !String(value.targetPromptVersion || "").trim() || !String(value.targetTaskType || "").trim()) throw new Error("research-analysis stage registry versions are required");
  if (!value.legacy || !Array.isArray(value.legacy.stageKeys) || !String(value.legacy.promptVersion || "").trim()) throw new Error("research-analysis legacy registry boundary is invalid");
  const seen = new Set();
  for (const stage of value.stages) {
    if (!stage || typeof stage !== "object" || !String(stage.key || "").trim()) throw new Error("research-analysis stage key is required");
    if (seen.has(stage.key)) throw new Error(`duplicate research-analysis stage key: ${stage.key}`);
    seen.add(stage.key);
    if (!["json", "markdown"].includes(stage.outputKind) || !["model", "deterministic"].includes(stage.execution)) throw new Error(`invalid research-analysis stage contract: ${stage.key}`);
    if (!Array.isArray(stage.dependsOn) || !Array.isArray(stage.fallbackDependsOn) || !Array.isArray(stage.reportHeadings) || !String(stage.schemaVersion || "").trim()) throw new Error(`incomplete research-analysis stage contract: ${stage.key}`);
  }
  for (const stage of value.stages) {
    for (const dependency of [...stage.dependsOn, ...stage.fallbackDependsOn]) {
      if (!seen.has(dependency)) throw new Error(`unknown research-analysis dependency ${dependency} for ${stage.key}`);
      if (dependency === stage.key) throw new Error(`self-dependent research-analysis stage: ${stage.key}`);
    }
  }
  for (const name of ["scopeEnvelope", "companyScopeFallback"]) {
    const waves = value.waves?.[name];
    if (!Array.isArray(waves) || !waves.length) throw new Error(`research-analysis ${name} waves are required`);
    const waveKeys = waves.flat();
    if (waveKeys.length !== seen.size || new Set(waveKeys).size !== seen.size || waveKeys.some((key) => !seen.has(key))) throw new Error(`research-analysis ${name} waves must cover every target stage exactly once`);
  }
  if (value.legacy.stageKeys.some((key) => seen.has(key))) throw new Error("legacy and low-dependency stage keys must remain disjoint");
  const packageStageKeys = new Set();
  for (const definition of WORK_PACKAGE_DEFINITIONS) {
    for (const stageKey of definition.stageKeys) {
      if (!seen.has(stageKey)) throw new Error(`unknown work-package stage ${stageKey}`);
      if (packageStageKeys.has(stageKey)) throw new Error(`work-package stage is duplicated: ${stageKey}`);
      packageStageKeys.add(stageKey);
    }
    for (const reportKey of definition.reportReadyStageKeys) if (!seen.has(reportKey)) throw new Error(`unknown work-package report-ready stage ${reportKey}`);
  }
  if (packageStageKeys.size !== seen.size) throw new Error("work packages must cover every target stage exactly once");
}

function freezeStage(stage) {
  return Object.freeze({
    key: stage.key,
    label: stage.label,
    outputKind: stage.outputKind,
    owner: stage.owner,
    execution: stage.execution,
    webSearch: stage.webSearch === true,
    dependsOn: Object.freeze([...stage.dependsOn]),
    fallbackDependsOn: Object.freeze([...stage.fallbackDependsOn]),
    schemaVersion: stage.schemaVersion,
    reportHeadings: Object.freeze([...stage.reportHeadings]),
  });
}
