import { RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS, RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME, ownsResearchOperatingAnalysisRunnerLease } from "./research-operating-analysis-runner-lease";
type Row = Record<string, unknown>;
type ModelPrompt = { model?: string; instructions: string; userPrompt: string };

/** One complete long-form investment-research document generated locally by llm-client. */
export const OPERATING_ANALYSIS_PROMPT_VERSION = "investment-analysis.llm-client.v2";
export const OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT = "max";
export const OPERATING_ANALYSIS_REQUIRED_HEADINGS = [
  "商业模式与赚钱机制",
  "市场空间、产品边界与收入传导",
  "行业阶段、供给约束与竞争",
  "当前增长、驱动与可持续性",
  "利润质量、现金转换与营运资本",
  "资本效率与资本配置",
  "证券定价与反证",
  "当前价格隐含的经营要求",
  "关键估值情景与假设",
  "主报告最可能出错之处与反面证据",
  "投资逻辑失效路径",
  "后续跟踪指标与触发阈值",
] as const;
const reasoningEfforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
type StreamStats = {
  webSearch?: { searched: boolean; queryCount: number; citedPageCount: number };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number };
};
type ReportRunRow = Row & { runId?: string };

function reasoningEffort(value: unknown) {
  const effort = text(value) || OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT;
  if (!reasoningEfforts.has(effort)) throw new Error("unsupported operating-analysis reasoning effort");
  return effort;
}

