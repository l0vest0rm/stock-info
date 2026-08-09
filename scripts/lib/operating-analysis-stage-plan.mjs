/**
 * Runs each dependency wave to completion before releasing its dependants.
 * Promise.allSettled is intentional: when two independent stages share a
 * wave, a failed sibling must not leave the other stream writing after the
 * parent job has been marked failed.
 */
export async function runOperatingAnalysisStageWaves(waves, runStage) {
  const results = [];
  for (const wave of waves) {
    const settled = await Promise.allSettled(wave.map((stage) => runStage(stage)));
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    results.push(...wave.map((stage, index) => ({ stage, output: settled[index].value })));
  }
  return results;
}
