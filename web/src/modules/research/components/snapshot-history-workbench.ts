import { defineComponent, h, onMounted, ref } from "vue";

type Snapshot = {
  analysisSnapshotId: string;
  asOf: number;
  completionLevel: string;
  state: string;
  summary: Record<string, unknown>;
  modules: Array<{ moduleId: string; availability: string; versionId: string | null; asOf: number | null; payload: Record<string, unknown> }>;
  differences: Array<{ differenceId: string; moduleId: string; changeType: string; fields: Array<{ path: string }> }>;
};

const css = `.snapshot-history{margin-top:1rem;border-left:4px solid #2563eb}.snapshot-history-row{border-top:1px solid #dbeafe;padding:.7rem 0}.snapshot-history-row:first-of-type{border-top:0}.snapshot-history-meta{font-size:.8rem;color:#64748b}.snapshot-history details{margin-top:.45rem}.snapshot-history summary{cursor:pointer;color:#1d4ed8;font-size:.84rem}.snapshot-history code{font-size:.76rem;white-space:pre-wrap;word-break:break-word}`;

function date(value: number | null | undefined) { return value && Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "待补"; }
function compact(value: unknown) { try { const result = JSON.stringify(value); return result.length > 900 ? `${result.slice(0, 897)}…` : result; } catch { return "不可展示"; } }

/** Historical modules are read from frozen snapshot payloads only.  This is
 * intentionally separate from the live risk editor so reviewing the past
 * cannot mutate the public record or accidentally show today's facts. */
export const SnapshotHistoryWorkbench = defineComponent({
  name: "SnapshotHistoryWorkbench",
  props: { securityCode: { type: String, required: true } },
  setup(props) {
    const loading = ref(false); const error = ref(""); const snapshots = ref<Snapshot[]>([]); const state = ref("empty");
    const load = async () => {
      loading.value = true; error.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/public-risk-snapshots?limit=24`);
        const body = await response.json();
        if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取公共快照历史失败");
        state.value = body.data.availability; snapshots.value = Array.isArray(body.data.items) ? body.data.items : [];
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };
    onMounted(() => { void load(); });
    return () => h("section", { class: "research-card snapshot-history" }, [
      h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "公共快照历史与当时可见信息"), h("p", { class: "research-meta mb-0" }, "每一项从冻结模块读取；不会用当前风险、命题或个人决定回填历史。")]), h("button", { class: "btn btn-outline-primary btn-sm", disabled: loading.value, onClick: () => void load() }, loading.value ? "刷新中…" : "刷新历史")]),
      error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null,
      !loading.value && !error.value && !snapshots.value.length ? h("div", { class: "research-note mt-3" }, state.value === "unavailable" ? "快照存储尚未初始化；历史不能由当前数据替代。" : "尚无公共风险快照。先在风险工作台冻结一个带日期的公共快照。") : null,
      snapshots.value.map((snapshot) => h("article", { class: "snapshot-history-row" }, [
        h("strong", `${date(snapshot.asOf)} · ${snapshot.completionLevel} · ${snapshot.state}`),
        h("div", { class: "snapshot-history-meta" }, `快照 ${snapshot.analysisSnapshotId}；相对前一快照变更 ${snapshot.differences.length} 个模块；私有数据未纳入。`),
        h("details", [h("summary", `冻结模块（${snapshot.modules.length}）`), h("ul", { class: "research-list small mt-2" }, snapshot.modules.map((module) => h("li", [h("strong", `${module.moduleId} · ${module.availability}`), ` · 截止 ${date(module.asOf)}`, h("details", [h("summary", "查看当时模块内容"), h("code", compact(module.payload))])])))]),
        snapshot.differences.length ? h("details", [h("summary", `字段差分（${snapshot.differences.length}）`), h("ul", { class: "research-list small mt-2" }, snapshot.differences.map((difference) => h("li", `${difference.moduleId} · ${difference.changeType}：${difference.fields.map((field) => field.path).join("、") || "模块整体变化"}`)))]) : null,
      ])),
    ]);
  },
});
