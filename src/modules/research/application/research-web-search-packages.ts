import packageConfig from "../../../../config/research-web-search-packages.json";
import {
  claimGenericLlmTaskRun,
  completeGenericLlmRun,
  createGenericLlmTask,
  failGenericLlmRun,
  heartbeatGenericLlmRun,
  loadGenericLlmRun,
  loadGenericLlmRunArtifacts,
  loadGenericLlmTask,
  LOCAL_JOB_PROVIDER_ID,
  requeueGenericLlmTask,
  writeGenericLlmRunArtifact,
  type GenericLlmRun,
  type GenericLlmTask,
} from "../../../shared/local-job-protocol";
import {
  RESEARCH_WEB_SEARCH_EVENT_RISK_PROMPT,
  RESEARCH_WEB_SEARCH_FORECAST_CONSENSUS_PROMPT,
  RESEARCH_WEB_SEARCH_INDUSTRY_MARKET_PROMPT,
  RESEARCH_WEB_SEARCH_LATEST_ANNUAL_REPORT_PROMPT,
  RESEARCH_WEB_SEARCH_PEER_SET_PROMPT,
  RESEARCH_WEB_SEARCH_RECENT_FILINGS_PROMPT,
  RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT,
} from "../../../generated/prompt-text";

type Row = Record<string, unknown>;
type StoredPackage = Row & { packageId: string };
type PackageKind = "latest_annual_report" | "recent_filings" | "industry_market" | "peer_set" | "forecast_consensus" | "event_risk";
type TabId = "business" | "market" | "financial" | "industry" | "forecast" | "risk";
type Citation = { title: string; url: string; start?: number; end?: number };
type EvidenceStatus = "verified" | "unavailable" | "uncited" | "citation_unquoted" | "format_incomplete";
type Evidence = { tabId: TabId; fieldKey: string; subject: string; statement: string; numericValue: number | null; unit: string | null; currency: string | null; period: string | null; productScope: string | null; regionScope: string | null; sourceTitle: string | null; sourceUrl: string | null; sourcePublishedAt: string | null; quote: string | null; locator: string | null; status: EvidenceStatus };
type FinancialDisclosureBoundary = { reportPeriod: string; publishedAt: string; title: string; url: string; source: "statutory_verification" | "auto_filing_version" | "statutory_index" };
type ResearchWebSearchTaskMetadata = { securityCode: string; packageKind: PackageKind; label: string; tabs: TabId[] };
export type ResearchWebSearchPackageExecutionRequest = { taskId: string; runId: string; attempt: number; runnerInstanceId: string; securityCode: string; packageKind: PackageKind; promptVersion: string; model: "gpt-5.6-luna"; reasoningEffort: "high"; maxOutputTokens: number; jobTimeoutMs: number; instructions: string; input: string };
type PreparedResearchWebSearchPackageExecution = Omit<ResearchWebSearchPackageExecutionRequest, "taskId" | "runId" | "attempt" | "runnerInstanceId">;
export type ResearchWebSearchPackageExecutionResult = { model: string; text: string; webSearch?: { searched?: boolean; queries?: Array<string>; citations?: Citation[] } };
type ResearchWebSearchPackageRunInput = { taskId: string; runId: string; attempt: number; runnerInstanceId: string; response: ResearchWebSearchPackageExecutionResult };
type ResearchWebSearchPackageRunFailureInput = { taskId: string; runId: string; attempt: number; runnerInstanceId: string; error: unknown };
type ResearchWebSearchPackageRunLeaseInput = { taskId: string; runId: string; attempt: number; runnerInstanceId: string };

