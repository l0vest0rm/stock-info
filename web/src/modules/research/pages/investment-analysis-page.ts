import { createApp, defineComponent, h, onMounted, onUnmounted, ref, type VNodeChild } from "vue";

const DEFAULT_CODE = "300308.SZ";
const REQUEST_TIMEOUT_MS = 12_000;
const COMPANY_INFO_MOUNTED_EVENT = "stock-info:company-info-mounted";
type Json = Record<string, unknown>;
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type Task = { name?: string; status?: "queued" | "leased" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "superseded"; errorMessage?: string | null; createdAt?: number; updatedAt?: number; completedAt?: number | null };
type ReportEvidenceItem = { text?: string | null; title?: string | null; url?: string | null };
type Report = { markdown?: string; citations?: ReportEvidenceItem[]; sources?: ReportEvidenceItem[]; terminalMetadata?: Json | null; projectedAt?: number };
type InvestmentAnalysis = { availability?: "available" | "empty" | "pending" | "failed"; task?: Task | null; input?: Json | null; report?: Report | null; resume?: { available?: boolean; reason?: string } | null };
type CompanyOverview = { name?: string; latestPrice?: number | null; pctChange?: number | null; marketCapYi?: number | null };
type KlineBar = { date?: string; close?: number | null };
type IncomeStatement = { parentNetprofit?: number | null };
type ShareChange = { totalShares?: number | null };

const reasoningEffortOptions: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const styles = `
.ia{--ink:#183a37;--muted:#637c78;--line:#d8e8e4;--paper:#fff;--ground:#f4f8f7;--teal:#08786c;--deep:#075d57;min-height:calc(100vh - 7rem);padding:26px 0 56px;background:var(--ground);color:var(--ink)}.ia *{box-sizing:border-box}.ia-shell{max-width:1180px}.ia-hero{padding:28px;border-radius:20px;background:linear-gradient(125deg,#143c47,#08786c);color:#fff;box-shadow:0 16px 38px #143d3926}.ia-kicker{font-size:11px;font-weight:850;letter-spacing:.12em;color:#c0e8df}.ia-hero h1{margin:9px 0 7px;font-size:30px;letter-spacing:-.025em}.ia-hero p{max-width:760px;margin:0;color:#d2ebe5;font-size:14px;line-height:1.65}.ia-document{margin-top:16px}.ia-document.has-outline{display:grid;grid-template-columns:230px minmax(0,1fr);gap:16px;align-items:start}.ia-outline{position:sticky;top:16px;padding:16px 13px;border:1px solid var(--line);border-radius:15px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-outline h2{margin:0 0 9px;padding:0;border:0;color:#315b55;font-size:13px}.ia-outline button{display:block;width:100%;border:0;border-radius:6px;background:transparent;padding:6px 7px;color:#476762;font:600 12px/1.45 inherit;text-align:left;cursor:pointer}.ia-outline button:hover{background:#edf8f4;color:var(--deep)}.ia-report{padding:23px 25px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.ia-report-head{display:flex;align-items:start;justify-content:space-between;gap:16px}.ia-report h2{margin:0;font-size:20px;letter-spacing:-.01em}.ia-report-head p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.6}.ia-controls{display:flex;align-items:end;gap:9px;flex-wrap:wrap;justify-content:flex-end}.ia-controls label{display:grid;gap:4px;color:#476762;font-size:10px;font-weight:800}.ia-controls select{border:1px solid #b6dcd3;border-radius:8px;background:#fff;padding:7px 8px;color:#174b45;font:600 11px inherit}.ia-refresh{flex:none;border:1px solid #b6dcd3;border-radius:9px;background:#fff;color:#076b60;padding:8px 11px;font:800 12px inherit;cursor:pointer}.ia-refresh:disabled{opacity:.58;cursor:wait}.ia-status{display:inline-block;margin-left:8px;border-radius:999px;padding:3px 8px;background:#eff8f5;color:#076b60;font-size:11px}.ia-status.failed{background:#fff0ed;color:#a64032}.ia-meta{display:flex;flex-wrap:wrap;gap:5px 10px;margin-top:9px;color:#738783;font-size:11px;line-height:1.5}.ia-message{margin-top:17px;border:1px dashed #c7dad5;border-radius:12px;padding:15px;color:#58716d;font-size:13px;line-height:1.65}.ia-message.error{border-style:solid;border-color:#edc8c2;background:#fff5f3;color:#983e34}.ia-markdown{margin-top:22px;color:#203d39;font-size:15px;line-height:1.8}.ia-markdown h1{scroll-margin-top:18px;margin:31px 0 11px;padding-top:21px;border-top:1px solid #dceae6;color:var(--deep);font-size:22px}.ia-markdown h1:first-child{margin-top:0;padding-top:0;border-top:0}.ia-markdown h2{margin:22px 0 8px;color:#174b45;font-size:18px}.ia-markdown h3{margin:17px 0 7px;color:#285852;font-size:15px}.ia-markdown p{margin:11px 0;white-space:pre-wrap}.ia-markdown a{color:var(--teal);text-decoration:underline;text-underline-offset:2px}.ia-evidence{margin-top:16px;border-top:1px solid #dceae6;padding-top:12px;color:#58716d;font-size:12px}.ia-evidence ul{margin:7px 0;padding-left:20px}.ia-prompt{margin-top:17px;border:1px solid #d5e7e2;border-radius:12px;background:#fff;padding:12px 15px}.ia-prompt summary{cursor:pointer;color:#174b45;font-size:13px;font-weight:800}.ia-prompt pre{max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:800px){.ia-document.has-outline{display:block}.ia-outline{position:static;margin-bottom:16px}.ia-outline button{display:inline-block;width:auto;margin-right:3px}}@media(max-width:650px){.ia{padding:13px 0 34px}.ia-hero,.ia-report{padding:18px;border-radius:15px}.ia-hero h1{font-size:25px}.ia-report-head{display:block}.ia-controls{justify-content:flex-start;margin-top:15px}.ia-markdown{font-size:14px}}
`;

