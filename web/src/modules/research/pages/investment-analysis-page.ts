import { createApp, defineComponent, h, onMounted, onUnmounted, ref, type VNodeChild } from "vue";

const DEFAULT_CODE = "300308.SZ";
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_INFO_MOUNTED_EVENT = "stock-info:company-info-mounted";
type Json = Record<string, unknown>;
type StreamStats = { webSearch?: { searched?: boolean; queryCount?: number; citedPageCount?: number }; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number } };
type ModelPrompt = { model?: string; instructions?: string; userPrompt?: string };
type ReportEvidenceItem = { text?: string | null; title?: string | null; url?: string | null };
type ReportEvidence = { schemaVersion?: string | null; transport?: string | null; provider?: string | null; providerUrl?: string | null; providerConversationId?: string | null; gatewayTaskId?: string | null; rawTaskId?: string | null; rawRunId?: string | null; rawArtifactId?: string | null; citationCount?: number | null; sourceCount?: number | null; structuredAnswerAvailable?: boolean | null; citations?: ReportEvidenceItem[] | null; sources?: ReportEvidenceItem[] | null };
type ReportRun = { runId?: string; promptVersion?: string; reportMarkdown?: string; reasoningMarkdown?: string; totalDurationMs?: number | null; provider?: string; generatedAt?: number; input?: Json | null; prompt?: ModelPrompt | null; streamStats?: StreamStats | null; status?: LowDependencyReport["status"]; evidence?: ReportEvidence | null };
type ReportVersion = Pick<ReportRun, "runId" | "promptVersion" | "provider" | "generatedAt" | "totalDurationMs">;
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type AnalysisStage = { stageKey: string; label?: string; status?: "queued" | "running" | "complete" | "partial" | "blocked" | "not_applicable" | "failed"; attempt?: number; attemptCount?: number; startedAt?: number | null; completedAt?: number | null; updatedAt?: number | null; elapsedMs?: number | null; lastError?: string | null; blocked?: unknown; outputKind?: "json" | "markdown"; reused?: boolean; sourceRunId?: string | null; prompt?: ModelPrompt | null };
type AnalysisWorkPackage = { key: string; label?: string; execution?: "model" | "deterministic"; webSearch?: boolean; finalReport?: boolean; bypassed?: boolean; stageKeys?: string[]; status?: "queued" | "running" | "complete" | "blocked" | "failed" | "not_applicable"; taskId?: string | null; runId?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null; prompt?: ModelPrompt | null; startedAt?: number | null; completedAt?: number | null; updatedAt?: number | null; elapsedMs?: number | null; lastError?: string | null };
type ReportJob = { taskId?: string | null; runId?: string | null; status?: "queued" | "running" | "completed" | "failed" | "blocked"; reasoningEffort?: ReasoningEffort; lastError?: string | null; createdAt?: number; startedAt?: number; completedAt?: number; updatedAt?: number; attempt?: number; attemptCount?: number; lineageRunId?: string | null; rerunStageKeys?: string[]; prompt?: ModelPrompt | null; streamStats?: StreamStats | null; stages?: AnalysisStage[]; workflowPackages?: AnalysisWorkPackage[] };
type LowDependencyRun = { runId?: string; attempt?: number; lineageRunId?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null; status?: string; startedAt?: number | null; completedAt?: number | null; updatedAt?: number | null; currentStepKey?: string | null };
type LowDependencyReport = { status?: "complete" | "partial" | "blocked" | "not_applicable" | "failed"; artifactId?: string | null; markdown?: string | null; blockers?: unknown[]; projectionFingerprint?: string | null; evidence?: ReportEvidence | null };
type LowDependencyTask = ReportJob & { taskId?: string; jobId?: string; runId?: string | null; protocolVersion?: string; promptVersion?: string; securityCode?: string; currentStepKey?: string | null; errorMessage?: string | null };
type ResumeEligibility = { available?: boolean; reason?: string; runId?: string | null; failedStageKeys?: string[]; reusableStageKeys?: string[]; promptVersion?: string | null; codeVersion?: string | null; currentPromptVersion?: string; currentCodeVersion?: string };
type OperatingAnalysis = { availability?: "available" | "empty" | "unavailable"; protocolVersion?: string; promptVersion?: string; run?: LowDependencyRun | null; task?: LowDependencyTask | null; report?: LowDependencyReport | null; stages?: AnalysisStage[]; workflowPackages?: AnalysisWorkPackage[]; finalArtifactId?: string | null; scopeEnvelopeAvailable?: boolean; resume?: ResumeEligibility | null; resumeAvailable?: boolean };
type RoutingReason = { code?: string; message?: string; fields?: string[] };
type RoutingCandidate = { templateId?: string; industryKey?: string; label?: string; frameworkCategory?: string; presentationCategoryId?: string; presentationCategoryLabel?: string; operatingFeatureLabel?: string; legacyTemplateIds?: string[]; matchedFields?: string[]; score?: number; reason?: string; sourceIds?: string[] };
type RoutingCurrent = { state?: "unconfirmed" | "confirmed"; selectedTemplateId?: string | null; scopeNote?: string | null; companyScope?: Json; candidateTemplates?: RoutingCandidate[]; reasons?: RoutingReason[] };
type RoutingConfirmation = { confirmationId?: string; selectedTemplateId?: string; scopeNote?: string | null; actorKey?: string; createdAt?: number; companyScope?: Json };
type RegisteredTemplate = { templateId?: string; industryKey?: string; label?: string; frameworkCategory?: string; presentationCategoryId?: string; presentationCategoryLabel?: string; operatingFeatureLabel?: string; legacyTemplateIds?: string[] };
type PresentationCategory = { id?: string; label?: string };
type OperatingRouting = { availability?: "available" | "empty" | "unavailable"; presentationCategories?: PresentationCategory[]; templates?: RegisteredTemplate[]; current?: RoutingCurrent; manualConfirmation?: RoutingConfirmation | null; history?: RoutingConfirmation[]; automatic?: Json | null };
type OperatingAnalysisWithRouting = OperatingAnalysis & { routing?: OperatingRouting | null };
type EastmoneyCompanyProfile = { taxonomy?: string; availability?: "available" | "unavailable"; industry?: string | null; industryLevels?: string[]; mainBusiness?: string | null; products?: string[]; sourceUrl?: string | null };
type CompanyOverview = { name?: string; latestPrice?: number | null; pctChange?: number | null; marketCapYi?: number | null; peTtm?: number | null; companyProfile?: EastmoneyCompanyProfile | null };
type KlineBar = { date?: string; close?: number | null };
type IncomeStatement = { parentNetprofit?: number | null };
type ShareChange = { totalShares?: number | null };
const reasoningEffortOptions: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
};

function securityCodeFromUrl(): string {
  const code = new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || DEFAULT_CODE;
  return /^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/.test(code) ? code : DEFAULT_CODE;
}