const config = packageConfig as {
  version: string; model: "gpt-5.6-luna"; reasoningEffort: "high"; maxOutputTokens: number; jobTimeoutMs: number;
  packages: Record<PackageKind, { promptVersion: string; label: string; tabs: TabId[]; objective: string }>;
};
const kinds = new Set<PackageKind>(Object.keys(config.packages) as PackageKind[]);
const tabs = new Set<TabId>(["business", "market", "financial", "industry", "forecast", "risk"]);
const jobTimeoutMs = Number.isSafeInteger(config.jobTimeoutMs) && config.jobTimeoutMs >= 60_000 ? config.jobTimeoutMs : 10 * 60_000;
const packagePrompts: Record<PackageKind, string> = {
  latest_annual_report: RESEARCH_WEB_SEARCH_LATEST_ANNUAL_REPORT_PROMPT,
  recent_filings: RESEARCH_WEB_SEARCH_RECENT_FILINGS_PROMPT,
  industry_market: RESEARCH_WEB_SEARCH_INDUSTRY_MARKET_PROMPT,
  peer_set: RESEARCH_WEB_SEARCH_PEER_SET_PROMPT,
  forecast_consensus: RESEARCH_WEB_SEARCH_FORECAST_CONSENSUS_PROMPT,
  event_risk: RESEARCH_WEB_SEARCH_EVENT_RISK_PROMPT,
};
function promptVersion(kind: PackageKind) { return config.packages[kind].promptVersion; }

export async function enqueueResearchWebSearchPackage(db: D1Database, securityCode: string, packageKind: string, now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  if (!kinds.has(packageKind as PackageKind)) throw new Error("unsupported web search package");
  const kind = packageKind as PackageKind;
  const result = await createGenericLlmTask(db, {
    taskType: "research_web_search", targetType: "security", targetId: code,
    idempotencyKey: `web-search-package:${kind}`, promptVersion: promptVersion(kind), model: config.model,
    reasoningEffort: config.reasoningEffort,
    metadata: { securityCode: code, packageKind: kind, label: config.packages[kind].label, tabs: config.packages[kind].tabs } satisfies ResearchWebSearchTaskMetadata,
    now,
  });
  if (result.task.status === "failed") {
    const reset = await requeueGenericLlmTask(db, result.task.taskId, now);
    const task = await loadGenericLlmTask(db, result.task.taskId);
    if (!task) throw new Error("generic Web Search task disappeared while retrying");
    return { task, shouldStart: reset, deduplicated: !reset };
  }
  return { task: result.task, shouldStart: result.created, deduplicated: result.deduplicated };
}

/** The local Node runner claims a generic task run before opening a long-lived model stream. */
export async function claimNextResearchWebSearchPackageTaskRun(db: D1Database, runnerInstanceId: string) {
  const claimed = await claimGenericLlmTaskRun(db, runnerInstanceId, { taskType: "research_web_search", provider: LOCAL_JOB_PROVIDER_ID, model: config.model, reasoningEffort: config.reasoningEffort });
  if (!claimed) return null;
  try {
    const identity = packageIdentity(claimed.task);
    const prepared = await prepareResearchWebSearchPackageExecution(db, identity.securityCode, identity.packageKind);
    return { task: claimed.task, run: claimed.run, request: { ...prepared, taskId: claimed.task.taskId, runId: claimed.run.runId, attempt: claimed.run.attempt, runnerInstanceId: required(runnerInstanceId, "runnerInstanceId") } };
  } catch (error) {
    await writeWebSearchFailureArtifact(db, claimed.task, claimed.run, required(runnerInstanceId, "runnerInstanceId"), error, "prepare_failed").catch(() => {});
    await failGenericLlmRun(db, { taskId: claimed.task.taskId, runId: claimed.run.runId, attempt: claimed.run.attempt, leaseOwner: required(runnerInstanceId, "runnerInstanceId"), errorCode: "prepare_failed", errorMessage: error instanceof Error ? error.message : String(error) }).catch(() => {});
    throw error;
  }
}

