import { createApp, defineComponent, h, onMounted, onUnmounted, ref, type VNodeChild } from "vue";

const DEFAULT_CODE = "300308.SZ";
const REQUEST_TIMEOUT_MS = 12_000;
type Json = Record<string, unknown>;
type StreamStats = { webSearch?: { searched?: boolean; queryCount?: number; citedPageCount?: number }; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number } };
type ReportRun = { runId?: string; promptVersion?: string; reportMarkdown?: string; reasoningMarkdown?: string; totalDurationMs?: number | null; provider?: string; generatedAt?: number; input?: Json | null; streamStats?: StreamStats | null };
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type ReportJob = { status?: "queued" | "running" | "completed" | "failed"; reasoningEffort?: ReasoningEffort; lastError?: string | null; createdAt?: number; startedAt?: number; completedAt?: number; updatedAt?: number; attemptCount?: number; partialReportMarkdown?: string | null; partialReasoningMarkdown?: string | null; partialUpdatedAt?: number | null; streamStats?: StreamStats | null };
type OperatingAnalysis = { availability?: "available" | "empty" | "unavailable"; run?: ReportRun | null; job?: ReportJob | null };
const reasoningEffortOptions: Array<{ value: ReasoningEffort; label: string; description: string }> = [
  { value: "none", label: "不主动推理", description: "最低延迟，类似普通快速模型模式" },
  { value: "low", label: "低", description: "简单分析、轻量代码" },
  { value: "medium", label: "中", description: "日常复杂任务" },
  { value: "high", label: "高", description: "深度分析、多步骤推理" },
  { value: "xhigh", label: "超高", description: "长链推理、复杂工程、研究任务" },
  { value: "max", label: "极限", description: "GPT-5.6 的最高推理档位" },
];

function securityCodeFromUrl(): string {
  const code = new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || DEFAULT_CODE;
  return /^[A-Z0-9]{1,12}\.(SH|SZ|HK|US)$/.test(code) ? code : DEFAULT_CODE;
}

