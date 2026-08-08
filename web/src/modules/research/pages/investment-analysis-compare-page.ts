import { createApp, defineComponent, h, onMounted, ref, type VNodeChild } from "vue";

const DEFAULT_CODE = "300308.SZ";
const REQUEST_TIMEOUT_MS = 12_000;
type ReportVersion = { runId?: string; promptVersion?: string; generatedAt?: number; provider?: string; totalDurationMs?: number | null };
type ReportRun = ReportVersion & { reportMarkdown?: string };
type OperatingAnalysis = { run?: ReportRun | null; versions?: ReportVersion[] };
type DiffPart = { left?: { text: string; changed: boolean }; right?: { text: string; changed: boolean } };

function securityCodeFromUrl(): string {
  const code = new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || DEFAULT_CODE;
  return /^[A-Z0-9]{1,12}\.(SH|SZ|HK|US)$/.test(code) ? code : DEFAULT_CODE;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function date(value: unknown): string {
  const parsed = new Date(typeof value === "number" ? value : String(value || ""));
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("zh-CN", { hour12: false });
}
function versionLabel(versions: ReportVersion[], runId: string): string {
  const index = versions.findIndex((item) => item.runId === runId);
  const version = index >= 0 ? text(versions[index].promptVersion) : "";
  const semanticVersion = /(?:^|\.)(v\d+(?:\.\d+)*)$/i.exec(version)?.[1] || version || "未记录版本";
  return `${semanticVersion} · ${date(versions[index]?.generatedAt)}`;
}
async function request<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { signal: controller.signal });
    const payload = await response.json().catch(() => null) as { code?: number; msg?: string; data?: T } | null;
    if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || `请求失败：${response.status}`);
    return payload.data as T;
  } finally { window.clearTimeout(timeout); }
}

/** A line-level LCS keeps Markdown intact while marking only inserted/deleted text. */
function buildDiff(leftMarkdown: string, rightMarkdown: string): DiffPart[] {
  const left = leftMarkdown.replace(/\r\n?/g, "\n").split("\n");
  const right = rightMarkdown.replace(/\r\n?/g, "\n").split("\n");
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) {
    table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const result: DiffPart[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flushChanged = () => {
    const length = Math.max(removed.length, added.length);
    for (let index = 0; index < length; index += 1) result.push({
      ...(removed[index] !== undefined ? { left: { text: removed[index], changed: true } } : {}),
      ...(added[index] !== undefined ? { right: { text: added[index], changed: true } } : {}),
    });
    removed = []; added = [];
  };
  for (let i = 0, j = 0; i < left.length || j < right.length;) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      flushChanged();
      result.push({ left: { text: left[i++], changed: false }, right: { text: right[j++], changed: false } });
    } else if (i < left.length && (j === right.length || table[i + 1][j] >= table[i][j + 1])) removed.push(left[i++]);
    else if (j < right.length) added.push(right[j++]);
  }
  flushChanged();
  return result;
}

const styles = `
.iac{--ink:#183a37;--line:#d8e8e4;--paper:#fff;--ground:#f4f8f7;--teal:#08786c;min-height:calc(100vh - 7rem);padding:26px 0 56px;background:var(--ground);color:var(--ink)}.iac *{box-sizing:border-box}.iac-shell{max-width:1440px}.iac-card{padding:22px 24px;border:1px solid var(--line);border-radius:17px;background:var(--paper);box-shadow:0 5px 16px #123e360d}.iac h1{margin:0;font-size:24px}.iac p{margin:7px 0 0;color:#637c78;font-size:13px;line-height:1.65}.iac-controls{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:20px}.iac-controls label{display:grid;gap:5px;color:#476762;font-size:11px;font-weight:800}.iac-controls select{width:100%;border:1px solid #b6dcd3;border-radius:8px;background:#fff;padding:9px;color:#174b45;font:600 12px inherit}.iac-message{margin-top:18px;padding:14px;border:1px dashed #c7dad5;border-radius:10px;color:#58716d;font-size:13px}.iac-message.error{border-color:#edc8c2;background:#fff5f3;color:#983e34}.iac-diff{display:grid;grid-template-columns:1fr 1fr;margin-top:18px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fff}.iac-column{min-width:0}.iac-column+.iac-column{border-left:1px solid var(--line)}.iac-column-head{position:sticky;top:0;padding:11px 13px;border-bottom:1px solid var(--line);background:#f1faf7;color:#285852;font:800 12px/1.5 inherit}.iac-line{min-height:24px;padding:3px 10px;border-bottom:1px solid #edf4f2;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.iac-line.removed{background:#fff0ee;color:#8e3e36}.iac-line.added{background:#ecfbf3;color:#176443}.iac-legend{display:flex;gap:13px;margin-top:14px;color:#637c78;font-size:12px}.iac-legend span{display:flex;align-items:center;gap:5px}.iac-dot{width:10px;height:10px;border-radius:2px}.iac-dot.add{background:#bfecca}.iac-dot.remove{background:#ffd2cb}@media(max-width:700px){.iac{padding:13px 0 34px}.iac-card{padding:17px}.iac-controls{grid-template-columns:1fr}.iac-diff{min-width:720px}.iac-scroll{overflow:auto}.iac h1{font-size:21px}}
`;