export async function completeResearchWebSearchPackageRun(db: D1Database, input: ResearchWebSearchPackageRunInput) {
  const runner = required(input.runnerInstanceId, "runnerInstanceId");
  const taskId = required(input.taskId, "taskId");
  const runId = required(input.runId, "runId");
  const task = await loadGenericLlmTask(db, taskId);
  if (!task) throw new Error("generic Web Search task was not found");
  const identity = packageIdentity(task);
  const run = await activeGenericRun(db, task, runId, input.attempt, runner);
  if (input.response.model !== config.model) throw new Error("web search package response model mismatch");
  try {
    const completedAt = Date.now();
    const result = await persistResearchWebSearchPackageResult(db, identity.securityCode, identity.packageKind, input.response, completedAt, `web-search-package:${runId}`);
    const artifacts = await loadGenericLlmRunArtifacts(db, runId);
    if (!artifacts.some((artifact) => artifact.stepKey === "web_search_package")) {
      await writeGenericLlmRunArtifact(db, { runId, taskId, attempt: input.attempt, leaseOwner: runner, stepKey: "web_search_package", outputType: "json", status: "complete", structureValid: true, output: { packageId: result.packageId, securityCode: identity.securityCode, packageKind: identity.packageKind, response: input.response, projection: result }, terminalMetadata: { projection: "research_web_search_source_packages", packageId: result.packageId }, completedAt });
    }
    const terminal = await completeGenericLlmRun(db, { runId, taskId, attempt: input.attempt, leaseOwner: runner, status: "completed", terminalMetadata: { packageId: result.packageId, packageKind: identity.packageKind }, completedAt });
    return { ...terminal, package: result };
  } catch (error) {
    await writeWebSearchFailureArtifact(db, task, run, runner, error, "projection_failed").catch(() => {});
    await failGenericLlmRun(db, { runId, taskId, attempt: input.attempt, leaseOwner: runner, errorCode: "projection_failed", errorMessage: error instanceof Error ? error.message : String(error) }).catch(() => {});
    throw error;
  }
}

export async function failResearchWebSearchPackageRun(db: D1Database, input: ResearchWebSearchPackageRunFailureInput) {
  const runner = required(input.runnerInstanceId, "runnerInstanceId");
  const taskId = required(input.taskId, "taskId");
  const runId = required(input.runId, "runId");
  const task = await loadGenericLlmTask(db, taskId);
  if (!task) throw new Error("generic Web Search task was not found");
  packageIdentity(task);
  await activeGenericRun(db, task, runId, input.attempt, runner);
  const run = await loadGenericLlmRun(db, runId);
  if (!run) throw new Error("generic Web Search run was not found");
  await writeWebSearchFailureArtifact(db, task, run, runner, input.error).catch(() => {});
  return await failGenericLlmRun(db, { runId, taskId, attempt: input.attempt, leaseOwner: runner, errorCode: "provider_failed", errorMessage: String(input.error).slice(0, 1600), terminalMetadata: { package: "research_web_search" } });
}

export async function heartbeatResearchWebSearchPackageRun(db: D1Database, input: ResearchWebSearchPackageRunLeaseInput) {
  const task = await loadGenericLlmTask(db, required(input.taskId, "taskId"));
  if (!task) throw new Error("generic Web Search task was not found");
  packageIdentity(task);
  return { active: await heartbeatGenericLlmRun(db, required(input.runId, "runId"), task.taskId, input.attempt, required(input.runnerInstanceId, "runnerInstanceId")) };
}

