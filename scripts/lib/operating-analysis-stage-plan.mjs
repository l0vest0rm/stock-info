import {
  researchOperatingAnalysisWaves,
  RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES,
} from "./research-operating-analysis-stage-registry.mjs";

/**
 * Runs each dependency wave to completion before releasing its dependants.
 * Promise.allSettled is intentional: when two independent stages share a
 * wave, a failed sibling must not leave the other stream writing after the
 * parent job has been marked failed.
 */
export async function runOperatingAnalysisStageWaves(waves, runStage, options = {}) {
  const resourceCap = positiveCap(options.resourceCap);
  const results = [];
  for (const wave of waves) {
    const settled = await Promise.allSettled(runWaveWithCap(wave, runStage, resourceCap));
    if (typeof options.onStageSettled === "function") {
      for (const [index, result] of settled.entries()) await options.onStageSettled(wave[index], result);
    }
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected && options.propagateFailure !== false) throw rejected.reason;
    results.push(...wave.map((stage, index) => ({ stage, output: settled[index].status === "fulfilled" ? settled[index].value : { status: "failed", error: settled[index].reason instanceof Error ? settled[index].reason.message : String(settled[index].reason) } })));
  }
  return results;
}

/** The sole target-registry wave entry point; legacy callers keep the old API. */
export function researchOperatingAnalysisStageWaves(options = {}) {
  return researchOperatingAnalysisWaves({ scopeEnvelopeAvailable: options.scopeEnvelopeAvailable !== false });
}

export async function runResearchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable = true, runStage, resourceCap, onStageSettled } = {}) {
  if (typeof runStage !== "function") throw new Error("research operating-analysis runStage callback is required");
  const statuses = new Map();
  const waves = researchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable });
  const dependencies = (stage) => (scopeEnvelopeAvailable ? stage.dependsOn : stage.fallbackDependsOn);
  const gatedRunStage = async (stage) => {
    const blockedBy = dependencies(stage).filter((dependency) => ["failed", "blocked"].includes(statuses.get(dependency)));
    if (blockedBy.length) return { status: "blocked", blockedBy, reason: "upstream stage did not reach an allowed terminal state" };
    return runStage(stage);
  };
  const record = async (stage, result) => {
    const status = result.status === "fulfilled" ? result.value?.status || "complete" : "failed";
    statuses.set(stage.key, status);
    if (typeof onStageSettled === "function") await onStageSettled(stage, result);
  };
  return runOperatingAnalysisStageWaves(waves, gatedRunStage, { resourceCap, propagateFailure: false, onStageSettled: record });
}

export function researchOperatingAnalysisTargetStageDefinitions() {
  return RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES;
}

function runWaveWithCap(wave, runStage, resourceCap) {
  if (!Number.isFinite(resourceCap) || resourceCap >= wave.length) return wave.map((stage) => runStage(stage));
  const lanes = Array.from({ length: Math.max(1, Math.min(resourceCap, wave.length)) }, () => Promise.resolve());
  return wave.map((stage, index) => {
    const lane = index % lanes.length;
    const result = lanes[lane].then(() => runStage(stage));
    // Keep a failed lane available for the next sibling so Promise.allSettled
    // can observe every stage in the wave before the failure propagates.
    lanes[lane] = result.catch(() => undefined);
    return result;
  });
}

function positiveCap(value) {
  if (value === undefined || value === null || value === "") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}