function asRecord(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function httpsUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}
function finiteNumber(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? number : null; }
function formatMarketNumber(value: unknown): string { const number = finiteNumber(value); return number === null ? "—" : number.toFixed(2); }
function formatPercentage(value: unknown): string { const number = finiteNumber(value); return number === null ? "—" : `${number.toFixed(2)}%`; }
function changeSince(latest: number | null, baseline: number | null): number | null {
  return latest !== null && baseline !== null && baseline !== 0 ? (latest / baseline - 1) * 100 : null;
}
function closingPriceBefore(rows: KlineBar[], date: string): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const close = finiteNumber(row.close);
    if (row.date && row.date <= date && close !== null) return close;
  }
  return null;
}
function legacyInfoBarPe(latestPrice: number | null, incomeRows: IncomeStatement[], shareChanges: ShareChange[]): number | null {
  const totalShares = finiteNumber(shareChanges[0]?.totalShares);
  const trailingProfits = incomeRows.slice(0, 4).map((row) => finiteNumber(row.parentNetprofit)).filter((value): value is number => value !== null);
  const totalNetProfit = trailingProfits.reduce((sum, value) => sum + value, 0);
  return latestPrice !== null && totalShares !== null && totalShares > 0 && trailingProfits.length === 4 && totalNetProfit > 0
    ? latestPrice * totalShares / totalNetProfit
    : null;
}
function setInfoBarValue(id: string, value: string, change: number | null = null): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value;
  element.classList.toggle("text-danger", change !== null && change > 0);
  element.classList.toggle("text-success", change !== null && change < 0);
}
function date(value: unknown): string {
  if (!value) return "—";
  const parsed = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("zh-CN", { hour12: false });
}
function isRunning(job: ReportJob | null | undefined): boolean { return job?.status === "queued" || job?.status === "running"; }
function stageStatusLabel(status: AnalysisStage["status"]): string { return ({ queued: "等待", running: "处理中", complete: "已完成", partial: "部分完成", blocked: "已阻断", not_applicable: "不适用", failed: "失败" } as Record<string, string>)[status || "queued"] || "等待"; }
function lowDependencyTaskStatus(status: unknown): ReportJob["status"] {
  if (status === "queued" || status === "leased") return "queued";
  if (status === "cancel_requested" || status === "running") return "running";
  if (status === "succeeded") return "completed";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "running") return "running";
  return "queued";
}
function projectLowDependencyJob(model: OperatingAnalysis | null): ReportJob | null {
  const task = model?.task;
  if (!task) return null;
  const run = model?.run;
  const activePackage = model?.workflowPackages?.find((item) => item.status === "running");
  const finalReportPackage = model?.workflowPackages?.find((item) => item.finalReport);
  const prompt = activePackage?.prompt || finalReportPackage?.prompt || model?.stages?.find((stage) => stage.status === "running")?.prompt || null;
  return {
    taskId: task.taskId || task.jobId || null, runId: run?.runId || task.runId || null,
    status: lowDependencyTaskStatus(task.status), reasoningEffort: task.reasoningEffort, lastError: task.lastError || task.errorMessage || null,
    createdAt: task.createdAt, startedAt: run?.startedAt ?? task.startedAt, completedAt: run?.completedAt ?? task.completedAt,
    updatedAt: task.updatedAt, attempt: run?.attempt ?? task.attempt, attemptCount: run?.attempt ?? task.attemptCount,
    lineageRunId: run?.lineageRunId ?? task.lineageRunId ?? null, rerunStageKeys: task.rerunStageKeys || [], prompt,
    stages: model.stages || [], workflowPackages: model.workflowPackages || [],
  };
}
function projectLowDependencyReport(model: OperatingAnalysis | null): ReportRun | null {
  const report = model?.report;
  if (!report?.markdown) return null;
  const run = model?.run;
  const finalReportPackage = model?.workflowPackages?.find((item) => item.finalReport);
  return {
    runId: run?.runId, promptVersion: model?.promptVersion, reportMarkdown: report.markdown,
    status: report.status, artifactId: report.artifactId || null, provider: report.evidence?.provider || "local-generic-llm", evidence: report.evidence || null, generatedAt: run?.completedAt || undefined,
    totalDurationMs: run?.startedAt && run?.completedAt ? run.completedAt - run.startedAt : null,
    prompt: finalReportPackage?.prompt || null,
  };
}
function duration(ms: unknown): string {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1_000));
  if (!Number.isFinite(totalSeconds)) return "—";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function runningDuration(job: ReportJob | null | undefined, now: number): string {
  // `createdAt` belongs to the durable job row, which survives a forced
  // regeneration. A new run must start from its own claim time instead.
  const startedAt = Number(job?.startedAt) || Number(job?.updatedAt) || Number(job?.createdAt);
  return duration(Number.isFinite(startedAt) ? now - startedAt : Number.NaN);
}
function completedDuration(report: ReportRun | null | undefined, job: ReportJob | null | undefined): string {
  const persisted = Number(report?.totalDurationMs);
  if (Number.isFinite(persisted)) return duration(persisted);
  const startedAt = Number(job?.startedAt) || Number(job?.createdAt);
  const completedAt = Number(job?.completedAt);
  return duration(Number.isFinite(startedAt) && Number.isFinite(completedAt) ? completedAt - startedAt : Number.NaN);
}
function streamStatsSummary(stats: StreamStats | null | undefined): string[] {
  const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const queryCount = integer(stats?.webSearch?.queryCount);
  const citedPageCount = integer(stats?.webSearch?.citedPageCount);
  const inputTokens = integer(stats?.usage?.inputTokens);
  const outputTokens = integer(stats?.usage?.outputTokens);
  const totalTokens = integer(stats?.usage?.totalTokens);
  const reasoningTokens = integer(stats?.usage?.reasoningTokens);
  return [
    queryCount !== null ? `已检索 ${queryCount} 个关键词` : "",
    citedPageCount !== null ? `已回链 ${citedPageCount} 个来源页面` : "",
    totalTokens !== null ? `模型用量 ${totalTokens.toLocaleString("zh-CN")} tokens` : "",
    inputTokens !== null && totalTokens === null ? `输入 ${inputTokens.toLocaleString("zh-CN")} tokens` : "",
    outputTokens !== null && totalTokens === null ? `输出 ${outputTokens.toLocaleString("zh-CN")} tokens` : "",
    reasoningTokens !== null ? `推理 ${reasoningTokens.toLocaleString("zh-CN")} tokens` : "",
  ].filter(Boolean);
}
function reasoningEffortLabel(value: unknown): string {
  const effort = text(value);
  if (!effort) return "未记录";
  const label = reasoningEffortLabels[effort as ReasoningEffort];
  return label ? `${label}（${effort}）` : effort;
}
function reportQualityIssues(markdown: string): string[] {
  const requiredHeadings = ["研究范围与事实边界", "公司概况与商业模式", "行业与产业链", "公司竞争地位", "增长、驱动与可持续性", "利润质量、现金转换与营运资本", "资本效率、管理层治理与资本配置", "资产负债表与压力测试", "估值与市场隐含经营要求", "核心风险与反面证据", "后续跟踪仪表盘", "最终结论"];
  const issues: string[] = [];
  if (markdown.length < 1_400) issues.push(`正文较短（${markdown.length} 字符）`);
  const missing = requiredHeadings.filter((heading) => !markdown.includes(heading));
  if (missing.length) issues.push(`缺少章节：${missing.join("、")}`);
  if (!/\[[^\]]+\]\(https?:\/\//.test(markdown)) issues.push("未包含可点击来源链接");
  return issues;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => null) as { code?: number; msg?: string; data?: T } | null;
    if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || `请求失败：${response.status}`);
    return payload.data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超过 ${REQUEST_TIMEOUT_MS / 1_000} 秒，已停止等待`);
    throw error;
  } finally { window.clearTimeout(timeout); }
}

function inlineMarkdown(source: string): VNodeChild[] {
  const nodes: VNodeChild[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > offset) nodes.push(source.slice(offset, start));
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) nodes.push(h("strong", token.slice(2, -2)));
    else if (token.startsWith("`")) nodes.push(h("code", token.slice(1, -1)));
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      nodes.push(link ? h("a", { href: link[2], target: "_blank", rel: "noopener noreferrer" }, link[1]) : token);
    }
    offset = start + token.length;
  }
  if (offset < source.length) nodes.push(source.slice(offset));
  return nodes;
}

function isTableLine(line: string): boolean { return /^\|.+\|\s*$/.test(line); }
function isTableSeparator(line: string): boolean { return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line); }
type OutlineItem = { id: string; level: number; text: string };

function documentOutline(markdown: string): OutlineItem[] {
  let index = 0;
  return markdown.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
    if (!heading) return [];
    const item = { id: `ia-heading-${index++}`, level: Math.min(heading[1].length, 4), text: heading[2] };
    return [item];
  });
}

function markdownTable(rows: string[][]): VNodeChild {
  const [header, ...body] = rows;
  return h("div", { class: "ia-table-wrap" }, h("table", { class: "ia-table" }, [
    header ? h("thead", [h("tr", header.map((cell, index) => h("th", { key: index }, inlineMarkdown(cell))))]) : null,
    h("tbody", body.map((row, rowIndex) => h("tr", { key: rowIndex }, row.map((cell, index) => h("td", { key: index }, inlineMarkdown(cell)))))),
  ]));
}