export async function prepareResearchWebSearchPackageExecution(db: D1Database, securityCode: string, packageKind: string): Promise<PreparedResearchWebSearchPackageExecution> {
  const code = required(securityCode, "securityCode").toUpperCase();
  if (!kinds.has(packageKind as PackageKind)) throw new Error("unsupported web search package");
  const kind = packageKind as PackageKind;
  const [security, financialDisclosureBoundary, internalForecastCoverage] = await Promise.all([
    db.prepare("select name, market, currency from securities where code=?").bind(code).first<Row>(),
    loadLatestFinancialDisclosureBoundary(db, code),
    loadInternalForecastCoverage(db, code),
  ]);
  const definition = config.packages[kind];
  return {
    securityCode: code, packageKind: kind, promptVersion: promptVersion(kind), model: config.model,
    reasoningEffort: config.reasoningEffort, maxOutputTokens: config.maxOutputTokens, jobTimeoutMs,
    instructions: RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT,
    input: render(packagePrompts[kind], {
        SECURITY_CODE: code, SECURITY_NAME: text(security?.name) || "名称未返回", MARKET: text(security?.market) || "市场未返回",
        CURRENCY: text(security?.currency) || "币种未返回", PACKAGE_LABEL: definition.label,
        TAB_IDS: definition.tabs.join(", "),
        LATEST_FINANCIAL_REPORT_PERIOD: financialDisclosureBoundary?.reportPeriod || "未知",
        LATEST_FINANCIAL_REPORT_PUBLISHED_AT: financialDisclosureBoundary?.publishedAt || "未知",
        LATEST_FINANCIAL_REPORT_TITLE: financialDisclosureBoundary?.title || "未知",
        LATEST_FINANCIAL_REPORT_URL: financialDisclosureBoundary?.url || "未知",
        INTERNAL_FORECAST_COVERAGE: internalForecastCoverage,
        FINANCIAL_DISCLOSURE_BOUNDARY: financialDisclosureBoundary
          ? `已确认：最新可用法定财报截至 ${financialDisclosureBoundary.reportPeriod}；于 ${financialDisclosureBoundary.publishedAt} 发布；标题《${financialDisclosureBoundary.title}》；原文 ${financialDisclosureBoundary.url}。该边界来自本地 ${financialDisclosureBoundary.source} 读模型。`
          : "边界未知：本地尚无可确认的法定财报期间。不得猜测最新财报期间；仅可在原文明确时记录。",
      }),
  };
}

async function persistResearchWebSearchPackageResult(db: D1Database, securityCode: string, packageKind: PackageKind, response: ResearchWebSearchPackageExecutionResult, now: number, requestedPackageId?: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  const kind = packageKind;
  const cached = await loadPackage(db, code, kind);
  if (cached) return { ...cached, cached: true };
  const webSearch = response.webSearch;
  const citations = compactSourceCitations(webSearch?.citations || []);
  if (!webSearch?.searched || !citations.length) throw new Error("web search did not return source citations; no package was persisted");
  const parsed = parseResearchWebSearchPackage(response.text, config.packages[kind].tabs, citations);
  const packageId = requestedPackageId || `web-search-package:${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_web_search_source_packages (
    package_id, security_code, package_kind, prompt_version, model, reasoning_effort, status, search_queries_json,
    source_citations_json, summary, missing_fields_json, conflicts_json, refresh_triggers_json, requested_at, completed_at
  ) values (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(packageId, code, kind, promptVersion(kind), response.model, config.reasoningEffort, JSON.stringify(webSearch.queries || []), JSON.stringify(citations), parsed.summary,
      JSON.stringify(parsed.missingFields), JSON.stringify(parsed.conflicts), JSON.stringify(parsed.refreshTriggers), now, now)];
  for (const item of parsed.items) {
    statements.push(db.prepare(`insert into research_web_search_evidence_records (
      evidence_id, package_id, security_code, tab_id, field_key, subject, statement, numeric_value, unit, currency, period,
      product_scope, region_scope, source_title, source_url, source_published_at, evidence_quote, evidence_locator, status, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`web-search-evidence:${crypto.randomUUID()}`, packageId, code, item.tabId, item.fieldKey, item.subject, item.statement, item.numericValue,
        item.unit, item.currency, item.period, item.productScope, item.regionScope, item.sourceTitle, item.sourceUrl, item.sourcePublishedAt,
        item.quote, item.locator, item.status, now));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    // A late fenced attempt can race the winning projection insert. The
    // natural package key is the business deduplication boundary; reuse the
    // winner rather than turning an otherwise completed task into a failure.
    if (/unique constraint|constraint failed/i.test(String(error))) {
      const winner = await loadPackage(db, code, kind);
      if (winner) return { ...winner, cached: true };
    }
    throw error;
  }
  const completed = await loadPackage(db, code, kind);
  if (!completed) throw new Error("web search package was persisted but cannot be reloaded");
  return { ...completed, cached: false };
}