export async function loadResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  try {
    const [run, job, versions] = await Promise.all([
      findResearchOperatingAnalysisRun(db, code),
      db.prepare(`select security_code as securityCode, prompt_version as promptVersion, status, run_id as runId,
        attempt_count as attemptCount, reasoning_effort as reasoningEffort, last_error as lastError, created_at as createdAt, started_at as startedAt,
        completed_at as completedAt, updated_at as updatedAt, partial_report_markdown as partialReportMarkdown,
        partial_reasoning_markdown as partialReasoningMarkdown,
        partial_stream_stats_json as streamStatsJson, prompt_json as promptJson, partial_updated_at as partialUpdatedAt from research_operating_analysis_jobs
        where security_code=? and prompt_version=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>(),
      db.prepare(`select run_id as runId, prompt_version as promptVersion, provider, generated_at as generatedAt,
        total_duration_ms as totalDurationMs from research_operating_analysis_runs
        where security_code=? and prompt_version=? order by generated_at desc`)
        .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).all<ReportRunRow>(),
    ]);
    return {
      availability: run || job ? "available" as const : "empty" as const,
      run: normalizeResearchOperatingAnalysisRun(run),
      job: job ? { ...job, prompt: normalizeModelPrompt(parseJson(text(job.promptJson))), streamStats: normalizeStreamStats(parseJson(text(job.streamStatsJson))) } : null,
      versions: versions.results.map(({ runId, promptVersion, provider, generatedAt, totalDurationMs }) => ({ runId, promptVersion, provider, generatedAt, totalDurationMs })),
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable" as const, run: null, job: null };
    throw error;
  }
}

/** Load a durable completed report by its opaque run identifier. */
export async function loadResearchOperatingAnalysisRun(db: D1Database, securityCode: string, runId: string) {
  const code = securityCode.trim().toUpperCase();
  const id = runId.trim();
  if (!id) return null;
  try { return normalizeResearchOperatingAnalysisRun(await findResearchOperatingAnalysisRun(db, code, id)); }
  catch (error) {
    if (/no such table/i.test(String(error))) return null;
    throw error;
  }
}

function findResearchOperatingAnalysisRun(db: D1Database, code: string, runId?: string) {
  return db.prepare(`select run_id as runId, security_code as securityCode, prompt_version as promptVersion,
    input_fingerprint as inputFingerprint, input_as_of as inputAsOf, input_json as inputJson,
    report_markdown as reportMarkdown, reasoning_markdown as reasoningMarkdown,
    total_duration_ms as totalDurationMs, stream_stats_json as streamStatsJson, prompt_json as promptJson, provider, generated_at as generatedAt
    from research_operating_analysis_runs where security_code=? and prompt_version=?${runId ? " and run_id=?" : ""} order by generated_at desc limit 1`)
    .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, ...(runId ? [runId] : [])).first<ReportRunRow>();
}

function normalizeResearchOperatingAnalysisRun(run: ReportRunRow | null) {
  return run ? { ...run, input: parseJson(text(run.inputJson)), prompt: normalizeModelPrompt(parseJson(text(run.promptJson))), streamStats: normalizeStreamStats(parseJson(text(run.streamStatsJson))) } : null;
}

export async function enqueueResearchOperatingAnalysis(db: D1Database, securityCode: string, force = false, requestedReasoningEffort: unknown = OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT) {
  const code = securityCode.trim().toUpperCase();
  const effort = reasoningEffort(requestedReasoningEffort);
  const now = Date.now();
  const existing = await db.prepare(`select status from research_operating_analysis_jobs where security_code=? and prompt_version=?`)
    .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  if (existing && existing.status !== "failed" && !force) return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  if (existing) {
    await db.prepare(`update research_operating_analysis_jobs set status='queued', run_id=null, reasoning_effort=?, last_error=null,
      started_at=null, completed_at=null, partial_report_markdown=null, partial_reasoning_markdown=null, partial_stream_stats_json=null, prompt_json=null, partial_updated_at=null, lease_owner=null, updated_at=? where security_code=? and prompt_version=?`)
      .bind(effort, now, code, OPERATING_ANALYSIS_PROMPT_VERSION).run();
  } else {
    await db.prepare(`insert into research_operating_analysis_jobs (security_code, prompt_version, status, reasoning_effort, attempt_count, created_at, updated_at)
      values (?, ?, 'queued', ?, 0, ?, ?)`)
      .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, effort, now, now).run();
  }
  return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: false };
}

export async function claimResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchOperatingAnalysisRunnerLease(db, runnerInstanceId)) return null;
  const now = Date.now();
  // A Responses stream cannot be resumed by a replacement Node process. Once
  // this runner has acquired the expired lease, make that interruption visible
  // and leave the saved partial text available for the user to retry.
  await db.prepare(`update research_operating_analysis_jobs set status='failed',
    last_error='local llm-client runner restarted before this stream finished; retry the report',
    completed_at=?, updated_at=? where prompt_version=? and status='running'
    and (lease_owner is null or lease_owner<>?)`)
    .bind(now, now, OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  const candidate = await db.prepare(`select security_code as securityCode, reasoning_effort as reasoningEffort from research_operating_analysis_jobs
    where prompt_version=? and status='queued' order by created_at asc limit 1`).bind(OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  const code = text(candidate?.securityCode);
  if (!code) return null;
  const claim = await db.prepare(`update research_operating_analysis_jobs set status='running', attempt_count=attempt_count+1,
    started_at=?, updated_at=?, lease_owner=? where security_code=? and prompt_version=?
    and status='queued' and exists (
      select 1 from research_operating_analysis_runner_leases where lease_name=? and owner_id=? and heartbeat_at>=?
    )`)
    .bind(now, now, runnerInstanceId.trim(), code, OPERATING_ANALYSIS_PROMPT_VERSION,
      RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME, runnerInstanceId.trim(), now - RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS).run();
  return claim.meta.changes ? {
    securityCode: code,
    promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION,
    reasoningEffort: reasoningEffort(candidate?.reasoningEffort),
  } : null;
}

export async function checkpointResearchOperatingAnalysisStream(
  db: D1Database,
  securityCode: string,
  partialReportMarkdown: string,
  partialReasoningMarkdown: string,
  runnerInstanceId: string,
  streamStats?: unknown,
) {
  const partial = partialReportMarkdown.trim();
  const reasoning = partialReasoningMarkdown.trim();
  const stats = normalizeStreamStats(streamStats);
  if (!partial && !reasoning && !stats) return await loadResearchOperatingAnalysis(db, securityCode);
  const now = Date.now();
  const updated = await db.prepare(`update research_operating_analysis_jobs set partial_report_markdown=?, partial_reasoning_markdown=?, partial_stream_stats_json=?, partial_updated_at=?, updated_at=?
    where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(partial, reasoning, stats ? JSON.stringify(stats) : null, now, now, securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  if (!updated.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  return await loadResearchOperatingAnalysis(db, securityCode);
}

export async function saveResearchOperatingAnalysisPrompt(db: D1Database, securityCode: string, prompt: unknown, runnerInstanceId: string) {
  const modelPrompt = normalizeModelPrompt(prompt);
  if (!modelPrompt) throw new Error("operating analysis model prompt is required");
  const now = Date.now();
  const updated = await db.prepare(`update research_operating_analysis_jobs set prompt_json=?, updated_at=?
    where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(JSON.stringify(modelPrompt), now, securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  if (!updated.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  return await loadResearchOperatingAnalysis(db, securityCode);
}

export async function completeResearchOperatingAnalysisJob(db: D1Database, securityCode: string, input: unknown, prompt: unknown, reportMarkdown: string, reasoningMarkdown: string, inputFingerprint: string, runnerInstanceId: string, streamStats?: unknown) {
  const code = securityCode.trim().toUpperCase();
  const report = reportMarkdown.trim();
  const reasoning = reasoningMarkdown.trim();
  const modelPrompt = normalizeModelPrompt(prompt);
  if (!report) throw new Error("operating analysis report is empty");
  const missingHeadings = OPERATING_ANALYSIS_REQUIRED_HEADINGS.filter((heading) => !report.includes(heading));
  if (missingHeadings.length) throw new Error(`operating analysis report is incomplete; missing sections: ${missingHeadings.join(", ")}`);
  if (!modelPrompt) throw new Error("operating analysis model prompt is required");
  if (!inputFingerprint.trim()) throw new Error("operating analysis input fingerprint is required");
  const now = Date.now();
  const job = await db.prepare(`select started_at as startedAt from research_operating_analysis_jobs
      where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
      .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).first<Row>();
  // A user-requested regeneration is a distinct model output even when its
  // source snapshot is unchanged, so it must remain independently reviewable.
  const runId = `operating-analysis:${crypto.randomUUID()}`;
  const startedAt = Number(job?.startedAt);
  const totalDurationMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null;
  const stats = normalizeStreamStats(streamStats);
  await db.prepare(`insert into research_operating_analysis_runs (
      run_id, security_code, prompt_version, input_fingerprint, input_as_of, input_json, report_markdown, reasoning_markdown,
      total_duration_ms, stream_stats_json, prompt_json, provider, generated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm-client.responses', ?)`)
    .bind(runId, code, OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint, now, JSON.stringify(input), report, reasoning, totalDurationMs, stats ? JSON.stringify(stats) : null, JSON.stringify(modelPrompt), now).run();
  const claimed = await db.prepare(`update research_operating_analysis_jobs set status='completed', run_id=?, last_error=null,
    partial_report_markdown=null, partial_reasoning_markdown=null, partial_stream_stats_json=null, prompt_json=?, partial_updated_at=null, completed_at=?, updated_at=? where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(runId, JSON.stringify(modelPrompt), now, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  if (!claimed.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  return await loadResearchOperatingAnalysis(db, code);
}

export async function failResearchOperatingAnalysisJob(db: D1Database, securityCode: string, error: unknown, runnerInstanceId: string) {
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(`update research_operating_analysis_jobs set status='failed', last_error=?, completed_at=?, updated_at=?
    where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(message.slice(0, 1600), now, now, securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  return await loadResearchOperatingAnalysis(db, securityCode);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeModelPrompt(value: unknown): ModelPrompt | null {
  const source = row(value);
  const model = typeof source.model === "string" ? source.model : "";
  const instructions = typeof source.instructions === "string" ? source.instructions : "";
  const userPrompt = typeof source.userPrompt === "string" ? source.userPrompt : "";
  return instructions.trim() && userPrompt.trim() ? { ...(model.trim() ? { model } : {}), instructions, userPrompt } : null;
}

function normalizeStreamStats(value: unknown): StreamStats | null {
  const source = row(value);
  const webSearchSource = row(source.webSearch);
  const usageSource = row(source.usage);
  const integer = (candidate: unknown) => Number.isSafeInteger(candidate) && Number(candidate) >= 0 ? Number(candidate) : undefined;
  const queryCount = integer(webSearchSource.queryCount);
  const citedPageCount = integer(webSearchSource.citedPageCount);
  const usage = Object.fromEntries([
    ["inputTokens", integer(usageSource.inputTokens)], ["outputTokens", integer(usageSource.outputTokens)],
    ["totalTokens", integer(usageSource.totalTokens)], ["reasoningTokens", integer(usageSource.reasoningTokens)],
  ].filter(([, item]) => item !== undefined)) as StreamStats["usage"];
  const webSearch = queryCount !== undefined || citedPageCount !== undefined || typeof webSearchSource.searched === "boolean"
    ? { searched: webSearchSource.searched === true, queryCount: queryCount ?? 0, citedPageCount: citedPageCount ?? 0 } : undefined;
  return webSearch || Object.keys(usage || {}).length ? { ...(webSearch ? { webSearch } : {}), ...(Object.keys(usage || {}).length ? { usage } : {}) } : null;
}
