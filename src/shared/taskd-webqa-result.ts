export type TaskdRichContent = {
  format: "web-helper.rich-content.v1";
  markdown: string;
  assets: unknown[];
};

export type TaskdWebQaResult = {
  format: "taskd.webqa.result.v2";
  content: TaskdRichContent;
  citations: unknown[];
  sources: unknown[];
  rawSnapshot: Record<string, unknown>;
  terminalEvidence: Record<string, unknown>;
  execution: Record<string, unknown>;
};

/**
 * taskd.result_json is the authoritative WebQA artifact. Do not add a
 * root-level Markdown fallback here: a mismatched result contract must remain
 * visible to the business projection that received it.
 */
export function extractTaskdWebQaResult(value: unknown): TaskdWebQaResult {
  const result = record(value);
  if (result?.format !== "taskd.webqa.result.v2") {
    throw new Error("taskd WebQA result must use taskd.webqa.result.v2");
  }
  const content = record(result.content);
  if (
    content?.format !== "web-helper.rich-content.v1"
    || typeof content.markdown !== "string"
    || !Array.isArray(content.assets)
  ) {
    throw new Error("taskd WebQA result must include web-helper.rich-content.v1 content");
  }
  if (!Array.isArray(result.citations) || !Array.isArray(result.sources)) {
    throw new Error("taskd WebQA result must preserve citations and sources arrays");
  }
  const rawSnapshot = record(result.raw_snapshot);
  const terminalEvidence = record(result.terminal_evidence);
  const execution = record(result.execution);
  if (!rawSnapshot || !terminalEvidence || !execution) {
    throw new Error("taskd WebQA result must preserve raw_snapshot, terminal_evidence, and execution");
  }
  return {
    format: "taskd.webqa.result.v2",
    content: {
      format: "web-helper.rich-content.v1",
      markdown: content.markdown,
      assets: content.assets,
    },
    citations: result.citations,
    sources: result.sources,
    rawSnapshot,
    terminalEvidence,
    execution,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