export async function loadResearchWebSearchPackages(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const packages = await db.prepare(`select package_id as packageId, package_kind as packageKind, prompt_version as promptVersion, model,
      reasoning_effort as reasoningEffort, search_queries_json as searchQueriesJson, source_citations_json as sourceCitationsJson, summary,
      missing_fields_json as missingFieldsJson, conflicts_json as conflictsJson, refresh_triggers_json as refreshTriggersJson,
      requested_at as requestedAt, completed_at as completedAt from research_web_search_source_packages
      where security_code=? and status='completed' order by completed_at desc`).bind(code).all<Row>();
    const evidence = await db.prepare(`select evidence_id as evidenceId, package_id as packageId, tab_id as tabId, field_key as fieldKey,
      subject, statement, numeric_value as numericValue, unit, currency, period, product_scope as productScope, region_scope as regionScope,
      source_title as sourceTitle, source_url as sourceUrl, source_published_at as sourcePublishedAt, evidence_quote as quote,
      evidence_locator as locator, status, created_at as createdAt from research_web_search_evidence_records where security_code=?
      order by created_at desc`).bind(code).all<Row>();
    const byPackage = new Map<string, Row[]>();
    for (const item of evidence.results) { const id = text(item.packageId); byPackage.set(id, [...(byPackage.get(id) || []), item]); }
    const taskRows = await db.prepare(`select task_id as taskId from llm_tasks
      where task_type='research_web_search' and target_type='security' and target_id=? order by updated_at desc`).bind(code).all<Row>();
    const tasks = (await Promise.all(taskRows.results.map(async (row) => {
      const taskId = text(row.taskId); if (!taskId) return null;
      const task = await loadGenericLlmTask(db, taskId); if (!task) return null;
      const run = task.lastRunId ? await loadGenericLlmRun(db, task.lastRunId) : null;
      const artifacts = run ? await loadGenericLlmRunArtifacts(db, run.runId) : [];
      return { task, run, artifacts };
    }))).filter((item): item is { task: GenericLlmTask; run: GenericLlmRun | null; artifacts: Awaited<ReturnType<typeof loadGenericLlmRunArtifacts>> } => Boolean(item));
    return { availability: packages.results.length || tasks.length ? "available" as const : "empty" as const, packages: packages.results.map((item) => ({ ...item,
      searchQueries: jsonArray(item.searchQueriesJson), sourceCitations: jsonArray(item.sourceCitationsJson), missingFields: jsonArray(item.missingFieldsJson),
      conflicts: jsonArray(item.conflictsJson), refreshTriggers: jsonArray(item.refreshTriggersJson), evidence: byPackage.get(text(item.packageId)) || [],
    })), tasks };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable" as const, packages: [] as Row[], tasks: [] as Array<{ task: GenericLlmTask; run: GenericLlmRun | null; artifacts: Awaited<ReturnType<typeof loadGenericLlmRunArtifacts>> }> };
    throw error;
  }
}

async function loadPackage(db: D1Database, code: string, kind: PackageKind): Promise<StoredPackage | null> {
  const all = await loadResearchWebSearchPackages(db, code);
  const found = all.packages.find((item) => text(item.packageKind) === kind && text(item.promptVersion) === promptVersion(kind)) as Row | undefined;
  const packageId = text(found?.packageId);
  return found && packageId ? { ...found, packageId } : null;
}

/**
 * Returns an already-indexed financial-report boundary for prompt grounding.
 * This never discovers data remotely: it only chooses a source-bound local
 * record, and deliberately excludes ordinary announcements from the fallback.
 */