/** Renders persisted model output as VNodes only. Model output is never injected as HTML. */
function renderMarkdown(markdown: string): VNodeChild[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  const blocks: VNodeChild[] = [];
  let headingIndex = 0;
  const startsBlock = (line: string) => !line || /^#{1,6}\s+/.test(line) || /^>\s?/.test(line) || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line) || isTableLine(line);
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(h(`h${Math.min(heading[1].length, 4)}`, { id: `ia-heading-${headingIndex++}`, key: `h-${index}` }, inlineMarkdown(heading[2])));
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(h("blockquote", { key: `q-${index}` }, inlineMarkdown(quote.join(" "))));
      continue;
    }
    if (isTableLine(line)) {
      const rows: string[][] = [];
      while (index < lines.length && isTableLine(lines[index])) {
        if (!isTableSeparator(lines[index])) rows.push(lines[index].replace(/^\||\|\s*$/g, "").split("|").map((cell) => cell.trim()));
        index += 1;
      }
      if (rows.length) blocks.push(markdownTable(rows));
      continue;
    }
    const list = /^([-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      const ordered = /\d+\./.test(list[1]);
      const expression = ordered ? /^\d+\.\s+(.+)$/ : /^[-*+]\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = expression.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(h(ordered ? "ol" : "ul", { key: `l-${index}` }, items.map((item, itemIndex) => h("li", { key: itemIndex }, inlineMarkdown(item)))));
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index])) paragraph.push(lines[index++]);
    blocks.push(h("p", { key: `p-${index}` }, inlineMarkdown(paragraph.join(" "))));
  }
  return blocks;
}

function reportName(run: ReportRun | null | undefined, fallback: string): string {
  const security = asRecord(asRecord(run?.input).security);
  return text(security.name) || fallback;
}

function versionLabel(versions: ReportVersion[], runId: string | null | undefined): string {
  const index = versions.findIndex((item) => item.runId === runId);
  const version = index >= 0 ? text(versions[index].promptVersion) : "";
  const semanticVersion = /(?:^|\.)(v\d+(?:\.\d+)*)$/i.exec(version)?.[1] || version || "未记录版本";
  return `${semanticVersion} · ${date(index >= 0 ? versions[index].generatedAt : undefined)}`;
}

function reportStatusLabel(status: ReportRun["status"], running: boolean): string {
  if (running) return status === "queued" ? "已排队" : "生成中";
  return ({ complete: "已完成", partial: "部分完成", blocked: "已阻断", failed: "失败", not_applicable: "不适用" } as Record<string, string>)[status || ""] || "未生成";
}

function reportStatusClass(status: ReportRun["status"], running: boolean): string {
  if (running) return "running";
  if (status === "complete") return "complete";
  if (status === "failed" || status === "blocked" || status === "partial") return "attention";
  return "unknown";
}

function evidenceCountLabel(value: unknown, label: string): string {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? `${Number(value).toLocaleString("zh-CN")} ${label}` : `${label}未记录`;
}

function normalizedEvidenceItems(value: unknown): Array<{ text: string; title: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const item = asRecord(candidate);
    const url = httpsUrl(item.url);
    if (!url) return null;
    return { text: text(item.text), title: text(item.title), url };
  }).filter((item): item is { text: string; title: string; url: string } => item !== null);
}

