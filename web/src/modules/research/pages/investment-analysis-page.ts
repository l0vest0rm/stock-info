import { createApp, defineComponent, h, onMounted, onUnmounted, ref, type VNodeChild } from "vue";

const DEFAULT_CODE = "300308.SZ";
const REQUEST_TIMEOUT_MS = 12_000;
type Json = Record<string, unknown>;
type ReportRun = { runId?: string; promptVersion?: string; reportMarkdown?: string; provider?: string; generatedAt?: number; input?: Json | null };
type ReportJob = { status?: "queued" | "running" | "completed" | "failed"; lastError?: string | null; startedAt?: number; updatedAt?: number; attemptCount?: number };
type OperatingAnalysis = { availability?: "available" | "empty" | "unavailable"; run?: ReportRun | null; job?: ReportJob | null };

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
function date(value: unknown): string {
  if (!value) return "—";
  const parsed = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("zh-CN", { hour12: false });
}
function isRunning(job: ReportJob | null | undefined): boolean { return job?.status === "queued" || job?.status === "running"; }

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

/** Renders the WebQA response as VNodes only. Model output is never injected as HTML. */
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
  buttonLabel?: string;
  onRefresh?: () => void;
  disabled?: boolean;
}): VNodeChild {
  const running = isRunning(options.job);
  const markdown = text(options.report?.reportMarkdown);
  const sessionUrl = httpsUrl(asRecord(asRecord(options.report?.input).webqaSession).sessionUrl);
  // A polling transport error only means the local Worker is temporarily
  // unreachable. It must never overwrite an already-persisted queued/running
  // job with a false "generation failed" state.
  const failure = options.job?.status === "failed" ? text(options.job.lastError) : (!running ? options.requestError : null);
  return h("section", { class: "ia-report" }, [
    h("div", { class: "ia-report-head" }, [
      h("div", [
        h("h2", options.title),
        h("p", options.description),
        markdown ? h("div", { class: "ia-meta" }, [
          h("span", `生成于 ${date(options.report?.generatedAt)} · ${options.report?.provider || "提供方未记录"} · ${options.report?.promptVersion || "模板未记录"}`),
          sessionUrl ? h("a", { href: sessionUrl, target: "_blank", rel: "noopener noreferrer" }, "打开 ChatGPT 会话") : null,
        ]) : null,
      ]),
      options.onRefresh && options.buttonLabel ? h("button", { class: "ia-refresh", disabled: Boolean(options.disabled || running), onClick: options.onRefresh }, running ? (options.job?.status === "queued" ? "已排队…" : "正在生成…") : options.buttonLabel) : null,
    ]),
    markdown ? h("article", { class: "ia-markdown" }, renderMarkdown(markdown))
      : h("div", { class: failure ? "ia-message error" : "ia-message" }, failure ? [h("strong", "生成失败"), h("span", failure)] : running ? ["任务仍在运行；结果会在完成后自动显示。可以离开或刷新页面，报告会从已保存的结果恢复。", options.requestError ? h("span", { class: "ia-connection-warning" }, `本地 Worker 暂时无法连接（${options.requestError}）；这不代表 WebQA 已失败。恢复本地服务后会继续读取任务状态。`) : null] : options.emptyMessage),
  ]);
}