const App = defineComponent({
  setup() {
    const code = securityCodeFromUrl();
    const versions = ref<ReportVersion[]>([]);
    const leftRunId = ref("");
    const rightRunId = ref("");
    const left = ref<ReportRun | null>(null);
    const right = ref<ReportRun | null>(null);
    const error = ref<string | null>(null);
    const loading = ref(true);
    const loadRuns = async () => {
      error.value = null;
      try {
        const current = await request<OperatingAnalysis>(`/api/research/company/${encodeURIComponent(code)}/operating-analysis`);
        versions.value = current.versions || [];
        const query = new URLSearchParams(window.location.search);
        const requestedLeft = query.get("left") || "";
        const requestedRight = query.get("right") || "";
        const hasVersion = (id: string) => versions.value.some((item) => item.runId === id);
        rightRunId.value = hasVersion(requestedRight) ? requestedRight : versions.value[0]?.runId || "";
        leftRunId.value = hasVersion(requestedLeft) && requestedLeft !== rightRunId.value ? requestedLeft : versions.value.find((item) => item.runId !== rightRunId.value)?.runId || "";
        await loadSelectedRuns();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };
    const loadSelectedRuns = async () => {
      if (!leftRunId.value || !rightRunId.value || leftRunId.value === rightRunId.value) { left.value = null; right.value = null; return; }
      try {
        const [nextLeft, nextRight] = await Promise.all([
          request<ReportRun>(`/api/research/company/${encodeURIComponent(code)}/operating-analysis/runs/${encodeURIComponent(leftRunId.value)}`),
          request<ReportRun>(`/api/research/company/${encodeURIComponent(code)}/operating-analysis/runs/${encodeURIComponent(rightRunId.value)}`),
        ]);
        left.value = nextLeft; right.value = nextRight;
        const query = new URLSearchParams({ code, left: leftRunId.value, right: rightRunId.value });
        window.history.replaceState(null, "", `investment-analysis-compare.html?${query.toString()}`);
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
    };
    onMounted(() => { void loadRuns(); });
    return () => {
      const diff = left.value && right.value ? buildDiff(text(left.value.reportMarkdown), text(right.value.reportMarkdown)) : [];
      return h("main", { class: "iac" }, [h("style", styles), h("div", { class: "container iac-shell" }, [
        h("section", { class: "iac-card" }, [
          h("h1", `${code} 投资分析版本比较`),
          h("p", "并排比较两次已完成的模型输出；红色为左侧版本删除或改写的行，绿色为右侧版本新增或改写的行。"),
          h("div", { class: "iac-controls" }, [
            h("label", ["较早版本", h("select", { value: leftRunId.value, onChange: (event: Event) => { leftRunId.value = (event.target as HTMLSelectElement).value; void loadSelectedRuns(); } }, versions.value.map((item) => h("option", { value: item.runId }, versionLabel(versions.value, item.runId || "")) ))]),
            h("label", ["较新版本", h("select", { value: rightRunId.value, onChange: (event: Event) => { rightRunId.value = (event.target as HTMLSelectElement).value; void loadSelectedRuns(); } }, versions.value.map((item) => h("option", { value: item.runId }, versionLabel(versions.value, item.runId || "")) ))]),
          ]),
          h("div", { class: "iac-legend" }, [h("span", [h("i", { class: "iac-dot remove" }), "左侧删除/改写"]), h("span", [h("i", { class: "iac-dot add" }), "右侧新增/改写"])]),
        ]),
        loading.value ? h("div", { class: "iac-message" }, "正在读取可比较的报告版本…") : error.value ? h("div", { class: "iac-message error", role: "status" }, error.value) : versions.value.length < 2 ? h("div", { class: "iac-message" }, "至少生成两个已完成版本后，才能进行差异比较。") : leftRunId.value === rightRunId.value ? h("div", { class: "iac-message" }, "请选择两个不同的报告版本。") : h("div", { class: "iac-scroll" }, h("section", { class: "iac-diff", "aria-label": "报告版本差异" }, [
          h("div", { class: "iac-column" }, [h("div", { class: "iac-column-head" }, versionLabel(versions.value, leftRunId.value)), ...diff.map((item, index) => h("div", { class: `iac-line${item.left?.changed ? " removed" : ""}`, key: `l-${index}` }, item.left?.text || ""))]),
          h("div", { class: "iac-column" }, [h("div", { class: "iac-column-head" }, versionLabel(versions.value, rightRunId.value)), ...diff.map((item, index) => h("div", { class: `iac-line${item.right?.changed ? " added" : ""}`, key: `r-${index}` }, item.right?.text || ""))]),
        ])),
      ])]);
    };
  },
});

const root = document.getElementById("investment-analysis-compare-vue-root");
if (root) createApp(App).mount(root);