function reportEvidenceDetails(label: string, count: unknown, value: unknown): VNodeChild {
  const items = normalizedEvidenceItems(value);
  return h("details", { class: "ia-provenance-evidence" }, [
    h("summary", evidenceCountLabel(count, label)),
    items.length
      ? h("ol", { class: "ia-provenance-evidence-list" }, items.map((item, index) => h("li", { key: `${item.url}-${index}` }, [
        item.title ? h("strong", item.title) : null,
        item.text ? h("span", item.title && item.text !== item.title ? `：${item.text}` : item.text) : null,
        h("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.url),
      ])))
      : h("p", { class: "ia-unavailable" }, "未记录/无结构化来源"),
  ]);
}

function reportProvenanceCard(evidence: ReportEvidence | null | undefined): VNodeChild {
  const provider = text(evidence?.provider) || "提供方未记录";
  const providerUrl = httpsUrl(evidence?.providerUrl);
  const structured = evidence?.structuredAnswerAvailable === true ? "已提供（webqa.answer.v1）" : evidence?.structuredAnswerAvailable === false ? "未提供" : "未记录";
  return h("section", { class: "ia-provenance", "aria-label": "报告来源与证据" }, [
    h("div", { class: "ia-provenance-head" }, [
      h("div", [h("h3", "来源与可审计性"), h("p", provider)]),
      providerUrl ? h("a", { href: providerUrl, target: "_blank", rel: "noopener noreferrer" }, "打开提供方会话") : h("span", { class: "ia-unavailable" }, "提供方会话链接：未记录"),
    ]),
    h("div", { class: "ia-provenance-grid" }, [
      h("div", [h("strong", evidenceCountLabel(evidence?.citationCount, "条引用")), h("span", "模型回答中的 citations")]),
      h("div", [h("strong", evidenceCountLabel(evidence?.sourceCount, "个来源")), h("span", "模型回答中的 sources")]),
      h("div", [h("strong", structured), h("span", "结构化回答")]),
    ]),
    reportEvidenceDetails("模型引用（citations）", evidence?.citationCount, evidence?.citations),
    reportEvidenceDetails("模型来源（sources）", evidence?.sourceCount, evidence?.sources),
  ]);
}

function reportRunDetails(report: ReportRun | null | undefined, job: ReportJob | null | undefined): VNodeChild {
  const evidence = report?.evidence;
  const fields: Array<[string, unknown]> = [
    ["任务 ID", job?.taskId],
    ["运行 ID", report?.runId || job?.runId],
    ["报告产物 ID", report?.artifactId],
    ["原始模型任务 ID", evidence?.rawTaskId],
    ["原始模型运行 ID", evidence?.rawRunId],
    ["原始模型产物 ID", evidence?.rawArtifactId],
    ["创建时间", job?.createdAt ? date(job.createdAt) : null],
    ["开始时间", job?.startedAt ? date(job.startedAt) : null],
    ["完成时间", job?.completedAt ? date(job.completedAt) : report?.generatedAt ? date(report.generatedAt) : null],
    ["更新时间", job?.updatedAt ? date(job.updatedAt) : null],
  ];
  return h("details", { class: "ia-run-details" }, [
    h("summary", "任务、运行与产物详情"),
    h("dl", fields.map(([label, value]) => h("div", { key: label }, [h("dt", label), h("dd", text(value) || "未记录")]))),
  ]);
}

function reportCard(options: {
  title: string;
  description: string;
  report: ReportRun | null | undefined;
  job: ReportJob | null | undefined;
  requestError: string | null;
  emptyMessage: string;
  now: number;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange?: (value: ReasoningEffort) => void;
  buttonLabel?: string;
  onRefresh?: () => void;
  onResume?: () => void;
  resumeAvailable?: boolean;
  onStageRerun?: (stageKey: string) => void;
  disabled?: boolean;
  versions?: ReportVersion[];
  selectedRunId?: string | null;
  onVersionChange?: (runId: string) => void;
  onCompare?: () => void;
}): VNodeChild {
  const running = isRunning(options.job);
  const completedMarkdown = text(options.report?.reportMarkdown);
  const prompt = options.report?.prompt || options.job?.prompt;
  const sessionUrl = httpsUrl(asRecord(asRecord(options.report?.input).webqaSession).sessionUrl);
  const providerUrl = httpsUrl(options.report?.evidence?.providerUrl) || sessionUrl;
  const recordedModelRun = asRecord(asRecord(options.report?.input).modelRun);
  const model = running ? text(prompt?.model) || text(recordedModelRun.model) : text(recordedModelRun.model) || text(prompt?.model);
  const effort = running ? text(options.job?.reasoningEffort) || text(recordedModelRun.reasoningEffort) : text(recordedModelRun.reasoningEffort) || text(options.job?.reasoningEffort);
  const showExecutionMetadata = running || Boolean(completedMarkdown || prompt || options.job?.reasoningEffort);
  const executionMetadata = showExecutionMetadata ? [
    `使用模型 ${model || "未记录"}`,
    `思考深度 ${reasoningEffortLabel(effort)}`,
  ] : [];
  const markdown = completedMarkdown;
  const qualityIssues = completedMarkdown && !running ? reportQualityIssues(completedMarkdown) : [];
  const elapsed = running ? runningDuration(options.job, options.now) : completedDuration(options.report, options.job);
  const streamStats = streamStatsSummary(running ? options.job?.streamStats : options.report?.streamStats);
  const reportStatus = running ? options.job?.status : options.report?.status || options.job?.status;
  // A polling transport error only means the local Node runtime is temporarily
  // unreachable. It must never overwrite an already-persisted queued/running
  // job with a false "generation failed" state.
  const failure = options.job?.status === "failed" || options.job?.status === "blocked" ? text(options.job.lastError) : (!running ? options.requestError : null);
  return h("section", { class: "ia-report" }, [
    h("div", { class: "ia-report-head" }, [
      h("div", [
        h("div", { class: "ia-report-title" }, [h("h2", options.title), h("span", { class: `ia-report-status ${reportStatusClass(reportStatus, running)}`, role: "status" }, reportStatusLabel(reportStatus, running))]),
        h("p", options.description),
        running ? h("div", { class: "ia-meta ia-running-meta", role: "status" }, [
          h("span", `任务已运行 ${elapsed}；页面每 5 秒读取一次阶段状态。`),
          ...executionMetadata.map((item) => h("span", item)),
          ...streamStats.map((item) => h("span", item)),
          providerUrl ? h("a", { href: providerUrl, target: "_blank", rel: "noopener noreferrer" }, "打开提供方会话") : null,
        ]) : showExecutionMetadata ? h("div", { class: "ia-meta" }, [
          h("span", `生成于 ${date(options.report?.generatedAt)} · 整体耗时 ${elapsed} · ${options.report?.provider || "提供方未记录"} · ${options.report?.promptVersion || "模板未记录"}`),
          ...executionMetadata.map((item) => h("span", item)),
          ...streamStats.map((item) => h("span", item)),
          providerUrl ? h("a", { href: providerUrl, target: "_blank", rel: "noopener noreferrer" }, "打开提供方会话") : null,
        ]) : null,
      ]),
      options.onRefresh && options.buttonLabel ? h("div", { class: "ia-generation-controls" }, [
        (options.versions?.length || 0) > 0 ? h("label", { class: "ia-version-control" }, [
          h("span", "报告版本"),
          h("select", {
            value: options.selectedRunId || options.versions?.[0]?.runId || "",
            onChange: (event: Event) => options.onVersionChange?.((event.target as HTMLSelectElement).value),
          }, options.versions?.map((item) => h("option", { value: item.runId }, versionLabel(options.versions || [], item.runId))) || []),
        ]) : null,
        h("label", { class: "ia-reasoning-control" }, [
          h("span", "推理深度"),
          h("select", {
            value: options.reasoningEffort,
            disabled: running,
            onChange: (event: Event) => options.onReasoningEffortChange?.((event.target as HTMLSelectElement).value as ReasoningEffort),
          }, reasoningEffortOptions.map((item) => h("option", { value: item }, item))),
        ]),
        (options.versions?.length || 0) > 1 ? h("button", { class: "ia-compare", type: "button", onClick: options.onCompare }, "比较版本") : null,
        options.onResume && options.resumeAvailable ? h("button", { class: "ia-resume", disabled: Boolean(options.disabled || running), onClick: options.onResume }, "从失败阶段继续") : null,
        h("button", { class: "ia-refresh", disabled: Boolean(options.disabled || running), onClick: options.onRefresh }, running ? (options.job?.status === "queued" ? `已排队（${elapsed}）` : `正在生成（${elapsed}）`) : options.buttonLabel),
      ]) : null,
    ]),
    markdown || prompt ? [
      reportProvenanceCard(options.report?.evidence),
      reportRunDetails(options.report, options.job),
      workflowProgress(options.job, options.now, options.onStageRerun),
      failure ? h("div", { class: "ia-message error", role: "status" }, [h("strong", "生成未完成"), h("span", failure)]) : null,
      qualityIssues.length ? h("div", { class: "ia-quality-warning", role: "status", style: "margin-top:17px;border:1px solid #e6cb82;border-radius:10px;background:#fff9e7;padding:10px 12px;color:#745300;font-size:12px;line-height:1.6" }, [h("strong", "报告已生成，但需注意："), h("span", qualityIssues.join("；"))]) : null,
      prompt ? h("details", { class: "ia-prompt" }, [
        h("summary", "查看实际发送给 WebQA 的 Prompt"),
        h("div", { class: "ia-prompt-body" }, [
          h("h4", "WebQA input（实际提交文本）"),
          h("pre", renderWebQaInput(prompt)),
        ]),
      ]) : null,
      markdown ? h("article", { class: "ia-markdown" }, renderMarkdown(markdown)) : h("div", { class: "ia-message" }, "实际工作包完成并通过报告门禁后，正文才会显示。"),
    ]
      : h("div", { class: failure ? "ia-message error" : "ia-message" }, failure ? [h("strong", "生成失败"), h("span", failure), workflowProgress(options.job, options.now, options.onStageRerun)] : running ? [`任务已运行 ${elapsed}；页面会每 5 秒读取一次工作包状态。可以离开或刷新页面。`, workflowProgress(options.job, options.now, options.onStageRerun), options.requestError ? h("span", { class: "ia-connection-warning" }, `本地 Worker 暂时无法连接（${options.requestError}）；恢复后将继续读取任务状态。`) : null] : options.emptyMessage),
  ]);
}

function renderWebQaInput(prompt: ModelPrompt): string {
  const pieces: string[] = [];
  if (text(prompt.instructions)) pieces.push(`任务要求：\n${text(prompt.instructions)}`);
  if (text(prompt.userPrompt)) pieces.push(`user:\n${text(prompt.userPrompt)}`);
  return pieces.join("\n\n") || "未记录";
}

function workflowProgress(job: ReportJob | null | undefined, now: number, onRerun?: (stageKey: string) => void): VNodeChild | null {
  const packages = job?.workflowPackages || [];
  if (!packages.length) return stageProgress(job, now, onRerun);
  const counts = packages.reduce((result, item) => {
    if (item.status === "complete") result.complete += 1;
    else if (item.status === "not_applicable") result.notApplicable += 1;
    else if (item.status === "failed" || item.status === "blocked") result.attention += 1;
    return result;
  }, { complete: 0, notApplicable: 0, attention: 0 });
  const summary = `实际工作流 · ${counts.complete} 已完成 · ${counts.notApplicable} 已合并/未单独执行 · ${counts.attention} 失败/阻断`;
  return h("details", { class: "ia-stage-progress ia-workflow-details", "aria-label": "实际执行工作流", open: isRunning(job) ? true : undefined }, [
    h("summary", summary),
    h("div", { class: "ia-stage-recovery" }, "工作包与实际子任务一一对应；兼容 S0-S12 阶段仅用于恢复和产物读取，不代表独立模型调用。"),
    h("ol", packages.map((item) => {
      const active = item.status === "running";
      const detail = active ? `已运行 ${duration(now - Number(item.startedAt || item.updatedAt || now))}` : item.elapsedMs !== null && item.elapsedMs !== undefined ? `耗时 ${duration(item.elapsedMs)}` : item.completedAt && item.startedAt ? `耗时 ${duration(Number(item.completedAt) - Number(item.startedAt))}` : "";
      const execution = item.bypassed ? "已合并，不单独执行" : item.execution === "model" ? `一次模型/WebQA 调用${item.webSearch ? "（含 Web Search）" : ""}` : "确定性执行";
      const coverage = item.stageKeys?.length ? `覆盖：${item.stageKeys.join("、")}` : "";
      const rerun = onRerun && item.stageKeys?.length && (item.status === "failed" || item.status === "blocked") ? h("button", { class: "ia-stage-rerun", type: "button", onClick: () => onRerun(item.stageKeys![0]) }, "重跑此工作包") : null;
      return h("li", { class: `ia-stage ${item.status || "queued"}` }, [h("span", { class: "ia-stage-dot" }), h("div", [h("strong", item.label || item.key), h("span", `${stageStatusLabel(item.status)}${detail ? ` · ${detail}` : ""} · ${execution}`), coverage ? h("small", { style: "color:#6b817d" }, coverage) : null, text(item.lastError) ? h("small", text(item.lastError)) : null, rerun])]);
    })),
  ]);
}

/** Legacy task rows had one child per S0-S12 stage. Keep their historical
 * progress readable, but never use this compatibility projection for the
 * current package-based workflow. */
function stageProgress(job: ReportJob | null | undefined, now: number, onRerun?: (stageKey: string) => void): VNodeChild | null {
  if (!job?.stages?.length) return null;
  const recovery = job.lineageRunId ? `恢复自 ${job.lineageRunId}；本次 attempt ${job.attempt || job.attemptCount || 0}` : `本次 attempt ${job.attempt || job.attemptCount || 0}`;
  const counts = job.stages.reduce((result, stage) => {
    const status = stage.status || "queued";
    if (status === "complete") result.complete += 1;
    else if (status === "not_applicable") result.notApplicable += 1;
    else if (status === "failed" || status === "blocked" || status === "partial") result.attention += 1;
    return result;
  }, { complete: 0, notApplicable: 0, attention: 0 });
  const summary = `历史阶段详情 · ${counts.complete} 已完成 · ${counts.notApplicable} 不适用 · ${counts.attention} 失败/阻断`;
  return h("details", { class: "ia-stage-progress ia-workflow-details", "aria-label": "历史阶段详情", open: isRunning(job) ? true : undefined }, [
    h("summary", summary),
    h("div", { class: "ia-stage-recovery" }, recovery),
    h("ol", job.stages.map((stage) => {
      const active = stage.status === "running";
      const detail = active ? `已运行 ${duration(now - Number(stage.startedAt || stage.updatedAt || now))}` : stage.elapsedMs !== null && stage.elapsedMs !== undefined ? `耗时 ${duration(stage.elapsedMs)}` : stage.completedAt && stage.startedAt ? `耗时 ${duration(Number(stage.completedAt) - Number(stage.startedAt))}` : "";
      const error = text(stage.lastError);
      const blocked = Array.isArray(stage.blocked) ? stage.blocked.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("；") : "";
      const reuse = stage.reused ? ` · 已复用${stage.sourceRunId ? `（${stage.sourceRunId}）` : ""}` : "";
      const rerun = onRerun && (stage.status === "failed" || stage.status === "blocked") ? h("button", { class: "ia-stage-rerun", type: "button", onClick: () => onRerun(stage.stageKey) }, "定向重跑") : null;
      return h("li", { class: `ia-stage ${stage.status || "queued"}` }, [h("span", { class: "ia-stage-dot" }), h("div", [h("strong", stage.label || stage.stageKey), h("span", `${stageStatusLabel(stage.status)}${detail ? ` · ${detail}` : ""}${reuse}`), error || blocked ? h("small", error || blocked) : null, rerun])]);
    })),
  ]);
}

function routingStateLabel(state: RoutingCurrent["state"]): string {
  return state === "confirmed" ? "已确认" : "未确认";
}

function routingFieldLabel(field: string): string {
  return ({ primaryBusiness: "主营业务", primary_business: "主营业务", products: "产品边界", productBoundary: "产品边界", product_boundary: "产品边界", downstream: "下游/客户", industry: "行业", regions: "地区", segments: "分部" } as Record<string, string>)[field] || field;
}

function routingValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => routingValues(item));
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return [];
}