export async function loadLatestFinancialDisclosureBoundary(db: D1Database, securityCode: string): Promise<FinancialDisclosureBoundary | null> {
  const code = required(securityCode, "securityCode").toUpperCase();
  const queries: Array<Promise<Row | null>> = [
    db.prepare(`select v.statutory_report_date as reportPeriod, v.statutory_published_at as publishedAt,
        coalesce(d.title, '截至 ' || v.statutory_report_date || ' 的法定财报') as title, v.statutory_disclosure_url as url
      from research_financial_statutory_verifications v
      left join research_statutory_disclosure_documents d on d.security_code=v.security_code
        and (d.document_id=v.statutory_document_id or d.document_url=v.statutory_disclosure_url)
      where v.security_code=? and v.statutory_report_date is not null and v.statutory_published_at is not null
        and v.statutory_disclosure_url is not null
      order by v.statutory_report_date desc, v.statutory_published_at desc, v.observed_at desc limit 1`).bind(code).first<Row>(),
    db.prepare(`select report_period as reportPeriod, published_at as publishedAt, title, document_url as url
      from research_auto_filing_document_versions
      where security_code=? and is_current=1 and report_period is not null and document_kind in ('annual', 'interim')
      order by report_period desc, published_at desc, updated_at desc limit 1`).bind(code).first<Row>(),
    db.prepare(`select title, published_at as publishedAt, document_url as url
      from research_statutory_disclosure_documents
      where security_code=? order by published_at desc, indexed_at desc limit 200`).bind(code).all<Row>()
      .then((result) => (result.results.find((item) => isFinancialReportTitle(text(item.title))) || null)),
  ];
  const [verified, version, indexed] = await Promise.all(queries);
  const candidates: Array<{ row: Row | null; source: FinancialDisclosureBoundary["source"] }> = [
    { row: verified, source: "statutory_verification" },
    { row: version, source: "auto_filing_version" },
    { row: indexed, source: "statutory_index" },
  ];
  for (const candidate of candidates) {
    const reportPeriod = text(candidate.row?.reportPeriod) || reportPeriodFromTitle(text(candidate.row?.title));
    const publishedAt = text(candidate.row?.publishedAt); const title = text(candidate.row?.title); const url = text(candidate.row?.url);
    if (reportPeriod && publishedAt && title && validHttpUrl(url)) return { reportPeriod, publishedAt, title, url, source: candidate.source };
  }
  return null;
}

/** Web Search must not duplicate the project forecast ledger. This compact,
 * deterministic coverage summary is prompt context only; it does not create
 * or revise any forecast record. */
async function loadInternalForecastCoverage(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const result = await db.prepare(`select metric, fiscal_period as fiscalPeriod, count(*) as count, max(forecast_date) as latestForecastDate
      from research_source_forecasts where security_code=?
      group by metric, fiscal_period order by latestForecastDate desc, metric, fiscalPeriod limit 24`).bind(code).all<Row>();
    if (!result.results.length) return "内部来源绑定研报预测账本当前没有该证券的已入账预测；如用户明确需要外部前瞻材料，可检索但不得称为一致预期。";
    const coverage = result.results.map((item) => `${text(item.metric)} ${text(item.fiscalPeriod)}（${Number(item.count)} 条，最新 ${text(item.latestForecastDate) || "日期未记录"}）`).join("；");
    return `内部来源绑定研报预测账本已覆盖：${coverage}。这些指标/期间不得通过本包重复搜索。`;
  } catch (error) {
    if (/no such table/i.test(String(error))) return "内部预测账本在当前数据库不可用；仅在用户明确需要外部前瞻材料时才可检索，且不得称为一致预期。";
    throw error;
  }
}