function securityCodeFromUrl(): string {
  const code = new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || DEFAULT_CODE;
  return /^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/.test(code) ? code : DEFAULT_CODE;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function finiteNumber(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? number : null; }
function formatMarketNumber(value: unknown): string { const number = finiteNumber(value); return number === null ? "暂无数据" : number.toFixed(2); }
function formatPercentage(value: unknown): string { const number = finiteNumber(value); return number === null ? "暂无数据" : `${number.toFixed(2)}%`; }
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
function date(value: unknown): string { const parsed = new Date(Number(value)); return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("zh-CN", { hour12: false }); }
function isPending(task: Task | null | undefined): boolean { return task?.status === "queued" || task?.status === "leased" || task?.status === "running" || task?.status === "cancel_requested"; }
function taskStatus(task: Task | null | undefined): string {
  return ({ queued: "已排队", leased: "执行器已领取", running: "正在生成", cancel_requested: "正在取消", succeeded: "已完成", failed: "失败", cancelled: "已取消", superseded: "已替代" } as Record<string, string>)[task?.status || ""] || "尚未提交";
}
function reportQualityIssues(markdown: string): string[] {
  const issues: string[] = [];
  if (markdown.length < 800) issues.push("正文少于 800 字");
  const headings = new Set([...markdown.matchAll(/^# ([1-9]|1[0-2])\. /gm)].map((match) => match[1]));
  if (headings.size !== 12) issues.push("缺少完整的 12 个一级章节");
  return issues;
}
function outline(markdown: string): Array<{ id: string; text: string }> {
  return [...markdown.matchAll(/^# (.+)$/gm)].map((match, index) => ({ id: `ia-heading-${index + 1}`, text: match[1] }));
}
function renderMarkdown(markdown: string): VNodeChild[] {
  let heading = 0;
  return markdown.split(/\n{2,}/).filter(Boolean).map((block) => {
    const h1 = block.match(/^# (.+)$/);
    if (h1) { heading += 1; return h("h1", { id: `ia-heading-${heading}` }, h1[1]); }
    const h2 = block.match(/^## (.+)$/);
    if (h2) return h("h2", h2[1]);
    const h3 = block.match(/^### (.+)$/);
    if (h3) return h("h3", h3[1]);
    return h("p", block);
  });
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `请求失败：${response.status}`);
    return body.data as T;
  } finally { window.clearTimeout(timer); }
}

const App = defineComponent({
  setup() {
    const code = securityCodeFromUrl();
    const model = ref<InvestmentAnalysis | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const reasoningEffort = ref<ReasoningEffort>("xhigh");
    let pollTimer: number | null = null;
    let companyInfoRequested = false;
    const load = async () => {
      try {
        model.value = await request<InvestmentAnalysis>(`/api/research/company/${encodeURIComponent(code)}/investment-analysis`);
        error.value = null;
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };
    const refresh = async () => {
      error.value = null;
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/investment-analysis/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reasoningEffort: reasoningEffort.value }) });
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
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
          const pe = legacyInfoBarPe(latestPrice, incomeRows, shareChanges);
          setInfoBarValue("stockValuation", pe === null ? "PE: 暂无数据" : `PE(TTM): ${pe.toFixed(2)}`);
        } catch (reason) {
          setInfoBarValue("stockValuation", "PE: 暂无数据");
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
      pollTimer = window.setInterval(() => { if (isPending(model.value?.task)) void load(); }, 5_000);
    });
    onUnmounted(() => {
      window.removeEventListener(COMPANY_INFO_MOUNTED_EVENT, requestCompanyInfo);
      if (pollTimer !== null) window.clearInterval(pollTimer);
    });
    return () => {
      const task = model.value?.task || null;
      const report = model.value?.report || null;
      const markdown = text(report?.markdown);
      const issues = markdown ? reportQualityIssues(markdown) : [];
      const evidence = [...(report?.citations || []), ...(report?.sources || [])].filter((item) => text(item.url));
      const pending = isPending(task);
      const promptInput = model.value?.input ? JSON.stringify(model.value.input, null, 2) : "";
      return h("main", { class: "ia" }, [
        h("style", styles),
        h("div", { class: "container ia-shell" }, [
          h("section", { class: "ia-hero" }, [h("div", { class: "ia-kicker" }, "TASKD · CHATGPT"), h("h1", "完整投资研究"), h("p", "stock-info 先工程化获取并冻结证券和财务必要输入，再提交一份 ChatGPT 投资分析任务给 taskd。页面只按业务 name 读取最终状态和已校验的报告。")]),
          loading.value ? h("section", { class: "ia-report", style: "margin-top:16px" }, "正在读取任务状态…") : h("div", { class: `ia-document${markdown ? " has-outline" : ""}` }, [
            markdown ? h("nav", { class: "ia-outline", "aria-label": "报告目录" }, [h("h2", "报告目录"), ...outline(markdown).map((item) => h("button", { onClick: () => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, item.text))]) : null,
            h("section", { class: "ia-report" }, [
              h("div", { class: "ia-report-head" }, [
                h("div", [h("h2", ["完整投资研究", h("span", { class: `ia-status ${task?.status === "failed" ? "failed" : ""}` }, taskStatus(task))]), h("p", "一份任务完成公司、行业、竞争、风险与估值分析；刷新会以相同业务 name 提交新任务，taskd 自动替代尚未完成的旧任务。"), task ? h("div", { class: "ia-meta" }, [h("span", `任务名：${task.name || "—"}`), h("span", `创建：${date(task.createdAt)}`), task.completedAt ? h("span", `完成：${date(task.completedAt)}`) : null]) : null]),
                h("div", { class: "ia-controls" }, [h("label", [h("span", "推理深度"), h("select", { value: reasoningEffort.value, disabled: pending, onChange: (event: Event) => { reasoningEffort.value = (event.target as HTMLSelectElement).value as ReasoningEffort; } }, reasoningEffortOptions.map((value) => h("option", { value }, value)))]), h("button", { class: "ia-refresh", disabled: pending, onClick: () => { void refresh(); } }, pending ? taskStatus(task) : markdown ? "重新生成报告" : "生成完整研究")]),
              ]),
              error.value ? h("div", { class: "ia-message error", role: "alert" }, error.value) : null,
              task?.status === "failed" ? h("div", { class: "ia-message error", role: "status" }, task.errorMessage || "taskd 任务执行失败；可重新生成。") : null,
              pending ? h("div", { class: "ia-message", role: "status" }, "任务已提交给 taskd；页面每 5 秒按业务 name 查询状态，报告完成并通过质量校验后显示。") : null,
              issues.length ? h("div", { class: "ia-message error", role: "alert" }, `已拒绝不符合报告契约的结果：${issues.join("；")}`) : null,
              promptInput ? h("details", { class: "ia-prompt" }, [h("summary", "查看工程冻结输入"), h("pre", promptInput)]) : null,
              markdown ? h("article", { class: "ia-markdown" }, renderMarkdown(markdown)) : !pending && !error.value ? h("div", { class: "ia-message" }, `尚无 ${code} 的投资研究报告。点击“生成完整研究”后提交 ChatGPT 任务。`) : null,
              evidence.length ? h("section", { class: "ia-evidence" }, [
                h("strong", "模型返回的参考来源"),
                h("ul", evidence.slice(0, 80).map((item) => h("li", [
                  h("a", { href: text(item.url), target: "_blank", rel: "noopener noreferrer" }, text(item.title) || text(item.url)),
                ]))),
              ]) : null,
            ]),
          ]),
        ]),
      ]);
    };
  },
});

const root = document.getElementById("investment-analysis-vue-root");
if (root) createApp(App).mount(root);