function routingPanel(options: {
  routing?: OperatingRouting | null;
  companyProfile?: EastmoneyCompanyProfile | null;
  confirming: boolean;
  selectedCategoryId: string;
  selectedTemplateId: string;
  requestError?: string | null;
  success?: string | null;
  onCategoryChange: (categoryId: string, templateId: string) => void;
  onTemplateChange: (value: string, categoryId: string) => void;
  onConfirm: () => void;
}): VNodeChild {
  const routing = options.routing;
  const companyProfile = options.companyProfile || null;
  const current = routing?.current || {};
  const automatic = asRecord(routing?.automatic);
  const observedCandidates = [...(Array.isArray(current.candidateTemplates) ? current.candidateTemplates : []), ...(Array.isArray(automatic.candidateTemplates) ? automatic.candidateTemplates as RoutingCandidate[] : [])];
  const candidates = (Array.isArray(routing?.templates) ? routing.templates : []).map((template) => {
    const ids = [text(template.templateId), ...(Array.isArray(template.legacyTemplateIds) ? template.legacyTemplateIds.map(text) : [])];
    const observed = observedCandidates.find((candidate) => ids.includes(text(candidate.templateId)));
    return { ...observed, ...template };
  }).filter((candidate): candidate is RoutingCandidate => Boolean(text(candidate.templateId)));
  const selectedTemplateId = options.selectedTemplateId || text(current.selectedTemplateId);
  const selectedTemplate = candidates.find((candidate) => text(candidate.templateId) === selectedTemplateId);
  const categories = (Array.isArray(routing?.presentationCategories) ? routing.presentationCategories : [])
    .map((category) => ({ id: text(category.id), label: text(category.label) }))
    .filter((category) => category.id && category.label);
  const selectedCategoryId = options.selectedCategoryId || text(selectedTemplate?.presentationCategoryId);
  const categoryTemplates = candidates.filter((candidate) => text(candidate.presentationCategoryId) === selectedCategoryId);
  const automaticTemplate = asRecord(automatic.analysisTemplate);
  const appliedCategory = text(selectedTemplate?.presentationCategoryLabel) || text(automaticTemplate.presentationCategoryLabel);
  const appliedFeature = text(automaticTemplate.industryProfileLabel) || text(selectedTemplate?.operatingFeatureLabel) || text(automaticTemplate.operatingFeatureLabel);
  const scope = asRecord(current.companyScope || automatic.companyScope);
  const scopeEntries = Object.entries(scope).filter(([field, value]) => field !== "facts" && field !== "basisSourceIds" && field !== "collectionStatus" && field !== "confirmation" && routingValues(value).length);
  const reasons = (Array.isArray(current.reasons) ? current.reasons : []).filter((reason): reason is RoutingReason => Boolean(reason && typeof reason === "object" && text(reason.message)));
  const automaticReason = asRecord(automatic.mappingReason);
  if (!reasons.length && text(automaticReason.message)) reasons.push(automaticReason as RoutingReason);
  const collectionBasis = routingValues(automatic.collectionBasis || automatic.materials?.map((item) => asRecord(item).role || asRecord(item).title));
  const confirmed = current.state === "confirmed";
  const confirmation = routing?.manualConfirmation || null;
  const availabilityMessage = routing?.availability === "unavailable" ? "路由确认审计表尚未初始化；当前只能查看自动匹配结果。" : null;
  const eastmoneyIndustry = companyProfile?.availability === "available" ? text(companyProfile.industry) : "";
  const hasUnmappedEastmoneyTemplate = Boolean(eastmoneyIndustry) && reasons.some((reason) => ["eastmoney_em2016_unmapped", "eastmoney_em2016_profile_unmapped"].includes(text(reason.code)));
  return h("section", { class: "ia-routing", "aria-label": "S0.2本地分析模板路由" }, [
    h("div", { class: "ia-routing-head" }, [
      h("div", [h("h3", "S0.2 东方财富行业模板路由"), h("p", "A 股默认使用东方财富 F10 的 EM2016 三级行业细分模板；仅在 EM2016 缺失或细分模板未配置时需要人工确认。")]),
      h("span", { class: `ia-routing-state ${confirmed ? "confirmed" : "unconfirmed"}` }, routingStateLabel(current.state)),
    ]),
    availabilityMessage ? h("div", { class: "ia-routing-warning", role: "status" }, availabilityMessage) : null,
    eastmoneyIndustry ? h("p", { class: "ia-routing-profile" }, [h("strong", "东方财富 EM2016 行业："), eastmoneyIndustry]) : h("div", { class: "ia-routing-warning", role: "status" }, "东方财富 EM2016 行业暂不可用；请选择模板并确认。"),
    hasUnmappedEastmoneyTemplate ? h("div", { class: "ia-routing-template-gap", role: "alert" }, [h("strong", "待补细分行业模板"), h("span", `已取得东财 EM2016 行业“${eastmoneyIndustry}”，但当前没有对应的细分行业模板。请先人工选择临时适用模板并确认；将该行业路径反馈给我后可补充专用模板。`)]) : null,
    scopeEntries.length ? h("div", { class: "ia-routing-scope" }, [h("strong", "已收集的范围事实"), h("dl", scopeEntries.map(([field, value]) => h("div", { key: field }, [h("dt", routingFieldLabel(field)), h("dd", routingValues(value).join("、"))])))]) : h("div", { class: "ia-routing-empty" }, "本地输入尚未提供可审计的主营、产品、下游或行业范围；需要人工确认并留下范围说明。"),
    collectionBasis.length ? h("p", { class: "ia-routing-basis" }, [h("strong", "采集依据："), collectionBasis.join("、")]) : null,
    reasons.length ? h("ul", { class: "ia-routing-reasons" }, reasons.map((reason) => h("li", { key: `${reason.code || "reason"}:${reason.message}` }, [h("strong", reason.code || "路由原因"), h("span", reason.message), Array.isArray(reason.fields) && reason.fields.length ? h("small", `涉及字段：${reason.fields.join("、")}`) : null]))) : null,
    appliedCategory && appliedFeature ? h("p", { class: "ia-routing-profile" }, [h("strong", "当前适用经营特征："), `${appliedCategory} · ${appliedFeature}`]) : null,
    h("form", { class: "ia-routing-form", onSubmit: (event: Event) => { event.preventDefault(); options.onConfirm(); } }, [
      h("label", [h("span", "一级研究类别"), h("select", { value: selectedCategoryId, disabled: options.confirming || routing?.availability === "unavailable", onChange: (event: Event) => {
        const categoryId = (event.target as HTMLSelectElement).value;
        const templates = candidates.filter((candidate) => text(candidate.presentationCategoryId) === categoryId);
        options.onCategoryChange(categoryId, templates.length === 1 ? text(templates[0].templateId) : "");
      } }, [h("option", { value: "", disabled: true }, "请选择研究类别"), ...categories.map((category) => h("option", { value: category.id }, category.label))])]),
      h("label", [h("span", "经营特征"), h("select", { value: selectedTemplateId, disabled: options.confirming || routing?.availability === "unavailable" || !selectedCategoryId, onChange: (event: Event) => options.onTemplateChange((event.target as HTMLSelectElement).value, selectedCategoryId) }, [h("option", { value: "", disabled: true }, selectedCategoryId ? "请选择与公司主营相符的经营特征" : "请先选择研究类别"), ...categoryTemplates.map((candidate) => h("option", { value: candidate.templateId }, candidate.operatingFeatureLabel || candidate.label || candidate.templateId))])]),
      h("button", { class: "ia-routing-confirm", type: "submit", disabled: options.confirming || !selectedTemplateId || routing?.availability === "unavailable" }, options.confirming ? "正在确认…" : confirmed ? "确认并切换模板" : "确认模板并继续研究"),
    ]),
    confirmation ? h("p", { class: "ia-routing-audit" }, `最近确认：${appliedCategory && appliedFeature ? `${appliedCategory} · ${appliedFeature}（${confirmation.selectedTemplateId || "—"}）` : confirmation.selectedTemplateId || "—"} · ${confirmation.actorKey || "local-user"} · ${date(confirmation.createdAt)}${confirmation.confirmationId ? ` · ${confirmation.confirmationId}` : ""}`) : null,
    options.success ? h("div", { class: "ia-routing-success", role: "status" }, options.success) : null,
    options.requestError ? h("div", { class: "ia-routing-error", role: "alert" }, options.requestError) : null,
  ]);
}