export function parseResearchWebSearchPackage(raw: string, allowedTabs: TabId[], citations: Citation[]) {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")); } catch { throw new Error("web search source package response was not JSON"); }
  if (!value || typeof value !== "object") throw new Error("web search source package response was not an object");
  const data = value as Row;
  const summary = text(data.summary);
  const readableLists = [data.missing_fields, data.conflicts, data.refresh_triggers]
    .flatMap((value) => stringArray(value));
  if (!containsChinese(summary) || readableLists.some((item) => !containsChinese(item))) {
    throw new Error("web search source package user-facing text was not Chinese");
  }
  const cited = new Map(citations.map((item) => [canonicalUrl(item.url), item]));
  const rejected = new Map<string, number>();
  const reject = (reason: string) => rejected.set(reason, (rejected.get(reason) || 0) + 1);
  const items = (Array.isArray(data.evidence_records) ? data.evidence_records : []).flatMap((candidate): Evidence[] => {
    if (!candidate || typeof candidate !== "object") { reject("invalid_record"); return []; }
    const item = candidate as Row; const requestedStatus = text(item.status) as EvidenceStatus; const tabId = text(item.tab_id) as TabId;
    const fieldKey = key(item.field_key); const subject = text(item.subject); const statement = text(item.statement);
    if (!allowedTabs.includes(tabId) || !tabs.has(tabId)) { reject("unsupported_tab"); return []; }
    if (!fieldKey || !subject || !statement) { reject("missing_required_fields"); return []; }
    if (!containsChinese(statement)) throw new Error("web search source package statement was not Chinese");
    const citedSourceUrl = citedUrl(item.source_url, cited); const citation = citedSourceUrl ? cited.get(canonicalUrl(citedSourceUrl)) : undefined;
    const sourceUrl = citedSourceUrl || storageUrl(item.source_url);
    const status: EvidenceStatus = requestedStatus === "unavailable"
      ? "unavailable"
      : citation
        ? "verified"
        : requestedStatus === "format_incomplete"
          ? "format_incomplete"
          : "uncited";
    return [{ tabId, fieldKey, subject, statement, numericValue: finite(item.numeric_value), unit: nullable(item.unit), currency: nullable(item.currency), period: nullable(item.period), productScope: nullable(item.product_scope), regionScope: nullable(item.region_scope), sourceTitle: nullable(item.source_title) || citation?.title || null, sourceUrl, sourcePublishedAt: nullable(item.source_published_at), quote: null, locator: null, status }];
  });
  if (!items.length) {
    const details = [...rejected.entries()].map(([reason, count]) => `${reason}=${count}`).join(", ") || "no_evidence_records";
    throw new Error(`web search returned no source-bound evidence records (${details})`);
  }
  return { summary, items, missingFields: stringArray(data.missing_fields), conflicts: stringArray(data.conflicts), refreshTriggers: stringArray(data.refresh_triggers) };
}

function packageIdentity(task: GenericLlmTask): { securityCode: string; packageKind: PackageKind } {
  if (task.taskType !== "research_web_search" || task.targetType !== "security") throw new Error("generic task is not a Web Search package task");
  const metadata = task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata) ? task.metadata as Record<string, unknown> : {};
  const code = required(task.targetId || metadata.securityCode, "securityCode").toUpperCase();
  const kind = text(metadata.packageKind) as PackageKind;
  if (!kinds.has(kind) || task.promptVersion !== promptVersion(kind)) throw new Error("generic task has an unsupported Web Search package identity");
  return { securityCode: code, packageKind: kind };
}

async function activeGenericRun(db: D1Database, task: GenericLlmTask, runId: string, attempt: number, runner: string): Promise<GenericLlmRun> {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Web Search package run attempt is required");
  const run = await loadGenericLlmRun(db, runId);
  if (!run || run.taskId !== task.taskId || run.status !== "running" || run.attempt !== attempt || run.leaseOwner !== runner || !run.leaseUntil || run.leaseUntil < Date.now()) {
    throw new Error("generic Web Search run lease is no longer owned by this runner");
  }
  return run;
}

async function writeWebSearchFailureArtifact(db: D1Database, task: GenericLlmTask, run: GenericLlmRun, runner: string, error: unknown, errorCode = "provider_failed") {
  const existing = await loadGenericLlmRunArtifacts(db, run.runId);
  if (existing.some((artifact) => artifact.stepKey === "web_search_package")) return existing[0];
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
  return writeGenericLlmRunArtifact(db, {
    runId: run.runId, taskId: task.taskId, attempt: run.attempt, leaseOwner: runner,
    stepKey: "web_search_package", outputType: "json", status: "failed", output: null,
    structureValid: null, errorCode, errorMessage: message,
    terminalMetadata: { consumer: "research_web_search", packageKind: packageIdentity(task).packageKind }, completedAt: Date.now(),
  });
}

