import { createApp, defineComponent, h, onMounted, onUnmounted, ref, type VNodeChild } from "vue";

const DEFAULT_CODE = "300308.SZ";
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_INFO_MOUNTED_EVENT = "stock-info:company-info-mounted";
type Json = Record<string, unknown>;
type StreamStats = { webSearch?: { searched?: boolean; queryCount?: number; citedPageCount?: number }; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number } };
type ModelPrompt = { model?: string; instructions?: string; userPrompt?: string };
type ReportRun = { runId?: string; promptVersion?: string; reportMarkdown?: string; reasoningMarkdown?: string; totalDurationMs?: number | null; provider?: string; generatedAt?: number; input?: Json | null; prompt?: ModelPrompt | null; streamStats?: StreamStats | null };
type ReportVersion = Pick<ReportRun, "runId" | "promptVersion" | "provider" | "generatedAt" | "totalDurationMs">;
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type AnalysisStage = { stageKey: string; label?: string; status?: "queued" | "running" | "complete" | "partial" | "blocked" | "not_applicable" | "failed"; attempt?: number; attemptCount?: number; startedAt?: number | null; completedAt?: number | null; updatedAt?: number | null; elapsedMs?: number | null; lastError?: string | null; blocked?: unknown; outputKind?: "json" | "markdown"; reused?: boolean; sourceRunId?: string | null; prompt?: ModelPrompt | null };
type ReportJob = { status?: "queued" | "running" | "completed" | "failed" | "blocked"; reasoningEffort?: ReasoningEffort; lastError?: string | null; createdAt?: number; startedAt?: number; completedAt?: number; updatedAt?: number; attempt?: number; attemptCount?: number; lineageRunId?: string | null; rerunStageKeys?: string[]; prompt?: ModelPrompt | null; streamStats?: StreamStats | null; stages?: AnalysisStage[] };
type LowDependencyRun = { runId?: string; attempt?: number; lineageRunId?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null; status?: string; startedAt?: number | null; completedAt?: number | null; updatedAt?: number | null; currentStepKey?: string | null };
type LowDependencyReport = { status?: "complete" | "partial" | "blocked" | "not_applicable" | "failed"; artifactId?: string | null; markdown?: string | null; blockers?: unknown[]; projectionFingerprint?: string | null };
type LowDependencyTask = ReportJob & { taskId?: string; jobId?: string; runId?: string | null; protocolVersion?: string; promptVersion?: string; securityCode?: string; currentStepKey?: string | null };
type OperatingAnalysis = { availability?: "available" | "empty" | "unavailable"; protocolVersion?: string; promptVersion?: string; run?: LowDependencyRun | null; task?: LowDependencyTask | null; report?: LowDependencyReport | null; stages?: AnalysisStage[]; finalArtifactId?: string | null; scopeEnvelopeAvailable?: boolean };
type CompanyOverview = { name?: string; latestPrice?: number | null; pctChange?: number | null; marketCapYi?: number | null; peTtm?: number | null };
type KlineBar = { date?: string; close?: number | null };
type IncomeStatement = { parentNetprofit?: number | null };
type ShareChange = { totalShares?: number | null };
const reasoningEffortOptions: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  none: "不主动推理",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "极限",
};