const styles = `
.ia-resume{flex:none;border:1px solid #08786c;border-radius:9px;background:#effaf6;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}.ia-resume:disabled{opacity:.58;cursor:wait}
.ia{--ink:#183a37;--muted:#637c78;--line:#d8e8e4;--paper:#fff;--ground:#f4f8f7;--teal:#08786c;--deep:#075d57;min-height:calc(100vh - 7rem);padding:26px 0 56px;background:var(--ground);color:var(--ink)}.ia *{box-sizing:border-box}.ia-shell{max-width:1180px}.ia-hero{padding:28px;border-radius:20px;background:linear-gradient(125deg,#143c47,#08786c);color:#fff;box-shadow:0 16px 38px #143d3926}.ia-kicker{font-size:11px;font-weight:850;letter-spacing:.12em;color:#c0e8df}.ia-hero h1{margin:9px 0 7px;font-size:30px;letter-spacing:-.025em}.ia-hero p{max-width:760px;margin:0;color:#d2ebe5;font-size:14px;line-height:1.65}.ia-document{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}.ia-document-empty{display:block}.ia-outline{position:sticky;top:16px;padding:16px 13px;border:1px solid var(--line);border-radius:15px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-outline h2{margin:0 0 9px;padding:0;border:0;color:#315b55;font-size:13px}.ia-outline button{display:block;width:100%;border:0;border-radius:6px;background:transparent;padding:6px 7px;color:#476762;font:600 12px/1.45 inherit;text-align:left;cursor:pointer}.ia-outline button:hover{background:#edf8f4;color:var(--deep)}.ia-outline .l1{font-weight:850;color:#1c4d46}.ia-outline .l2{padding-left:16px}.ia-outline .l3{padding-left:27px}.ia-outline .l4{padding-left:38px}.ia-report{padding:23px 25px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-report-head{display:block}.ia-report h2{margin:0;font-size:20px;letter-spacing:-.01em}.ia-report-head p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.ia-generation-controls{display:flex;align-items:end;gap:9px;flex-wrap:nowrap;justify-content:flex-end;width:100%;margin-top:16px}.ia-reasoning-control{display:grid;gap:4px;color:#476762;font-size:10px;font-weight:800}.ia-reasoning-control select{max-width:220px;border:1px solid #b6dcd3;border-radius:8px;background:#fff;padding:7px 8px;color:#174b45;font:600 11px inherit}.ia-reasoning-control select:disabled{opacity:.58}.ia-refresh{flex:none;border:1px solid #b6dcd3;border-radius:9px;background:#fff;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}.ia-refresh:disabled{opacity:.58;cursor:wait}.ia-message{margin-top:17px;border:1px dashed #c7dad5;border-radius:12px;padding:15px;color:#58716d;font-size:13px;line-height:1.65}.ia-message.error{border-style:solid;border-color:#edc8c2;background:#fff5f3;color:#983e34}.ia-message strong,.ia-message span{display:block}.ia-message span{margin-top:5px}.ia-connection-warning{color:#9c6500}.ia-meta{display:flex;flex-wrap:wrap;gap:5px 10px;margin-top:9px;color:#738783;font-size:11px;line-height:1.5}.ia-running-meta{color:#076b60;font-weight:750}.ia-reasoning{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#f8fcfb;padding:14px 16px}.ia-reasoning h3{margin:0;color:#174b45;font-size:14px}.ia-reasoning-markdown{margin-top:10px;font-size:13px;line-height:1.7}.ia-reasoning-markdown h1,.ia-reasoning-markdown h2{font-size:17px}.ia-reasoning-empty{margin:8px 0 0;color:#637c78;font-size:12px;line-height:1.6}.ia-markdown{margin-top:22px;color:#203d39;font-size:15px;line-height:1.8}.ia-markdown h1,.ia-markdown h2{scroll-margin-top:18px;margin:31px 0 11px;padding-top:21px;border-top:1px solid #dceae6;color:var(--deep);font-size:22px}.ia-markdown h1:first-child,.ia-markdown h2:first-child{margin-top:0;padding-top:0;border-top:0}.ia-markdown h3{scroll-margin-top:18px;margin:22px 0 8px;color:#174b45;font-size:17px}.ia-markdown h4{scroll-margin-top:18px;margin:17px 0 7px;color:#285852;font-size:15px}.ia-markdown p{margin:11px 0}.ia-markdown ul,.ia-markdown ol{margin:10px 0;padding-left:24px}.ia-markdown li{margin:5px 0}.ia-markdown blockquote{margin:14px 0;padding:10px 15px;border-left:3px solid #8bc8bb;background:#f1faf7;color:#315951}.ia-markdown strong{font-weight:800;color:#123f3a}.ia-markdown code{padding:1px 4px;border-radius:4px;background:#eaf4f1;color:#08645a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}.ia-markdown a{color:var(--teal);text-decoration:underline;text-underline-offset:2px}.ia-table-wrap{overflow-x:auto;margin:14px 0}.ia-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.55}.ia-table th,.ia-table td{border:1px solid #dce9e6;padding:8px 9px;text-align:left;vertical-align:top}.ia-table th{background:#eff8f5;color:#305b55;font-weight:850}@media(max-width:800px){.ia-document{display:block}.ia-outline{position:static;margin-bottom:16px}.ia-outline button{display:inline-block;width:auto;margin-right:3px}.ia-outline .l2,.ia-outline .l3,.ia-outline .l4{padding-left:7px}}@media(max-width:650px){.ia{padding:13px 0 34px}.ia-hero,.ia-report{padding:18px;border-radius:15px}.ia-hero h1{font-size:25px}.ia-report-head{flex-direction:column}.ia-generation-controls{align-items:start;flex-wrap:wrap;flex:0 1 auto;width:100%}.ia-markdown{font-size:14px}.ia-markdown h1,.ia-markdown h2{font-size:20px}}
.ia-outline{max-height:calc(100vh - 32px);overflow-y:auto;overscroll-behavior:contain}
@media(max-width:800px){.ia-outline{max-height:none;overflow:visible}}
.ia-prompt{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#fff;padding:12px 15px}.ia-prompt summary{cursor:pointer;color:#174b45;font-size:13px;font-weight:800}.ia-prompt-body{margin-top:12px}.ia-prompt-body h4{margin:13px 0 6px;color:#476762;font-size:12px}.ia-prompt-body h4:first-child{margin-top:0}.ia-prompt-body pre{max-height:420px;overflow:auto;margin:0;padding:11px;border:1px solid #dce9e6;border-radius:8px;background:#f6faf9;color:#234640;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
.ia-version-control{display:grid;gap:4px;color:#476762;font-size:10px;font-weight:800;flex:none}.ia-version-control select{max-width:250px;border:1px solid #b6dcd3;border-radius:8px;background:#fff;padding:7px 8px;color:#174b45;font:600 11px inherit}.ia-compare{flex:none;border:1px solid #69a99d;border-radius:9px;background:#f1faf7;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}@media(max-width:650px){.ia-generation-controls{justify-content:flex-start}}
.ia-stage-progress{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#f8fcfb;padding:13px 15px}.ia-stage-progress h3{margin:0 0 4px;color:#174b45;font-size:13px}.ia-stage-recovery{margin-bottom:9px;color:#6b817d;font-size:11px}.ia-stage-progress ol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 12px;margin:0;padding:0;list-style:none}.ia-stage{display:flex;gap:8px;min-width:0;color:#6b817d;font-size:12px;line-height:1.45}.ia-stage-dot{width:8px;height:8px;flex:none;margin-top:4px;border-radius:50%;background:#b6c9c5}.ia-stage strong,.ia-stage span,.ia-stage small{display:block}.ia-stage strong{color:#365a54}.ia-stage small{margin-top:2px;color:#a24337;overflow-wrap:anywhere}.ia-stage-rerun{margin-top:4px;border:1px solid #e3b9b0;border-radius:6px;background:#fff5f3;color:#98463d;padding:3px 7px;font:700 10px inherit;cursor:pointer}.ia-stage.running .ia-stage-dot{background:#08786c;box-shadow:0 0 0 4px #08786c22}.ia-stage.complete .ia-stage-dot,.ia-stage.partial .ia-stage-dot,.ia-stage.not_applicable .ia-stage-dot{background:#34a27d}.ia-stage.blocked .ia-stage-dot,.ia-stage.failed .ia-stage-dot{background:#c76854}@media(max-width:650px){.ia-stage-progress ol{grid-template-columns:1fr}}
.ia-routing{margin-top:17px;border:1px solid #cde4de;border-radius:12px;background:#fbfefd;padding:15px 16px;color:#315951;font-size:12px;line-height:1.55}.ia-routing-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ia-routing-head h3{margin:0;color:#174b45;font-size:15px}.ia-routing-head p{margin:5px 0 0;color:#637c78}.ia-routing-state{flex:none;border-radius:999px;padding:4px 9px;background:#fff4e5;color:#98631c;font-size:11px;font-weight:850}.ia-routing-state.confirmed{background:#e6f7ee;color:#15734f}.ia-routing-warning,.ia-routing-error{margin-top:11px;border:1px solid #edc8c2;border-radius:8px;background:#fff5f3;padding:9px 10px;color:#983e34}.ia-routing-template-gap{display:grid;gap:3px;margin-top:11px;border:1px solid #e1b84f;border-radius:8px;background:#fff9e8;padding:9px 10px;color:#7b5700}.ia-routing-template-gap strong{font-size:12px}.ia-routing-success{margin-top:11px;border:1px solid #b9e2d2;border-radius:8px;background:#effbf5;padding:9px 10px;color:#15734f}.ia-routing-scope{margin-top:12px;padding:10px 11px;border-radius:8px;background:#f1faf7}.ia-routing-scope strong{color:#174b45}.ia-routing-scope dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 14px;margin:8px 0 0}.ia-routing-scope dl div{min-width:0}.ia-routing-scope dt{color:#6a8580;font-size:11px}.ia-routing-scope dd{margin:1px 0 0;color:#234e48;overflow-wrap:anywhere}.ia-routing-basis{margin:10px 0 0;color:#637c78}.ia-routing-reasons{margin:10px 0 0;padding-left:18px;color:#6b5148}.ia-routing-reasons li{margin:4px 0}.ia-routing-reasons strong,.ia-routing-reasons span,.ia-routing-reasons small{display:block}.ia-routing-reasons strong{color:#9a5b2b;font-size:11px}.ia-routing-reasons small{color:#8d7770}.ia-routing-profile{margin:11px 0 0;border-radius:8px;background:#edf8f4;padding:8px 10px;color:#236057}.ia-routing-profile strong{color:#174b45}.ia-routing-form{display:grid;grid-template-columns:repeat(2,minmax(180px,1fr)) auto;align-items:end;gap:9px;margin-top:13px;padding-top:12px;border-top:1px solid #dcece8}.ia-routing-form label{display:grid;gap:4px;color:#476762;font-size:11px;font-weight:800}.ia-routing-form select{width:100%;border:1px solid #b6dcd3;border-radius:7px;background:#fff;padding:7px 8px;color:#174b45;font:600 11px inherit}.ia-routing-confirm{border:1px solid #0a786b;border-radius:8px;background:#08786c;color:#fff;padding:8px 11px;font:800 11px inherit;cursor:pointer}.ia-routing-confirm:disabled{opacity:.56;cursor:not-allowed}.ia-routing-audit{margin:10px 0 0;color:#6c817d;font-size:11px;overflow-wrap:anywhere}@media(max-width:760px){.ia-routing-scope dl,.ia-routing-form{grid-template-columns:1fr}.ia-routing-confirm{justify-self:start}}
`;