function asRecord(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function date(value: unknown): string {
  if (!value) return "—";
  const parsed = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("zh-CN", { hour12: false });
}
function isRunning(job: ReportJob | null | undefined): boolean { return job?.status === "queued" || job?.status === "running"; }
function duration(ms: unknown): string {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1_000));
  if (!Number.isFinite(totalSeconds)) return "—";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function runningDuration(job: ReportJob | null | undefined, now: number): string {
  const startedAt = Number(job?.createdAt) || Number(job?.startedAt);
  return duration(Number.isFinite(startedAt) ? now - startedAt : Number.NaN);
}
function completedDuration(report: ReportRun | null | undefined, job: ReportJob | null | undefined): string {
  const persisted = Number(report?.totalDurationMs);
  if (Number.isFinite(persisted)) return duration(persisted);
  const startedAt = Number(job?.createdAt) || Number(job?.startedAt);
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
function reportQualityIssues(markdown: string): string[] {
  const requiredHeadings = ["商业模式与赚钱机制", "市场空间、产品边界与收入传导", "行业阶段、供给约束与竞争", "当前增长、驱动与可持续性", "利润质量、现金转换与营运资本", "资本效率与资本配置", "证券定价与反证", "当前价格隐含的经营要求", "关键估值情景与假设", "主报告最可能出错之处与反面证据", "投资逻辑失效路径", "后续跟踪指标与触发阈值"];
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
  disabled?: boolean;
}): VNodeChild {
  const running = isRunning(options.job);
  const completedMarkdown = text(options.report?.reportMarkdown);
  const partialMarkdown = text(options.job?.partialReportMarkdown);
  const completedReasoning = text(options.report?.reasoningMarkdown);
  const partialReasoning = text(options.job?.partialReasoningMarkdown);
  const partial = running && Boolean(partialMarkdown || partialReasoning);
  const markdown = running && partialMarkdown ? partialMarkdown : completedMarkdown || partialMarkdown;
  const reasoning = running ? partialReasoning : completedReasoning;
  const qualityIssues = completedMarkdown && !running ? reportQualityIssues(completedMarkdown) : [];
  const elapsed = running ? runningDuration(options.job, options.now) : completedDuration(options.report, options.job);
  const streamStats = streamStatsSummary(running ? options.job?.streamStats : options.report?.streamStats);
  // A polling transport error only means the local Worker is temporarily
  // unreachable. It must never overwrite an already-persisted queued/running
  // job with a false "generation failed" state.
  const failure = options.job?.status === "failed" ? text(options.job.lastError) : (!running ? options.requestError : null);
  return h("section", { class: "ia-report" }, [
    h("div", { class: "ia-report-head" }, [
      h("div", [
        h("h2", options.title),
        h("p", options.description),
        running ? h("div", { class: "ia-meta ia-running-meta", role: "status" }, [
          h("span", `任务已运行 ${elapsed}；页面每 5 秒读取一次已保存的思考摘要和正文。`),
          ...streamStats.map((item) => h("span", item)),
        ]) : completedMarkdown ? h("div", { class: "ia-meta" }, [
          h("span", `生成于 ${date(options.report?.generatedAt)} · 整体耗时 ${elapsed} · ${options.report?.provider || "提供方未记录"} · ${options.report?.promptVersion || "模板未记录"}`),
          ...streamStats.map((item) => h("span", item)),
        ]) : null,
      ]),
      options.onRefresh && options.buttonLabel ? h("div", { class: "ia-generation-controls" }, [
        h("label", { class: "ia-reasoning-control" }, [
          h("span", "推理深度"),
          h("select", {
            value: options.reasoningEffort,
            disabled: running,
            title: reasoningEffortOptions.find((item) => item.value === options.reasoningEffort)?.description,
            onChange: (event: Event) => options.onReasoningEffortChange?.((event.target as HTMLSelectElement).value as ReasoningEffort),
          }, reasoningEffortOptions.map((item) => h("option", { value: item.value, title: item.description }, `${item.label} · ${item.description}`))),
        ]),
        h("button", { class: "ia-refresh", disabled: Boolean(options.disabled || running), onClick: options.onRefresh }, running ? (options.job?.status === "queued" ? `已排队（${elapsed}）` : `正在生成（${elapsed}）`) : options.buttonLabel),
      ]) : null,
    ]),
    markdown || reasoning ? [
      failure ? h("div", { class: "ia-message error", role: "status" }, [h("strong", "生成未完成"), h("span", failure)]) : null,
      qualityIssues.length ? h("div", { class: "ia-quality-warning", role: "status", style: "margin-top:17px;border:1px solid #e6cb82;border-radius:10px;background:#fff9e7;padding:10px 12px;color:#745300;font-size:12px;line-height:1.6" }, [h("strong", "报告已生成，但需注意："), h("span", qualityIssues.join("；"))]) : null,
      partial ? h("div", { class: "ia-streaming-notice", role: "status" }, `正在生成，以下为已保存的思考摘要和正文（更新于 ${date(options.job?.partialUpdatedAt)}；已运行 ${elapsed}）。`) : null,
      h("section", { class: "ia-reasoning" }, [
        h("h3", "模型返回的思考摘要"),
        reasoning ? h("article", { class: "ia-markdown ia-reasoning-markdown", "aria-live": running ? "polite" : undefined }, renderMarkdown(reasoning))
          : h("p", { class: "ia-reasoning-empty" }, running ? "模型正在推理，思考摘要会在下一次轮询后显示。" : "模型未返回可展示的思考摘要。"),
      ]),
      markdown ? h("article", { class: "ia-markdown", "aria-live": partial ? "polite" : undefined }, renderMarkdown(markdown)) : h("div", { class: "ia-message" }, "模型尚未返回正文；页面会继续读取已保存的输出。"),
    ]
      : h("div", { class: failure ? "ia-message error" : "ia-message" }, failure ? [h("strong", "生成失败"), h("span", failure)] : running ? [`任务已运行 ${elapsed}；页面会每 5 秒读取一次已保存的思考摘要和正文。可以离开或刷新页面。`, options.requestError ? h("span", { class: "ia-connection-warning" }, `本地 Worker 暂时无法连接（${options.requestError}）；恢复后将继续读取任务状态。`) : null] : options.emptyMessage),
  ]);
}