function canonicalUrl(value: string) { try { const url = new URL(value); url.hash = ""; url.searchParams.sort(); return url.toString().replace(/\/$/, ""); } catch { return ""; } }
export function compactSourceCitations(citations: Citation[]): Citation[] {
  const unique = new Map<string, Citation>();
  for (const item of citations) {
    const url = canonicalUrl(item.url);
    if (url && !unique.has(url)) unique.set(url, { title: item.title, url });
  }
  return [...unique.values()];
}
function validHttpUrl(value: string) { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
function isFinancialReportTitle(title: string) {
  if (!title || /(?:摘要|summary|提示性公告|预约披露|披露的提示|业绩预告|快报|业绩说明会)/i.test(title)) return false;
  return /(?:年度报告|年报|半年度报告|中期报告|季度报告|一季度报告|二季度报告|三季度报告|annual report|interim report|quarterly report|\b10-k\b|\b10-q\b|\b20-f\b)/i.test(title);
}
function reportPeriodFromTitle(title: string) {
  const year = /(20\d{2})/.exec(title)?.[1];
  if (!year) return "";
  if (/(?:年度报告|年报|annual report|\b10-k\b|\b20-f\b)/i.test(title)) return `${year}-12-31`;
  if (/(?:半年度报告|中期报告|half.?year|interim report)/i.test(title)) return `${year}-06-30`;
  if (/(?:三季度报告|third quarter|\bq3\b)/i.test(title)) return `${year}-09-30`;
  if (/(?:二季度报告|second quarter|\bq2\b)/i.test(title)) return `${year}-06-30`;
  if (/(?:一季度报告|季度报告|quarterly report|\b10-q\b|\bq1\b)/i.test(title)) return `${year}-03-31`;
  return "";
}
/** Native Responses citations can be rendered inside a JSON string as
 * `https://source.example/path ([source.example](https://source.example/path))`.
 * Persist the cited canonical URL, never the renderer's display suffix. */
function citedUrl(value: unknown, citations: Map<string, Citation>): string | null {
  const raw = nullable(value);
  if (!raw) return null;
  const candidates = raw.match(/https?:\/\/[^\s\]\[()"']+/g) || [];
  for (const candidate of candidates) {
    const normalized = canonicalUrl(candidate);
    if (normalized && citations.has(normalized)) return normalized;
  }
  const normalized = canonicalUrl(raw);
  return normalized && citations.has(normalized) ? normalized : null;
}
/** Preserve a model-provided link for review even when it was not returned as
 * a native Web Search citation. Never store a non-web scheme for the page to
 * render as a link. */
function storageUrl(value: unknown): string | null {
  const raw = nullable(value);
  if (!raw) return null;
  const candidate = (raw.match(/https?:\/\/[^\s\]\[()"']+/g) || []).find(validHttpUrl) || raw;
  return validHttpUrl(candidate) ? candidate : null;
}
function jsonArray(value: unknown) { try { const parsed = JSON.parse(text(value)); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function stringArray(value: unknown) { return (Array.isArray(value) ? value : []).flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []); }
function render(template: string, values: Record<string, string>) { return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template); }
function key(value: unknown) { return text(value).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 100); }
function finite(value: unknown) { if (value === null || value === undefined || value === "") return null; const result = typeof value === "number" ? value : Number(value); return Number.isFinite(result) ? result : null; }
function containsChinese(value: string) { return /[\u3400-\u9fff]/.test(value); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : ""; }
function nullable(value: unknown) { const result = text(value); return result || null; }
function required(value: unknown, label: string) { const result = text(value); if (!result) throw new Error(`${label} is required`); return result; }
