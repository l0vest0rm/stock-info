export const AUTOMATIC_INFORMATION_PROCESSING_BATCH_SIZE = 1;
export const DEFAULT_AUTOMATIC_INFORMATION_PROCESSING_REQUEST_TIMEOUT_MS = 240_000;

/**
 * Runs a bounded number of durable automatic-processing cursor steps.
 *
 * The local processing endpoint persists its cursor after each terminal
 * document attempt. One HTTP request therefore owns one step, so slow model
 * calls cannot accumulate into an unresponsive multi-document response.
 */
export async function runAutomaticInformationProcessing({
  enabled,
  remote,
  server = "http://127.0.0.1:8000",
  concurrency = 1,
  maxDocuments = 1,
  maxAgeDays = 30,
  titleKeywords = [],
  requestTimeoutMs = DEFAULT_AUTOMATIC_INFORMATION_PROCESSING_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const requestedLimit = boundedInteger(maxDocuments, 0, 200, 1);
  const normalizedConcurrency = boundedInteger(concurrency, 1, 20, 1);
  const normalizedMaxAgeDays = boundedInteger(maxAgeDays, 1, 365, 30);
  const normalizedTimeoutMs = boundedInteger(requestTimeoutMs, 1_000, 20 * 60_000, DEFAULT_AUTOMATIC_INFORMATION_PROCESSING_REQUEST_TIMEOUT_MS);
  const normalizedTitleKeywords = Array.isArray(titleKeywords) ? titleKeywords.map(text).filter(Boolean).slice(0, 100) : [];
  if (!enabled || remote) return { enabled: Boolean(enabled), skipped: remote ? "remote_import" : "disabled", processed: 0 };
  if (requestedLimit === 0) {
    return {
      enabled: true, status: "completed", concurrency: normalizedConcurrency, maxDocuments: requestedLimit,
      maxAgeDays: normalizedMaxAgeDays, requestTimeoutMs: normalizedTimeoutMs,
      batchSize: AUTOMATIC_INFORMATION_PROCESSING_BATCH_SIZE, triggerSource: "automatic",
      titleKeywords: normalizedTitleKeywords, skipped: "max_documents_zero", requested: 0,
      processed: 0, failed: 0, needsReview: 0, batches: 0,
    };
  }

  const result = {
    enabled: true, status: "completed", enqueued: 0, autoEnqueued: 0,
    concurrency: normalizedConcurrency, maxDocuments: requestedLimit, maxAgeDays: normalizedMaxAgeDays,
    requestTimeoutMs: normalizedTimeoutMs, batchSize: AUTOMATIC_INFORMATION_PROCESSING_BATCH_SIZE,
    triggerSource: "automatic", titleKeywords: normalizedTitleKeywords, skipped: "", requested: 0,
    processed: 0, failed: 0, needsReview: 0, batches: 0, cursorReset: false,
  };
  const endpoint = `${text(server).replace(/\/$/, "")}/api/knowledge/processing-jobs`;
  for (let step = 0; step < requestedLimit; step += 1) {
    let response;
    let payload;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(normalizedTimeoutMs),
        body: JSON.stringify({
          auto: true,
          concurrency: normalizedConcurrency,
          maxDocuments: AUTOMATIC_INFORMATION_PROCESSING_BATCH_SIZE,
          maxAgeDays: normalizedMaxAgeDays,
          triggerSource: "automatic",
          titleKeywords: normalizedTitleKeywords,
        }),
      });
      payload = await response.json().catch(() => null);
    } catch (error) {
      return incomplete(result, step + 1, `automatic processing request failed: ${errorMessage(error)}`);
    }
    if (!response.ok || !payload || payload.code !== 200) {
      return incomplete(result, step + 1, `automatic processing request failed: ${text(payload?.msg) || response.status}`);
    }
    const data = object(payload.data);
    const requested = nonNegativeInteger(data.requested);
    if (requested > AUTOMATIC_INFORMATION_PROCESSING_BATCH_SIZE) {
      return incomplete(result, step + 1, `automatic processing endpoint violated the single-step contract: requested=${requested}`);
    }
    result.batches += 1;
    result.enqueued += nonNegativeInteger(data.enqueued);
    result.autoEnqueued += nonNegativeInteger(data.auto_enqueued);
    result.requested += requested;
    const results = Array.isArray(data.results) ? data.results : [];
    result.processed += results.filter((item) => object(item).status !== "failed").length;
    result.failed += results.filter((item) => object(item).status === "failed").length;
    result.needsReview += results.filter((item) => Boolean(object(item).needsReview)).length;
    result.cursorReset = Boolean(data.cursor_reset);
    if (requested === 0 || result.cursorReset) break;
  }
  return result;
}

function incomplete(result, step, error) { return { ...result, status: "incomplete", failedStep: step, error }; }
function boundedInteger(value, minimum, maximum, fallback) { const parsed = Number(value); return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback; }
function nonNegativeInteger(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return String(value ?? "").trim(); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
