/**
 * The former six-stage operating-analysis workflow has been removed. The
 * public routes remain temporarily so old local clients fail visibly instead
 * of silently creating generic task/run/artifact records. They will be
 * removed with the remaining local-job-protocol API cleanup.
 */
export type OperatingAnalysisStageKey = string;
export type OperatingAnalysisStageStatus = string;

const removed = (): never => { throw new Error("legacy operating-analysis workflow has been removed; use operating-analysis-low-dependency"); };

export async function loadResearchOperatingAnalysis(..._args: unknown[]) { return removed(); }
export async function loadResearchOperatingAnalysisRun(..._args: unknown[]) { return removed(); }
export async function enqueueResearchOperatingAnalysis(..._args: unknown[]) { return removed(); }
export async function claimResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function completeResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function startResearchOperatingAnalysisStage(..._args: unknown[]) { return removed(); }
export async function completeResearchOperatingAnalysisStage(..._args: unknown[]) { return removed(); }
export async function failResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function requeueInterruptedResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function heartbeatResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