const App = defineComponent({
  setup() {
    const code = securityCodeFromUrl();
    const operating = ref<OperatingAnalysisWithRouting | null>(null);
    const selectedReport = ref<ReportRun | null>(null);
    const selectedRunId = ref<string | null>(null);
    const loading = ref(true);
    const operatingError = ref<string | null>(null);
    const routingCategoryId = ref("");
    const routingTemplateId = ref("");
    const routingConfirming = ref(false);
    const routingSuccess = ref<string | null>(null);
    const companyProfile = ref<EastmoneyCompanyProfile | null>(null);
    const elapsedNow = ref(Date.now());
    const selectedReasoningEffort = ref<ReasoningEffort>("xhigh");
    let pollTimer: number | null = null;
    let elapsedTimer: number | null = null;
    let companyInfoRequested = false;

    const load = async () => {
      try {
        const next = await request<OperatingAnalysisWithRouting>(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency`);
        operating.value = next;
        selectedReport.value = projectLowDependencyReport(next);
        selectedRunId.value = next.run?.runId || null;
        const currentRouting = next.routing?.current;
        const rememberedTemplate = text(next.routing?.manualConfirmation?.selectedTemplateId || currentRouting?.selectedTemplateId);
        const canonicalTemplate = next.routing?.templates?.find((template) => text(template.templateId) === rememberedTemplate || template.legacyTemplateIds?.map(text).includes(rememberedTemplate));
        if (!routingTemplateId.value) routingTemplateId.value = text(canonicalTemplate?.templateId) || rememberedTemplate;
        if (!routingCategoryId.value) routingCategoryId.value = text(canonicalTemplate?.presentationCategoryId);
        const recordedEffort = text(next.task?.reasoningEffort || next.run?.reasoningEffort);
        if (recordedEffort && reasoningEffortOptions.includes(recordedEffort as ReasoningEffort)) selectedReasoningEffort.value = recordedEffort as ReasoningEffort;
        operatingError.value = null;
      } catch (reason) { operatingError.value = reason instanceof Error ? reason.message : String(reason); }
      loading.value = false;
    };
    const refreshOperatingAnalysis = async () => {
      operatingError.value = null;
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true, reasoningEffort: selectedReasoningEffort.value }) });
        await load();
      } catch (reason) { operatingError.value = reason instanceof Error ? reason.message : String(reason); }
    };
    const rerunStage = async (stageKey: string) => {
      operatingError.value = null;
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency/rerun`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stageKeys: [stageKey], reasoningEffort: selectedReasoningEffort.value }) });
        await load();
      } catch (reason) { operatingError.value = reason instanceof Error ? reason.message : String(reason); }
    };
    const resumeOperatingAnalysis = async () => {
      operatingError.value = null;
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: operating.value?.resume?.runId, reasoningEffort: selectedReasoningEffort.value }) });
        await load();
      } catch (reason) { operatingError.value = reason instanceof Error ? reason.message : String(reason); }
    };
    const confirmRouting = async () => {
      const selectedTemplateId = routingTemplateId.value.trim();
      if (!selectedTemplateId) {
        operatingError.value = "请选择一个已注册的分析模板";
        return;
      }
      routingConfirming.value = true;
      operatingError.value = null;
      routingSuccess.value = null;
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency/routing/confirm`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ selectedTemplateId }),
        });
        routingSuccess.value = "分析模板确认已写入不可变审计；请重新生成研究。";
        await load();
      } catch (reason) {
        operatingError.value = reason instanceof Error ? reason.message : String(reason);
      } finally { routingConfirming.value = false; }
    };
    const loadCompanyInfo = async () => {
      const year = new Date().getFullYear();
      try {
        const [overview, rows] = await Promise.all([
          request<CompanyOverview>(`/api/company/overview?code=${encodeURIComponent(code)}`),
          request<KlineBar[]>(`/api/kline?code=${encodeURIComponent(code)}&period=day&fq=qfq&from=${year - 2}-12-20&format=structured`),
        ]);
        const latestPrice = finiteNumber(overview.latestPrice);
        companyProfile.value = overview.companyProfile || null;
        const orderedRows = rows.filter((row) => Boolean(row.date)).sort((left, right) => String(left.date).localeCompare(String(right.date)));
        const title = document.getElementById("codeName");
        if (title) title.textContent = `${text(overview.name) || code}(${code})`;
        setInfoBarValue("currentPrice", formatMarketNumber(latestPrice));
        setInfoBarValue("priceChange", formatPercentage(overview.pctChange), finiteNumber(overview.pctChange));
        const yearToDate = changeSince(latestPrice, closingPriceBefore(orderedRows, `${year}-01-01`));
        setInfoBarValue("ytdPriceChange", formatPercentage(yearToDate), yearToDate);
        const lastYearToNow = changeSince(latestPrice, closingPriceBefore(orderedRows, `${year - 1}-01-01`));
        setInfoBarValue("last2NowPriceChange", formatPercentage(lastYearToNow), lastYearToNow);
        setInfoBarValue("marketCap", formatMarketNumber(overview.marketCapYi));
        try {
          const [incomeRows, shareChanges] = await Promise.all([
            request<IncomeStatement[]>(`/api/finance/income?code=${encodeURIComponent(code)}`),
            request<ShareChange[]>(`/api/finance/sharechange?code=${encodeURIComponent(code)}`),
          ]);
          setInfoBarValue("stockValuation", `PE(TTM): ${formatMarketNumber(legacyInfoBarPe(latestPrice, incomeRows, shareChanges))}`);
        } catch (reason) {
          setInfoBarValue("stockValuation", "PE(TTM): 暂无数据");
          console.warn("Could not load investment analysis PE", reason);
        }
      } catch (reason) {
        const title = document.getElementById("codeName");
        if (title) title.textContent = code;
        ["currentPrice", "priceChange", "ytdPriceChange", "last2NowPriceChange", "marketCap", "stockValuation"].forEach((id) => setInfoBarValue(id, "行情不可用"));
        console.warn("Could not load investment analysis company info", reason);
      }
    };
    const requestCompanyInfo = () => {
      if (companyInfoRequested) return;
      companyInfoRequested = true;
      void loadCompanyInfo();
    };
    onMounted(() => {
      void load();
      window.addEventListener(COMPANY_INFO_MOUNTED_EVENT, requestCompanyInfo);
      if (document.getElementById("codeName")) requestCompanyInfo();
      elapsedTimer = window.setInterval(() => { elapsedNow.value = Date.now(); }, 1_000);
      pollTimer = window.setInterval(() => {
        if (isRunning(projectLowDependencyJob(operating.value))) void load();
      }, 5_000);
    });
    onUnmounted(() => {
      window.removeEventListener(COMPANY_INFO_MOUNTED_EVENT, requestCompanyInfo);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
    });

    return () => {
      const activeReport = selectedReport.value || projectLowDependencyReport(operating.value);
      const displayJob = projectLowDependencyJob(operating.value);
      const markdown = text(activeReport?.reportMarkdown);
      return h("main", { class: "ia" }, [
        h("style", styles),
        h("div", { class: "container ia-shell" }, [
          loading.value ? h("section", { class: "ia-report" }, "正在读取已保存的研究报告…") : h("div", { class: markdown ? "ia-document" : "ia-document ia-document-empty" }, [
            markdown ? h("nav", { class: "ia-outline", "aria-label": "报告目录" }, [
            h("h2", "报告目录"),
              ...documentOutline(markdown).map((item) => h("button", { class: `l${item.level}`, onClick: () => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, item.text)),
            ]) : null,
            h("div", [
              h("p", { class: "ia-financial-link" }, ["三表、确定性风险信号与完整财务结论请查看 ", h("a", { href: `company-finance.html?code=${encodeURIComponent(code)}#financial-analysis` }, "深入财务分析")]),
              reportCard({ title: "完整投资研究", description: "stock-info 先工程化采集证券与财务必要输入并冻结，再将完整研究提交给 taskd 的 ChatGPT 执行器；页面只读取最终状态和经校验的报告。", report: activeReport, job: displayJob, requestError: operatingError.value, emptyMessage: `尚无 ${code} 的研究报告。点击生成后将提交 ChatGPT 投资分析任务。`, now: elapsedNow.value, reasoningEffort: selectedReasoningEffort.value, onReasoningEffortChange: (value) => { selectedReasoningEffort.value = value; }, buttonLabel: operating.value?.report?.markdown ? "重新生成报告" : "生成完整研究", onRefresh: () => { void refreshOperatingAnalysis(); }, onResume: () => { void resumeOperatingAnalysis(); }, resumeAvailable: operating.value?.resume?.available === true, disabled: isRunning(displayJob) }),
            ]),
          ]),
        ]),
      ]);
    };
  },
});

const root = document.getElementById("investment-analysis-vue-root");
if (root) createApp(App).mount(root);