const styles = `
.ia{--ink:#183a37;--muted:#637c78;--line:#d8e8e4;--paper:#fff;--ground:#f4f8f7;--teal:#08786c;--deep:#075d57;min-height:calc(100vh - 7rem);padding:26px 0 56px;background:var(--ground);color:var(--ink)}.ia *{box-sizing:border-box}.ia-shell{max-width:1180px}.ia-hero{padding:28px;border-radius:20px;background:linear-gradient(125deg,#143c47,#08786c);color:#fff;box-shadow:0 16px 38px #143d3926}.ia-kicker{font-size:11px;font-weight:850;letter-spacing:.12em;color:#c0e8df}.ia-hero h1{margin:9px 0 7px;font-size:30px;letter-spacing:-.025em}.ia-hero p{max-width:760px;margin:0;color:#d2ebe5;font-size:14px;line-height:1.65}.ia-document{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}.ia-outline{position:sticky;top:16px;padding:16px 13px;border:1px solid var(--line);border-radius:15px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-outline h2{margin:0 0 9px;padding:0;border:0;color:#315b55;font-size:13px}.ia-outline button{display:block;width:100%;border:0;border-radius:6px;background:transparent;padding:6px 7px;color:#476762;font:600 12px/1.45 inherit;text-align:left;cursor:pointer}.ia-outline button:hover{background:#edf8f4;color:var(--deep)}.ia-outline .l1{font-weight:850;color:#1c4d46}.ia-outline .l2{padding-left:16px}.ia-outline .l3{padding-left:27px}.ia-outline .l4{padding-left:38px}.ia-report{padding:23px 25px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-report-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.ia-report h2{margin:0;font-size:20px;letter-spacing:-.01em}.ia-report-head p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.ia-refresh{flex:none;border:1px solid #b6dcd3;border-radius:9px;background:#fff;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}.ia-refresh:disabled{opacity:.58;cursor:wait}.ia-message{margin-top:17px;border:1px dashed #c7dad5;border-radius:12px;padding:15px;color:#58716d;font-size:13px;line-height:1.65}.ia-message.error{border-style:solid;border-color:#edc8c2;background:#fff5f3;color:#983e34}.ia-message strong,.ia-message span{display:block}.ia-message span{margin-top:5px}.ia-connection-warning{color:#9c6500}.ia-meta{display:flex;flex-wrap:wrap;gap:5px 10px;margin-top:9px;color:#738783;font-size:11px;line-height:1.5}.ia-meta a{color:var(--teal);font-weight:750;text-decoration:underline;text-underline-offset:2px}.ia-markdown{margin-top:22px;color:#203d39;font-size:15px;line-height:1.8}.ia-markdown h1,.ia-markdown h2{scroll-margin-top:18px;margin:31px 0 11px;padding-top:21px;border-top:1px solid #dceae6;color:var(--deep);font-size:22px}.ia-markdown h1:first-child,.ia-markdown h2:first-child{margin-top:0;padding-top:0;border-top:0}.ia-markdown h3{scroll-margin-top:18px;margin:22px 0 8px;color:#174b45;font-size:17px}.ia-markdown h4{scroll-margin-top:18px;margin:17px 0 7px;color:#285852;font-size:15px}.ia-markdown p{margin:11px 0}.ia-markdown ul,.ia-markdown ol{margin:10px 0;padding-left:24px}.ia-markdown li{margin:5px 0}.ia-markdown blockquote{margin:14px 0;padding:10px 15px;border-left:3px solid #8bc8bb;background:#f1faf7;color:#315951}.ia-markdown strong{font-weight:800;color:#123f3a}.ia-markdown code{padding:1px 4px;border-radius:4px;background:#eaf4f1;color:#08645a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}.ia-markdown a{color:var(--teal);text-decoration:underline;text-underline-offset:2px}.ia-table-wrap{overflow-x:auto;margin:14px 0}.ia-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.55}.ia-table th,.ia-table td{border:1px solid #dce9e6;padding:8px 9px;text-align:left;vertical-align:top}.ia-table th{background:#eff8f5;color:#305b55;font-weight:850}@media(max-width:800px){.ia-document{display:block}.ia-outline{position:static;margin-bottom:16px}.ia-outline button{display:inline-block;width:auto;margin-right:3px}.ia-outline .l2,.ia-outline .l3,.ia-outline .l4{padding-left:7px}}@media(max-width:650px){.ia{padding:13px 0 34px}.ia-hero,.ia-report{padding:18px;border-radius:15px}.ia-hero h1{font-size:25px}.ia-report-head{flex-direction:column}.ia-markdown{font-size:14px}.ia-markdown h1,.ia-markdown h2{font-size:20px}}
`;

const App = defineComponent({
  setup() {
    const code = securityCodeFromUrl();
    const operating = ref<OperatingAnalysis | null>(null);
    const loading = ref(true);
    const operatingError = ref<string | null>(null);
    let timer: number | null = null;

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
        await request(`/api/research/company/${encodeURIComponent(code)}/operating-analysis/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) });
        await load();
      } catch (reason) { operatingError.value = reason instanceof Error ? reason.message : String(reason); }
    };
    onMounted(() => {
      void load();
      timer = window.setInterval(() => {
        if (isRunning(operating.value?.job)) void load();
      }, 5_000);
    });
    onUnmounted(() => { if (timer !== null) window.clearInterval(timer); });

    return () => {
      const markdown = text(operating.value?.run?.reportMarkdown);
      return h("main", { class: "ia" }, [
        h("style", styles),
        h("div", { class: "container ia-shell" }, [
          loading.value ? h("section", { class: "ia-report" }, "正在读取已保存的研究报告…") : h("div", { class: markdown ? "ia-document" : "ia-document ia-document-empty" }, [
            markdown ? h("nav", { class: "ia-outline", "aria-label": "报告目录" }, [
            h("h2", "报告目录"),
              ...documentOutline(markdown).map((item) => h("button", { class: `l${item.level}`, onClick: () => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, item.text)),
            ]) : null,
            reportCard({ title: "完整投资研究", description: "一次提问完成经营、产业、定价与反证；模型在本次任务内复核结论后输出一份可定位的完整报告。页面加载不会触发生成。", report: operating.value?.run, job: operating.value?.job, requestError: operatingError.value, emptyMessage: `尚无 ${code} 的研究报告。点击生成后，本地 WebQA 将一次完成完整投资研究。`, buttonLabel: operating.value?.run ? "重新生成报告" : "生成完整研究", onRefresh: () => { void refreshOperatingAnalysis(); } }),
          ]),
        ]),
      ]);
    };
  },
});

const root = document.getElementById("investment-analysis-vue-root");
if (root) createApp(App).mount(root);
