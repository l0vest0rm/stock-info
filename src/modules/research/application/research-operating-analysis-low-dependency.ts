/**
 * The former low-dependency parent/child generic workflow was replaced by the
 * single taskd-backed investment-analysis task. These compatibility exports
 * make stale local clients fail visibly until their API routes are removed
 * with the rest of the generic local-job protocol.
 */
const removed = (): never => { throw new Error("legacy low-dependency workflow has been removed; use the taskd-backed investment-analysis endpoint"); };

export async function claimLowDependencyResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function completeLowDependencyResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function completeLowDependencyResearchOperatingAnalysisStage(..._args: unknown[]) { return removed(); }
export async function enqueueLowDependencyResearchOperatingAnalysis(..._args: unknown[]) { return removed(); }
export async function failLowDependencyResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function heartbeatLowDependencyResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function loadLowDependencyResearchOperatingAnalysis(..._args: unknown[]) { return removed(); }
export async function requeueInterruptedLowDependencyResearchOperatingAnalysisJob(..._args: unknown[]) { return removed(); }
export async function resumeLowDependencyResearchOperatingAnalysis(..._args: unknown[]) { return removed(); }
export async function startLowDependencyResearchOperatingAnalysisStage(..._args: unknown[]) { return removed(); }
export async function unlockLowDependencyRoutingAfterConfirmation(..._args: unknown[]) { return removed(); }
