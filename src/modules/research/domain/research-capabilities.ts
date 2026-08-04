import type { Bindings } from "../../../types";

/**
 * Public, read-only description of research runtime capabilities.
 *
 * Client pages must consume this projection rather than infer write access
 * from an environment string.  The same predicate is also used by every
 * research write route, so a new capability cannot accidentally be rendered
 * as enabled while its server boundary is closed (or vice versa).
 */
export type ResearchCapabilityReadModel = Readonly<{
  version: "research-capabilities.v1";
  canWriteLocally: boolean;
  canReviewLocally: boolean;
  canGenerateSynthesisLocally: boolean;
  productionLlmEnabled: false;
}>;

export function researchCapabilities(env: Pick<Bindings, "LLM_RUNTIME">): ResearchCapabilityReadModel {
  const canWriteLocally = canWriteResearchLocally(env);
  return {
    version: "research-capabilities.v1",
    canWriteLocally,
    canReviewLocally: canWriteLocally,
    canGenerateSynthesisLocally: canWriteLocally,
    productionLlmEnabled: false,
  };
}

/** The sole runtime predicate for research writes and local LLM synthesis. */
export function canWriteResearchLocally(env: Pick<Bindings, "LLM_RUNTIME">): boolean {
  return env.LLM_RUNTIME === "local";
}
