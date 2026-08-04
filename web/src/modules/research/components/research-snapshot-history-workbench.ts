import { defineComponent, h, onMounted, ref } from "vue";

type Module = { moduleId: string; availability: string; asOf: number | null; payload: Record<string, unknown> };
type Snapshot = { analysisSnapshotId: string; asOf: number; completionLevel: string; state: string; modules: Module[]; differences: Array<{ moduleId: string; changeType: string; fields: Array<{ path: string }> }> };

const labels: Record<string, string> = {
  "subject-and-market-structure": "研究对象与市场结构",
  "formal-financial-coverage": "正式财务与法定覆盖",
  "operating-model-and-driver-plan": "经营模型、驱动与市场空间",
  "forecast-and-formal-actual": "来源预测、情景与正式实际",
  "valuation-versions": "估值版本与门禁",
  "research-conclusions": "公共命题、风险与处置",
};
const css = `.public-research-snapshots{margin-top:1rem;border-left:4px solid #0f766e}.public-research-snapshot-row{border-top:1px solid #ccfbf1;padding:.72rem 0}.public-research-snapshot-row:first-of-type{border-top:0}.public-research-snapshot-meta{font-size:.8rem;color:#64748b}.public-research-snapshot-module{margin:.45rem 0;padding:.5rem .65rem;border-radius:.35rem;background:#f0fdfa}.public-research-snapshot-module small{color:#475569}.public-research-snapshot-workbench{margin-top:.9rem;border:1px dashed #94bfb8;border-radius:.7rem;padding:.7rem}.public-research-snapshot-workbench>summary{cursor:pointer;color:#0f766e;font-size:.85rem;font-weight:700}.public-research-snapshot-workbench-body{padding-top:.7rem}`;
function date(value: number | null | undefined) { return value && Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "待补"; }
function moduleSummary(module: Module) {
  const root = Array.isArray(module.payload.records) ? module.payload.records[0] as Record<string, unknown> | undefined : undefined;
  if (!root) return "冻结时无可用记录；缺口未被当前数据补写。";
  if (module.moduleId === "subject-and-market-structure") { const s = root.listedSecurity as Record<string, unknown> | undefined; const gate = root.marketStructure as Record<string, unknown> | undefined; return `${s?.code || "证券待补"} · ${s?.market || "市场待补"} · 每股门禁 ${(gate?.perShareValuation as Record<string, unknown> | undefined)?.status || "待补"}`; }
  if (module.moduleId === "formal-financial-coverage") { const c = root.financialCoverage as Record<string, unknown> | undefined; return `财务覆盖 ${c?.status || "待补"}；法定核验与原文索引均冻结为当时版本。`; }
  if (module.moduleId === "operating-model-and-driver-plan") return "经营模型、驱动计划和市场空间只保留版本、状态、来源和阻断边界。";
  if (module.moduleId === "forecast-and-formal-actual") { const f = root.sourceForecasts as unknown[] | undefined; return `已纳入来源预测样本 ${Array.isArray(f) ? f.length : 0} 条；不是市场一致预期。`; }
  if (module.moduleId === "valuation-versions") return "只回放冻结的 DCF、反向 DCF、相对估值版本及其门禁，不含实时价格。";
  return "只含公共命题、风险与已附加的人工处置；不含持仓、计划、用户决定或 LLM 草稿。";
}

export const ResearchSnapshotHistoryWorkbench = defineComponent({
  name: "ResearchSnapshotHistoryWorkbench",
  props: { securityCode: { type: String, required: true }, canWrite: { type: Boolean, default: false } },
  setup(props) {
    const loading = ref(false); const saving = ref(false); const error = ref(""); const notice = ref(""); const snapshots = ref<Snapshot[]>([]); const state = ref("资料待补");
    const load = async () => { loading.value = true; error.value = ""; try { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/public-research-snapshots?limit=24`); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取公共研究快照失败"); snapshots.value = Array.isArray(body.data.items) ? body.data.items : []; } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { loading.value = false; } };
    const save = async () => { saving.value = true; error.value = ""; notice.value = ""; try { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/public-research-snapshots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: state.value, completionLevel: "basic", asOf: Date.now() }) }); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "冻结公共研究快照失败"); notice.value = `已冻结 ${body.data.moduleCount} 个公共模块；新增 ${body.data.differenceIds?.length || 0} 个模块差分。`; await load(); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { saving.value = false; } };
    onMounted(() => { void load(); });
    return () => h("section", { class: "research-card public-research-snapshots", "data-public-research-snapshots": "true" }, [
      h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "公共全研究快照与历史差分"), h("p", { class: "research-meta mb-0" }, "冻结事实、预测、假设、估值版本和公共结论；历史只读取冻结模块，不以今日资料回填。")]), h("button", { class: "btn btn-outline-primary btn-sm", disabled: loading.value, onClick: () => void load() }, loading.value ? "刷新中…" : "刷新历史")]),
      notice.value ? h("div", { class: "alert alert-success py-2 mt-3 mb-0" }, notice.value) : null, error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null,
      !loading.value && !error.value && !snapshots.value.length ? h("p", { class: "research-note mt-3 mb-0" }, "尚无公共全研究快照。风险快照是独立历史，不能代替完整研究回放。") : null,
      snapshots.value.map((snapshot) => h("article", { class: "public-research-snapshot-row" }, [h("strong", `${date(snapshot.asOf)} · ${snapshot.completionLevel} · ${snapshot.state}`), h("div", { class: "public-research-snapshot-meta" }, `快照 ${snapshot.analysisSnapshotId}；相对前一完整研究快照变更 ${snapshot.differences.length} 个模块。`), h("div", { class: "mt-2" }, snapshot.modules.map((module) => h("div", { class: "public-research-snapshot-module" }, [h("strong", `${labels[module.moduleId] || module.moduleId} · ${module.availability}`), h("small", { class: "d-block mt-1" }, `${moduleSummary(module)} 截止：${date(module.asOf)}`)]))), snapshot.differences.length ? h("details", [h("summary", `查看模块差分（${snapshot.differences.length}）`), h("ul", { class: "research-list small mt-2" }, snapshot.differences.map((difference) => h("li", `${labels[difference.moduleId] || difference.moduleId} · ${difference.changeType}：${difference.fields.map((field) => field.path).join("、") || "模块整体变化"}`)))]) : null])),
      props.canWrite ? h("details", { class: "public-research-snapshot-workbench", "data-research-workbench": "public-research-snapshot" }, [
        h("summary", "本地研究工作台：冻结公共研究快照"),
        h("div", { class: "public-research-snapshot-workbench-body" }, [
          h("p", { class: "research-meta mb-2" }, "仅本地可编辑；冻结只追加新快照与差分，不改写历史记录，也不会调用 LLM。"),
          h("div", { class: "d-flex gap-2 align-items-center" }, [h("input", { class: "form-control form-control-sm", value: state.value, "aria-label": "快照状态", onInput: (event: Event) => { state.value = (event.target as HTMLInputElement).value; } }), h("button", { class: "btn btn-primary btn-sm text-nowrap", disabled: saving.value || !state.value.trim(), onClick: () => void save() }, saving.value ? "冻结中…" : "冻结当前公共研究")]),
        ]),
      ]) : h("p", { class: "research-note mt-3 mb-0" }, "生产环境只读；不会调用 LLM，也不能写入快照。"),
    ]);
  },
});