const styles = `
.ia{--ink:#183a37;--muted:#637c78;--line:#d8e8e4;--paper:#fff;--ground:#f4f8f7;--teal:#08786c;--deep:#075d57;min-height:calc(100vh - 7rem);padding:26px 0 56px;background:var(--ground);color:var(--ink)}.ia *{box-sizing:border-box}.ia-shell{max-width:1180px}.ia-hero{padding:28px;border-radius:20px;background:linear-gradient(125deg,#143c47,#08786c);color:#fff;box-shadow:0 16px 38px #143d3926}.ia-kicker{font-size:11px;font-weight:850;letter-spacing:.12em;color:#c0e8df}.ia-hero h1{margin:9px 0 7px;font-size:30px;letter-spacing:-.025em}.ia-hero p{max-width:760px;margin:0;color:#d2ebe5;font-size:14px;line-height:1.65}.ia-document{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}.ia-document-empty{display:block}.ia-outline{position:sticky;top:16px;padding:16px 13px;border:1px solid var(--line);border-radius:15px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-outline h2{margin:0 0 9px;padding:0;border:0;color:#315b55;font-size:13px}.ia-outline button{display:block;width:100%;border:0;border-radius:6px;background:transparent;padding:6px 7px;color:#476762;font:600 12px/1.45 inherit;text-align:left;cursor:pointer}.ia-outline button:hover{background:#edf8f4;color:var(--deep)}.ia-outline .l1{font-weight:850;color:#1c4d46}.ia-outline .l2{padding-left:16px}.ia-outline .l3{padding-left:27px}.ia-outline .l4{padding-left:38px}.ia-report{padding:23px 25px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-report-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.ia-report h2{margin:0;font-size:20px;letter-spacing:-.01em}.ia-report-head p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.ia-generation-controls{display:flex;align-items:end;gap:9px}.ia-reasoning-control{display:grid;gap:4px;color:#476762;font-size:10px;font-weight:800}.ia-reasoning-control select{max-width:220px;border:1px solid #b6dcd3;border-radius:8px;background:#fff;padding:7px 8px;color:#174b45;font:600 11px inherit}.ia-reasoning-control select:disabled{opacity:.58}.ia-refresh{flex:none;border:1px solid #b6dcd3;border-radius:9px;background:#fff;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}.ia-refresh:disabled{opacity:.58;cursor:wait}.ia-message{margin-top:17px;border:1px dashed #c7dad5;border-radius:12px;padding:15px;color:#58716d;font-size:13px;line-height:1.65}.ia-message.error{border-style:solid;border-color:#edc8c2;background:#fff5f3;color:#983e34}.ia-message strong,.ia-message span{display:block}.ia-message span{margin-top:5px}.ia-connection-warning{color:#9c6500}.ia-streaming-notice{margin-top:17px;border:1px solid #b6dcd3;border-radius:10px;background:#f1faf7;padding:9px 12px;color:#315b55;font-size:12px;line-height:1.6}.ia-meta{display:flex;flex-wrap:wrap;gap:5px 10px;margin-top:9px;color:#738783;font-size:11px;line-height:1.5}.ia-running-meta{color:#076b60;font-weight:750}.ia-reasoning{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#f8fcfb;padding:14px 16px}.ia-reasoning h3{margin:0;color:#174b45;font-size:14px}.ia-reasoning-markdown{margin-top:10px;font-size:13px;line-height:1.7}.ia-reasoning-markdown h1,.ia-reasoning-markdown h2{font-size:17px}.ia-reasoning-empty{margin:8px 0 0;color:#637c78;font-size:12px;line-height:1.6}.ia-markdown{margin-top:22px;color:#203d39;font-size:15px;line-height:1.8}.ia-markdown h1,.ia-markdown h2{scroll-margin-top:18px;margin:31px 0 11px;padding-top:21px;border-top:1px solid #dceae6;color:var(--deep);font-size:22px}.ia-markdown h1:first-child,.ia-markdown h2:first-child{margin-top:0;padding-top:0;border-top:0}.ia-markdown h3{scroll-margin-top:18px;margin:22px 0 8px;color:#174b45;font-size:17px}.ia-markdown h4{scroll-margin-top:18px;margin:17px 0 7px;color:#285852;font-size:15px}.ia-markdown p{margin:11px 0}.ia-markdown ul,.ia-markdown ol{margin:10px 0;padding-left:24px}.ia-markdown li{margin:5px 0}.ia-markdown blockquote{margin:14px 0;padding:10px 15px;border-left:3px solid #8bc8bb;background:#f1faf7;color:#315951}.ia-markdown strong{font-weight:800;color:#123f3a}.ia-markdown code{padding:1px 4px;border-radius:4px;background:#eaf4f1;color:#08645a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}.ia-markdown a{color:var(--teal);text-decoration:underline;text-underline-offset:2px}.ia-table-wrap{overflow-x:auto;margin:14px 0}.ia-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.55}.ia-table th,.ia-table td{border:1px solid #dce9e6;padding:8px 9px;text-align:left;vertical-align:top}.ia-table th{background:#eff8f5;color:#305b55;font-weight:850}@media(max-width:800px){.ia-document{display:block}.ia-outline{position:static;margin-bottom:16px}.ia-outline button{display:inline-block;width:auto;margin-right:3px}.ia-outline .l2,.ia-outline .l3,.ia-outline .l4{padding-left:7px}}@media(max-width:650px){.ia{padding:13px 0 34px}.ia-hero,.ia-report{padding:18px;border-radius:15px}.ia-hero h1{font-size:25px}.ia-report-head{flex-direction:column}.ia-generation-controls{align-items:start}.ia-markdown{font-size:14px}.ia-markdown h1,.ia-markdown h2{font-size:20px}}
.ia-outline{max-height:calc(100vh - 32px);overflow-y:auto;overscroll-behavior:contain}
@media(max-width:800px){.ia-outline{max-height:none;overflow:visible}}
`;

