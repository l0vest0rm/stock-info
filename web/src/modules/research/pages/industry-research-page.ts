import { createApp, defineComponent, h, onMounted, ref } from "vue";

type Snapshot = { state: string; asOf: number; createdAt: number; ruleVersion: string };
type Impact = { impactId?: string; direction: string; transmission: string; confidence: number };
type MacroEvent = { eventId?: string; title?: string; scheduledAt?: number; importance?: string; sourceUrl?: string };
type Payload = { industry: string; generatedAt: number; snapshot?: Snapshot | null; assessment: { state: string; summary: string; nextSteps: string[] }; evidence: Array<{ evidenceId: string; title: string; url: string; publishedAt: number; sourceId: string; grade: string; eventStatus: string }>; impacts: Impact[]; sources: Array<{ sourceId: string; name: string; state: string; lastSuccessAt: number | null; lastError: string | null }>; upcomingMacroEvents?: MacroEvent[] };
const style = `.industry-research{background:#f4f7f8;min-height:calc(100vh - 8rem);padding:1.25rem 0 2.5rem}.industry-card{background:#fff;border:1px solid #dbe7e5;border-radius:1rem;box-shadow:0 .5rem 1.3rem rgba(15,52,51,.05);padding:1rem}.industry-hero{background:linear-gradient(135deg,#112f43,#0f766e);color:#fff}.industry-hero h1{margin:.35rem 0}.industry-meta{color:#64748b;font-size:.84rem}.industry-badge{background:#e2e8f0;border-radius:99px;color:#334155;display:inline-block;font-size:.8rem;font-weight:700;padding:.25rem .6rem}.industry-list{padding-left:1.1rem}.industry-table{font-size:.88rem}.industry-table td,.industry-table th{vertical-align:top}.industry-impact{border-left:4px solid #94a3b8;border-radius:.6rem;background:#f8fafc;padding:.7rem}.industry-impact.support{border-color:#0f766e}.industry-impact.pressure{border-color:#dc2626}.industry-impact.mixed{border-color:#d97706}.industry-event{border-top:1px solid #e2e8f0;padding:.65rem 0}.industry-event:first-child{border-top:0;padding-top:0}`;
function selectedIndustry() { return new URLSearchParams(location.search).get("industry")?.trim() || ""; }
function displayDate(value: number) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
function impactText(value: string) { return ({ support: "支持", pressure: "压力", mixed: "待分辨" } as Record<string, string>)[value] ?? value; }
const App = defineComponent({ setup() { const industry = ref(selectedIndustry()); const data = ref<Payload | null>(null); const loading = ref(false); const error = ref(""); const load = async () => { if (!industry.value.trim()) { error.value = "输入行业名称后读取现有可审计档案。"; return; } loading.value = true; error.value = ""; try { const r = await fetch(`/api/research/industry?industry=${encodeURIComponent(industry.value.trim())}`); const b = await r.json().catch(() => null); if (!r.ok || b?.code !== 200) throw new Error(b?.msg || `读取失败（${r.status}）`); data.value = b.data; } catch (e) { error.value = e instanceof Error ? e.message : String(e); } finally { loading.value = false; } }; onMounted(() => { if (industry.value) void load(); }); return () => h("main", { class: "industry-research" }, [h("style", style), h("div", { class: "container", style: "max-width:1200px" }, [h("section", { class: "industry-card industry-hero" }, [h("div", { class: "small opacity-75" }, "AUDITABLE INDUSTRY DOSSIER"), h("h1", "行业研究档案"), h("p", { class: "mb-3 opacity-75" }, "只展示已入库的事实、传导线索、冲突、来源健康和待验证任务；不会将行业叙事自动变成任何公司的结论或交易指令。"), h("div", { class: "d-flex gap-2" }, [h("input", { class: "form-control", value: industry.value, placeholder: "例如：通信设备", onInput: (e: Event) => { industry.value = (e.target as HTMLInputElement).value; }, onKeyup: (e: KeyboardEvent) => { if (e.key === "Enter") void load(); } }), h("button", { class: "btn btn-light", onClick: () => void load() }, "读取")])]), loading.value ? h("div", { class: "industry-card mt-3 text-center text-muted" }, "读取中…") : error.value ? h("div", { class: "industry-card mt-3 text-danger" }, error.value) : data.value ? view(data.value) : h("div", { class: "industry-card mt-3 text-muted" }, "输入行业名称，查看当前可审计档案。")])]); } });
function view(data: Payload) {
  const support = data.impacts.filter((item) => item.direction === "support").length;
  const pressure = data.impacts.filter((item) => item.direction === "pressure").length;
  const evidenceRows = data.evidence.map((item) => h("tr", { key: item.evidenceId }, [
    h("td", [h("a", { href: item.url, target: "_blank", rel: "noreferrer" }, item.title)]),
    h("td", `${item.grade} / ${item.eventStatus}`), h("td", `${item.sourceId} · ${displayDate(item.publishedAt)}`),
  ]));
  const evidence = evidenceRows.length ? h("div", { class: "table-responsive" }, h("table", { class: "table table-sm industry-table" }, [h("thead", h("tr", [h("th", "证据"), h("th", "等级"), h("th", "来源")])), h("tbody", evidenceRows)])) : h("p", { class: "text-muted small" }, "暂无精确关联证据。");
  const dossier = h("section", { class: "industry-card h-100" }, [
    h("div", { class: "d-flex justify-content-between" }, [h("h2", data.industry), h("span", { class: "industry-badge" }, data.assessment.state)]),
    h("p", data.assessment.summary), h("div", { class: "row small" }, [h("div", { class: "col-6" }, `支持影响 ${support} 条`), h("div", { class: "col-6" }, `压力影响 ${pressure} 条`)]),
    h("div", { class: "industry-meta mt-2" }, data.snapshot ? `最近快照：${data.snapshot.state} · 截止 ${displayDate(data.snapshot.asOf)} · 规则 ${data.snapshot.ruleVersion}` : "尚无冻结的行业研究快照；当前结果不能替代历史复盘。"), h("hr"), h("h3", { class: "h6" }, "原始证据"), evidence,
  ]);
  const sources = h("section", { class: "industry-card h-100" }, [
    h("h2", "待验证与来源健康"), h("ul", { class: "industry-list small" }, data.assessment.nextSteps.map((item) => h("li", item))), h("hr"),
    ...data.sources.map((item) => h("div", { class: "mb-2 small", key: item.sourceId }, [h("strong", item.name), h("div", { class: "industry-meta" }, `${item.state} · 最近成功 ${item.lastSuccessAt ? displayDate(item.lastSuccessAt) : "待补"}${item.lastError ? ` · ${item.lastError}` : ""}`)])),
  ]);
  const impacts = h("section", { class: "industry-card mt-3" }, [
    h("h2", "行业事件的传导线索"),
    h("p", { class: "industry-meta" }, "传导线索仅说明待核验的影响路径。没有公司级暴露映射、期间和原始证据时，不会外推到个股。"),
    data.impacts.length
      ? h("div", { class: "row g-2" }, data.impacts.map((item, index) => h("div", { class: "col-md-6", key: item.impactId ?? index }, [
        h("article", { class: `industry-impact ${item.direction}` }, [
          h("div", { class: "d-flex justify-content-between gap-2" }, [
            h("strong", impactText(item.direction)),
            h("span", { class: "industry-badge" }, `当前置信度 ${(Math.max(0, Math.min(1, item.confidence)) * 100).toFixed(0)}%`),
          ]),
          h("p", { class: "small mb-0 mt-2" }, item.transmission || "未记录可复核的传导路径。"),
        ]),
      ])))
      : h("div", { class: "text-muted small" }, "尚无已记录的行业影响线索。"),
  ]);
  const events = data.upcomingMacroEvents?.length ? h("section", { class: "industry-card mt-3" }, [h("h2", "待观察的宏观日历"), h("p", { class: "industry-meta" }, "仅列出接口返回的未来事件；事件本身不构成行业或公司催化判断。"), ...data.upcomingMacroEvents.map((item, index) => h("article", { class: "industry-event", key: item.eventId ?? index }, [h("div", { class: "d-flex justify-content-between gap-2" }, [h("strong", item.title ?? "未命名事件"), h("span", { class: "industry-badge" }, item.importance ?? "待分级")]), h("div", { class: "industry-meta mt-1" }, item.scheduledAt ? displayDate(item.scheduledAt) : "时间待确认"), item.sourceUrl ? h("a", { class: "small", href: item.sourceUrl, target: "_blank", rel: "noreferrer" }, "查看原始日历") : null]))]) : null;
  return [h("div", { class: "row g-3 mt-1" }, [h("div", { class: "col-lg-7" }, [dossier]), h("div", { class: "col-lg-5" }, [sources])]), impacts, events];
}
const root = document.getElementById("industry-research-vue-root"); if (root) createApp(App).mount(root);
