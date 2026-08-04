import {
  diffResearchSnapshotModules,
  type ResearchSnapshotModule,
  type ResearchSnapshotModuleDifference,
} from "./research-risk-review";

/**
 * The public research snapshot is deliberately a separate series from the
 * risk-review snapshot.  It records the state that was actually available at
 * a point in time, using immutable record IDs and source references; it does
 * not manufacture a combined investment conclusion.
 */
export const PUBLIC_RESEARCH_SNAPSHOT_KIND = "public_research_snapshot";

export type PublicResearchSnapshotInput = {
  asOf: number;
  subjectAndMarketStructure: Record<string, unknown>;
  formalFinancialCoverage: Record<string, unknown>;
  operatingModelAndDriverPlan: Record<string, unknown>;
  forecastAndFormalActual: Record<string, unknown>;
  valuationVersions: Record<string, unknown>;
  researchConclusions: Record<string, unknown>;
};

export function buildPublicResearchSnapshotModules(input: PublicResearchSnapshotInput): ResearchSnapshotModule[] {
  const modules: Array<[string, Record<string, unknown>]> = [
    ["subject-and-market-structure", input.subjectAndMarketStructure],
    ["formal-financial-coverage", input.formalFinancialCoverage],
    ["operating-model-and-driver-plan", input.operatingModelAndDriverPlan],
    ["forecast-and-formal-actual", input.forecastAndFormalActual],
    ["valuation-versions", input.valuationVersions],
    ["research-conclusions", input.researchConclusions],
  ];
  return modules.map(([moduleId, payload]) => module(moduleId, input.asOf, payload));
}

export function planPublicResearchSnapshotDifferences(input: {
  differenceIdPrefix: string;
  securityCode: string;
  companyId: string | null;
  baselineSnapshotId: string | null;
  currentSnapshotId: string;
  baselineModules: ResearchSnapshotModule[];
  createdAt: number;
  snapshot: PublicResearchSnapshotInput;
}): { currentModules: ResearchSnapshotModule[]; differences: ResearchSnapshotModuleDifference[] } {
  const currentModules = buildPublicResearchSnapshotModules(input.snapshot);
  return {
    currentModules,
    differences: diffResearchSnapshotModules({
      differenceIdPrefix: input.differenceIdPrefix,
      securityCode: input.securityCode,
      companyId: input.companyId,
      baselineSnapshotId: input.baselineSnapshotId,
      currentSnapshotId: input.currentSnapshotId,
      baseline: input.baselineModules,
      current: currentModules,
      createdAt: input.createdAt,
    }),
  };
}

function module(moduleId: string, asOf: number, payload: Record<string, unknown>): ResearchSnapshotModule {
  assertPublicPayload(payload, moduleId);
  const records = Array.isArray(payload.records) ? payload.records : [];
  return {
    moduleId,
    availability: records.length ? "available" : "empty",
    versionId: records.length ? stableJson(payload) : null,
    // The point-in-time belongs to the parent snapshot.  A module only carries
    // source/version dates inside its frozen payload: using the save time here
    // would falsely mark every unchanged module as changed on the next save.
    asOf: null,
    payload,
  };
}

/** Do not permit a future caller to slip a portfolio/LLM draft into a public replay. */
function assertPublicPayload(value: unknown, label: string): void {
  if (Array.isArray(value)) { value.forEach((item) => assertPublicPayload(item, label)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["ownerKey", "position", "tradePlan", "userDecision", "membership", "localLlmDraft", "synthesisDraft"].includes(key)) {
      throw new Error(`${label} public snapshot cannot contain private or draft field ${key}`);
    }
    if (key === "epistemicType" && nested === "user_decision") throw new Error(`${label} public snapshot cannot contain user decision`);
    assertPublicPayload(nested, label);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