function securityCodeFromUrl(): string {
  const code = new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || DEFAULT_CODE;
  return /^[A-Z0-9]{1,12}\.(SH|SZ|HK|US)$/.test(code) ? code : DEFAULT_CODE;
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
  const prompt = model?.stages?.find((stage) => stage.status === "running")?.prompt || null;
  return {
    status: lowDependencyTaskStatus(task.status), reasoningEffort: task.reasoningEffort, lastError: task.lastError,
    createdAt: task.createdAt, startedAt: run?.startedAt ?? task.startedAt, completedAt: run?.completedAt ?? task.completedAt,
    updatedAt: task.updatedAt, attempt: run?.attempt ?? task.attempt, attemptCount: run?.attempt ?? task.attemptCount,
    lineageRunId: run?.lineageRunId ?? task.lineageRunId ?? null, rerunStageKeys: task.rerunStageKeys || [], prompt,
    stages: model.stages || [],
  };
}
function projectLowDependencyReport(model: OperatingAnalysis | null): ReportRun | null {
  const report = model?.report;
  if (!report?.markdown) return null;
  const run = model?.run;
  return {
    runId: run?.runId, promptVersion: model?.promptVersion, reportMarkdown: report.markdown,
    provider: "local-generic-llm", generatedAt: run?.completedAt || undefined,
    totalDurationMs: run?.startedAt && run?.completedAt ? run.completedAt - run.startedAt : null,
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
  // A polling transport error only means the local Node runtime is temporarily
  // unreachable. It must never overwrite an already-persisted queued/running
  // job with a false "generation failed" state.
  const failure = options.job?.status === "failed" || options.job?.status === "blocked" ? text(options.job.lastError) : (!running ? options.requestError : null);
  return h("section", { class: "ia-report" }, [
    h("div", { class: "ia-report-head" }, [
      h("div", [
        h("h2", options.title),
        h("p", options.description),
        running ? h("div", { class: "ia-meta ia-running-meta", role: "status" }, [
          h("span", `任务已运行 ${elapsed}；页面每 5 秒读取一次阶段状态。`),
          ...executionMetadata.map((item) => h("span", item)),
          ...streamStats.map((item) => h("span", item)),
          sessionUrl ? h("a", { href: sessionUrl, target: "_blank", rel: "noopener noreferrer" }, "打开 ChatGPT 会话") : null,
        ]) : showExecutionMetadata ? h("div", { class: "ia-meta" }, [
          h("span", `生成于 ${date(options.report?.generatedAt)} · 整体耗时 ${elapsed} · ${options.report?.provider || "提供方未记录"} · ${options.report?.promptVersion || "模板未记录"}`),
          ...executionMetadata.map((item) => h("span", item)),
          ...streamStats.map((item) => h("span", item)),
          sessionUrl ? h("a", { href: sessionUrl, target: "_blank", rel: "noopener noreferrer" }, "打开 ChatGPT 会话") : null,
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
        h("button", { class: "ia-refresh", disabled: Boolean(options.disabled || running), onClick: options.onRefresh }, running ? (options.job?.status === "queued" ? `已排队（${elapsed}）` : `正在生成（${elapsed}）`) : options.buttonLabel),
      ]) : null,
    ]),
    markdown || prompt ? [
      stageProgress(options.job, options.now, options.onStageRerun),
      failure ? h("div", { class: "ia-message error", role: "status" }, [h("strong", "生成未完成"), h("span", failure)]) : null,
      qualityIssues.length ? h("div", { class: "ia-quality-warning", role: "status", style: "margin-top:17px;border:1px solid #e6cb82;border-radius:10px;background:#fff9e7;padding:10px 12px;color:#745300;font-size:12px;line-height:1.6" }, [h("strong", "报告已生成，但需注意："), h("span", qualityIssues.join("；"))]) : null,
      prompt ? h("details", { class: "ia-prompt" }, [
        h("summary", "查看实际发送给大模型的 Prompt"),
        h("div", { class: "ia-prompt-body" }, [
          h("h4", "Instructions（系统级指令）"),
          h("pre", prompt.instructions || "未记录"),
          h("h4", "User Prompt（已替换变量的最终文本）"),
          h("pre", prompt.userPrompt || "未记录"),
        ]),
      ]) : null,
      markdown ? h("article", { class: "ia-markdown" }, renderMarkdown(markdown)) : h("div", { class: "ia-message" }, "阶段终态完成并通过报告门禁后，正文才会显示。"),
    ]
      : h("div", { class: failure ? "ia-message error" : "ia-message" }, failure ? [h("strong", "生成失败"), h("span", failure), stageProgress(options.job, options.now, options.onStageRerun)] : running ? [`任务已运行 ${elapsed}；页面会每 5 秒读取一次阶段状态。可以离开或刷新页面。`, stageProgress(options.job, options.now, options.onStageRerun), options.requestError ? h("span", { class: "ia-connection-warning" }, `本地 Worker 暂时无法连接（${options.requestError}）；恢复后将继续读取任务状态。`) : null] : options.emptyMessage),
  ]);
}

function stageProgress(job: ReportJob | null | undefined, now: number, onRerun?: (stageKey: string) => void): VNodeChild | null {
  if (!job?.stages?.length) return null;
  const recovery = job.lineageRunId ? `恢复自 ${job.lineageRunId}；本次 attempt ${job.attempt || job.attemptCount || 0}` : `本次 attempt ${job.attempt || job.attemptCount || 0}`;
  return h("section", { class: "ia-stage-progress", "aria-label": "S0-S12处理进度" }, [
    h("h3", "S0-S12处理进度"),
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

const styles = `
.ia{--ink:#183a37;--muted:#637c78;--line:#d8e8e4;--paper:#fff;--ground:#f4f8f7;--teal:#08786c;--deep:#075d57;min-height:calc(100vh - 7rem);padding:26px 0 56px;background:var(--ground);color:var(--ink)}.ia *{box-sizing:border-box}.ia-shell{max-width:1180px}.ia-hero{padding:28px;border-radius:20px;background:linear-gradient(125deg,#143c47,#08786c);color:#fff;box-shadow:0 16px 38px #143d3926}.ia-kicker{font-size:11px;font-weight:850;letter-spacing:.12em;color:#c0e8df}.ia-hero h1{margin:9px 0 7px;font-size:30px;letter-spacing:-.025em}.ia-hero p{max-width:760px;margin:0;color:#d2ebe5;font-size:14px;line-height:1.65}.ia-document{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}.ia-document-empty{display:block}.ia-outline{position:sticky;top:16px;padding:16px 13px;border:1px solid var(--line);border-radius:15px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-outline h2{margin:0 0 9px;padding:0;border:0;color:#315b55;font-size:13px}.ia-outline button{display:block;width:100%;border:0;border-radius:6px;background:transparent;padding:6px 7px;color:#476762;font:600 12px/1.45 inherit;text-align:left;cursor:pointer}.ia-outline button:hover{background:#edf8f4;color:var(--deep)}.ia-outline .l1{font-weight:850;color:#1c4d46}.ia-outline .l2{padding-left:16px}.ia-outline .l3{padding-left:27px}.ia-outline .l4{padding-left:38px}.ia-report{padding:23px 25px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-report-head{display:block}.ia-report h2{margin:0;font-size:20px;letter-spacing:-.01em}.ia-report-head p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.ia-generation-controls{display:flex;align-items:end;gap:9px;flex-wrap:nowrap;justify-content:flex-end;width:100%;margin-top:16px}.ia-reasoning-control{display:grid;gap:4px;color:#476762;font-size:10px;font-weight:800}.ia-reasoning-control select{max-width:220px;border:1px solid #b6dcd3;border-radius:8px;background:#fff;padding:7px 8px;color:#174b45;font:600 11px inherit}.ia-reasoning-control select:disabled{opacity:.58}.ia-refresh{flex:none;border:1px solid #b6dcd3;border-radius:9px;background:#fff;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}.ia-refresh:disabled{opacity:.58;cursor:wait}.ia-message{margin-top:17px;border:1px dashed #c7dad5;border-radius:12px;padding:15px;color:#58716d;font-size:13px;line-height:1.65}.ia-message.error{border-style:solid;border-color:#edc8c2;background:#fff5f3;color:#983e34}.ia-message strong,.ia-message span{display:block}.ia-message span{margin-top:5px}.ia-connection-warning{color:#9c6500}.ia-meta{display:flex;flex-wrap:wrap;gap:5px 10px;margin-top:9px;color:#738783;font-size:11px;line-height:1.5}.ia-running-meta{color:#076b60;font-weight:750}.ia-reasoning{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#f8fcfb;padding:14px 16px}.ia-reasoning h3{margin:0;color:#174b45;font-size:14px}.ia-reasoning-markdown{margin-top:10px;font-size:13px;line-height:1.7}.ia-reasoning-markdown h1,.ia-reasoning-markdown h2{font-size:17px}.ia-reasoning-empty{margin:8px 0 0;color:#637c78;font-size:12px;line-height:1.6}.ia-markdown{margin-top:22px;color:#203d39;font-size:15px;line-height:1.8}.ia-markdown h1,.ia-markdown h2{scroll-margin-top:18px;margin:31px 0 11px;padding-top:21px;border-top:1px solid #dceae6;color:var(--deep);font-size:22px}.ia-markdown h1:first-child,.ia-markdown h2:first-child{margin-top:0;padding-top:0;border-top:0}.ia-markdown h3{scroll-margin-top:18px;margin:22px 0 8px;color:#174b45;font-size:17px}.ia-markdown h4{scroll-margin-top:18px;margin:17px 0 7px;color:#285852;font-size:15px}.ia-markdown p{margin:11px 0}.ia-markdown ul,.ia-markdown ol{margin:10px 0;padding-left:24px}.ia-markdown li{margin:5px 0}.ia-markdown blockquote{margin:14px 0;padding:10px 15px;border-left:3px solid #8bc8bb;background:#f1faf7;color:#315951}.ia-markdown strong{font-weight:800;color:#123f3a}.ia-markdown code{padding:1px 4px;border-radius:4px;background:#eaf4f1;color:#08645a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}.ia-markdown a{color:var(--teal);text-decoration:underline;text-underline-offset:2px}.ia-table-wrap{overflow-x:auto;margin:14px 0}.ia-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.55}.ia-table th,.ia-table td{border:1px solid #dce9e6;padding:8px 9px;text-align:left;vertical-align:top}.ia-table th{background:#eff8f5;color:#305b55;font-weight:850}@media(max-width:800px){.ia-document{display:block}.ia-outline{position:static;margin-bottom:16px}.ia-outline button{display:inline-block;width:auto;margin-right:3px}.ia-outline .l2,.ia-outline .l3,.ia-outline .l4{padding-left:7px}}@media(max-width:650px){.ia{padding:13px 0 34px}.ia-hero,.ia-report{padding:18px;border-radius:15px}.ia-hero h1{font-size:25px}.ia-report-head{flex-direction:column}.ia-generation-controls{align-items:start;flex-wrap:wrap;flex:0 1 auto;width:100%}.ia-markdown{font-size:14px}.ia-markdown h1,.ia-markdown h2{font-size:20px}}
.ia-outline{max-height:calc(100vh - 32px);overflow-y:auto;overscroll-behavior:contain}
@media(max-width:800px){.ia-outline{max-height:none;overflow:visible}}
.ia-prompt{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#fff;padding:12px 15px}.ia-prompt summary{cursor:pointer;color:#174b45;font-size:13px;font-weight:800}.ia-prompt-body{margin-top:12px}.ia-prompt-body h4{margin:13px 0 6px;color:#476762;font-size:12px}.ia-prompt-body h4:first-child{margin-top:0}.ia-prompt-body pre{max-height:420px;overflow:auto;margin:0;padding:11px;border:1px solid #dce9e6;border-radius:8px;background:#f6faf9;color:#234640;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
.ia-version-control{display:grid;gap:4px;color:#476762;font-size:10px;font-weight:800;flex:none}.ia-version-control select{max-width:250px;border:1px solid #b6dcd3;border-radius:8px;background:#fff;padding:7px 8px;color:#174b45;font:600 11px inherit}.ia-compare{flex:none;border:1px solid #69a99d;border-radius:9px;background:#f1faf7;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}@media(max-width:650px){.ia-generation-controls{justify-content:flex-start}}
.ia-stage-progress{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#f8fcfb;padding:13px 15px}.ia-stage-progress h3{margin:0 0 4px;color:#174b45;font-size:13px}.ia-stage-recovery{margin-bottom:9px;color:#6b817d;font-size:11px}.ia-stage-progress ol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 12px;margin:0;padding:0;list-style:none}.ia-stage{display:flex;gap:8px;min-width:0;color:#6b817d;font-size:12px;line-height:1.45}.ia-stage-dot{width:8px;height:8px;flex:none;margin-top:4px;border-radius:50%;background:#b6c9c5}.ia-stage strong,.ia-stage span,.ia-stage small{display:block}.ia-stage strong{color:#365a54}.ia-stage small{margin-top:2px;color:#a24337;overflow-wrap:anywhere}.ia-stage-rerun{margin-top:4px;border:1px solid #e3b9b0;border-radius:6px;background:#fff5f3;color:#98463d;padding:3px 7px;font:700 10px inherit;cursor:pointer}.ia-stage.running .ia-stage-dot{background:#08786c;box-shadow:0 0 0 4px #08786c22}.ia-stage.complete .ia-stage-dot,.ia-stage.partial .ia-stage-dot,.ia-stage.not_applicable .ia-stage-dot{background:#34a27d}.ia-stage.blocked .ia-stage-dot,.ia-stage.failed .ia-stage-dot{background:#c76854}@media(max-width:650px){.ia-stage-progress ol{grid-template-columns:1fr}}
`;

const App = defineComponent({
  setup() {
    const code = securityCodeFromUrl();
    const operating = ref<OperatingAnalysis | null>(null);
    const selectedReport = ref<ReportRun | null>(null);
    const selectedRunId = ref<string | null>(null);
    const loading = ref(true);
    const operatingError = ref<string | null>(null);
    const elapsedNow = ref(Date.now());
    const selectedReasoningEffort = ref<ReasoningEffort>("max");
    let pollTimer: number | null = null;
    let elapsedTimer: number | null = null;
    let companyInfoRequested = false;

    const load = async () => {
      try {
        const next = await request<OperatingAnalysis>(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency`);
        operating.value = next;
        selectedReport.value = projectLowDependencyReport(next);
        selectedRunId.value = next.run?.runId || null;
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
    const loadCompanyInfo = async () => {
      const year = new Date().getFullYear();
      try {
        const [overview, rows] = await Promise.all([
          request<CompanyOverview>(`/api/company/overview?code=${encodeURIComponent(code)}`),
          request<KlineBar[]>(`/api/kline?code=${encodeURIComponent(code)}&period=day&fq=qfq&from=${year - 2}-12-20&format=structured`),
        ]);
        const latestPrice = finiteNumber(overview.latestPrice);
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
            reportCard({ title: "完整投资研究", description: "S0-S12 阶段按来源、财务、市场事实和确定性计算组装研究报告；页面只读取低依赖 read model，生成由本地任务 worker 执行。", report: activeReport, job: displayJob, requestError: operatingError.value, emptyMessage: `尚无 ${code} 的研究报告。点击生成后，本地任务会按 S0-S12 完成研究。`, now: elapsedNow.value, reasoningEffort: selectedReasoningEffort.value, onReasoningEffortChange: (value) => { selectedReasoningEffort.value = value; }, buttonLabel: operating.value?.report?.markdown ? "重新生成报告" : "生成完整研究", onRefresh: () => { void refreshOperatingAnalysis(); }, onStageRerun: (stageKey) => { void rerunStage(stageKey); }, disabled: isRunning(displayJob) }),
          ]),
        ]),
      ]);
    };
  },
});

const root = document.getElementById("investment-analysis-vue-root");
if (root) createApp(App).mount(root);