const App = defineComponent({
  setup() {
    const code = securityCodeFromUrl();
    const operating = ref<OperatingAnalysis | null>(null);
    const loading = ref(true);
    const operatingError = ref<string | null>(null);
    const elapsedNow = ref(Date.now());
    const selectedReasoningEffort = ref<ReasoningEffort>("high");
    let pollTimer: number | null = null;
    let elapsedTimer: number | null = null;

    const load = async () => {
      try {
        operating.value = await request<OperatingAnalysis>(`/api/research/company/${encodeURIComponent(code)}/operating-analysis`);
        operatingError.value = null;
      } catch (reason) { operatingError.value = reason instanceof Error ? reason.message : String(reason); }
      loading.value = false;
    };
    const refreshOperatingAnalysis = async () => {
      operatingError.value = null;
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/operating-analysis/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true, reasoningEffort: selectedReasoningEffort.value }) });
        await load();
      } catch (reason) { operatingError.value = reason instanceof Error ? reason.message : String(reason); }
    };
    onMounted(() => {
      void load();
      elapsedTimer = window.setInterval(() => { elapsedNow.value = Date.now(); }, 1_000);
      pollTimer = window.setInterval(() => {
        if (isRunning(operating.value?.job)) void load();
      }, 5_000);
    });
    onUnmounted(() => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
    });

    return () => {
      const markdown = isRunning(operating.value?.job) && text(operating.value?.job?.partialReportMarkdown)
        ? text(operating.value?.job?.partialReportMarkdown)
        : text(operating.value?.run?.reportMarkdown) || text(operating.value?.job?.partialReportMarkdown);
      return h("main", { class: "ia" }, [
        h("style", styles),
        h("div", { class: "container ia-shell" }, [
          loading.value ? h("section", { class: "ia-report" }, "正在读取已保存的研究报告…") : h("div", { class: markdown ? "ia-document" : "ia-document ia-document-empty" }, [
            markdown ? h("nav", { class: "ia-outline", "aria-label": "报告目录" }, [
            h("h2", "报告目录"),
              ...documentOutline(markdown).map((item) => h("button", { class: `l${item.level}`, onClick: () => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, item.text)),
            ]) : null,
            reportCard({ title: "完整投资研究", description: "一次提问完成经营、产业、定价与反证；模型通过本地 llm-client 调用，生成期间持续保存思考摘要与正文。页面加载不会触发生成。", report: operating.value?.run, job: operating.value?.job, requestError: operatingError.value, emptyMessage: `尚无 ${code} 的研究报告。点击生成后，本地模型会启用 Web Search 完成完整投资研究。`, now: elapsedNow.value, reasoningEffort: selectedReasoningEffort.value, onReasoningEffortChange: (value) => { selectedReasoningEffort.value = value; }, buttonLabel: operating.value?.run ? "重新生成报告" : "生成完整研究", onRefresh: () => { void refreshOperatingAnalysis(); } }),
          ]),
        ]),
      ]);
    };
  },
});

const root = document.getElementById("investment-analysis-vue-root");
if (root) createApp(App).mount(root);
