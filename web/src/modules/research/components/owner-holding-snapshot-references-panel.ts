import { defineComponent, h, onMounted, ref } from "vue";

type PublicSnapshot = { analysisSnapshotId: string; asOf: number; completionLevel: string; state: string; createdAt: number };
type Reference = { referenceId: string; holdingSecurityCode: string; publicSnapshot: PublicSnapshot; createdAt: number };
type ReferenceView = { availability: "available" | "unavailable"; reason: string | null; holdingConfigured: boolean; holdingUpdatedAt: number | null; items: Reference[] };

const css = `.owner-holding-snapshot-references{margin-top:1rem;border-left:4px solid #7c3aed}.owner-holding-snapshot-reference{border-top:1px solid #ede9fe;padding:.65rem 0}.owner-holding-snapshot-reference:first-of-type{border-top:0}.owner-holding-snapshot-reference-meta{font-size:.8rem;color:#64748b}.owner-holding-snapshot-reference-workbench{margin-top:.85rem;border:1px dashed #a78bfa;border-radius:.7rem;padding:.7rem}.owner-holding-snapshot-reference-workbench>summary{cursor:pointer;color:#6d28d9;font-size:.85rem;font-weight:700}.owner-holding-snapshot-reference-workbench-body{padding-top:.7rem}`;
function date(value: number | null | undefined) { return value && Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "待补"; }
function apiError(value: unknown, fallback: string) { return value && typeof value === "object" && "msg" in value ? String((value as { msg?: unknown }).msg || fallback) : fallback; }

/**
 * This panel owns a private reference only.  It intentionally never receives
 * the holding profile JSON and never sends a reference into public research.
 */
export const OwnerHoldingSnapshotReferencesPanel = defineComponent({
  name: "OwnerHoldingSnapshotReferencesPanel",
  props: { securityCode: { type: String, required: true }, canWrite: { type: Boolean, default: false } },
  setup(props) {
    const loading = ref(false); const saving = ref(false); const error = ref(""); const notice = ref("");
    const view = ref<ReferenceView | null>(null); const snapshots = ref<PublicSnapshot[]>([]); const selectedSnapshotId = ref("");
    const owner = "local-user";
    const endpoint = () => `/api/research/company/${encodeURIComponent(props.securityCode)}/owner-holding-snapshot-references?owner=${encodeURIComponent(owner)}`;
    const snapshotsEndpoint = () => `/api/research/company/${encodeURIComponent(props.securityCode)}/public-research-snapshots?limit=24`;
    const load = async () => {
      if (!props.canWrite) return;
      loading.value = true; error.value = "";
      try {
        const [referencesResponse, snapshotsResponse] = await Promise.all([fetch(endpoint()), fetch(snapshotsEndpoint())]);
        const [referencesBody, snapshotsBody] = await Promise.all([referencesResponse.json(), snapshotsResponse.json()]);
        if (!referencesResponse.ok || referencesBody.code !== 200) throw new Error(apiError(referencesBody, "读取个人持仓快照引用失败"));
        if (!snapshotsResponse.ok || snapshotsBody.code !== 200) throw new Error(apiError(snapshotsBody, "读取公共研究快照失败"));
        view.value = referencesBody.data as ReferenceView;
        snapshots.value = Array.isArray(snapshotsBody.data?.items) ? snapshotsBody.data.items as PublicSnapshot[] : [];
        if (!selectedSnapshotId.value) selectedSnapshotId.value = snapshots.value[0]?.analysisSnapshotId || "";
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };
    const save = async () => {
      if (!selectedSnapshotId.value) return;
      saving.value = true; error.value = ""; notice.value = "";
      try {
        const response = await fetch(endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerKey: owner, publicSnapshotId: selectedSnapshotId.value }) });
        const body = await response.json();
        if (!response.ok || body.code !== 200) throw new Error(apiError(body, "创建持仓快照引用失败"));
        notice.value = "已追加私有引用；持仓档案与公共研究快照均未被改写。";
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    onMounted(() => { void load(); });
    return () => h("section", { class: "research-card private-boundary owner-holding-snapshot-references", "data-owner-holding-snapshot-references": "true" }, [
      h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "既有持仓的公共研究快照引用"), h("p", { class: "research-meta mb-0" }, "仅当前 owner 的既有持仓档案可引用同一证券的冻结公共研究快照。引用不复制持仓、不生成交易动作，也不改写公共事实、命题、风险或其他用户数据。")]), props.canWrite ? h("button", { class: "btn btn-outline-primary btn-sm", disabled: loading.value, onClick: () => void load() }, loading.value ? "刷新中…" : "刷新") : null]),
      !props.canWrite ? h("p", { class: "research-note mt-3 mb-0", "data-owner-holding-snapshot-production-boundary": "true" }, "生产环境没有已认证的 owner 模型，因此不读取、不展示也不写入个人持仓或其研究引用。") : null,
      error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null,
      notice.value ? h("div", { class: "alert alert-success py-2 mt-3 mb-0" }, notice.value) : null,
      props.canWrite && view.value?.availability === "unavailable" ? h("p", { class: "research-note mt-3 mb-0" }, `当前受阻：${view.value.reason || "本地存储待初始化"}。`) : null,
      props.canWrite && view.value?.availability === "available" && !view.value.holdingConfigured ? h("p", { class: "research-note mt-3 mb-0", "data-owner-holding-snapshot-no-holding": "true" }, "当前 owner 尚未配置该证券的既有持仓档案，因此不能创建引用；系统行动候选不被当作个人交易计划。") : null,
      props.canWrite && view.value?.holdingConfigured && !view.value.items.length ? h("p", { class: "research-note mt-3 mb-0" }, "该持仓尚未引用公共研究快照。没有冻结快照时不会创建指向实时研究的替代引用。") : null,
      props.canWrite && view.value?.items.map((item) => h("article", { class: "owner-holding-snapshot-reference" }, [h("strong", `${item.publicSnapshot.completionLevel} · ${item.publicSnapshot.state}`), h("div", { class: "owner-holding-snapshot-reference-meta" }, `公共快照 ${item.publicSnapshot.analysisSnapshotId} · 研究截止 ${date(item.publicSnapshot.asOf)} · 个人引用于 ${date(item.createdAt)}`)])),
      props.canWrite && view.value?.holdingConfigured ? h("details", { class: "owner-holding-snapshot-reference-workbench", "data-research-workbench": "owner-holding-snapshot-references" }, [
        h("summary", "本地个人工作台：追加持仓对冻结公共研究的引用"),
        h("div", { class: "owner-holding-snapshot-reference-workbench-body" }, [
          h("p", { class: "research-meta mb-2" }, "只能选择此证券已冻结的公共全研究快照；不能编辑、删除或把个人内容写回快照。交易计划需要独立的 owner 模型，当前不会以系统候选代替。"),
          snapshots.value.length ? h("div", { class: "d-flex gap-2 align-items-center" }, [h("select", { class: "form-select form-select-sm", value: selectedSnapshotId.value, "aria-label": "选择冻结公共研究快照", onChange: (event: Event) => { selectedSnapshotId.value = (event.target as HTMLSelectElement).value; } }, snapshots.value.map((snapshot) => h("option", { value: snapshot.analysisSnapshotId }, `${date(snapshot.asOf)} · ${snapshot.completionLevel} · ${snapshot.state} · ${snapshot.analysisSnapshotId}`))), h("button", { class: "btn btn-primary btn-sm text-nowrap", disabled: saving.value || !selectedSnapshotId.value, onClick: () => void save() }, saving.value ? "引用中…" : "追加只读引用")]) : h("p", { class: "research-note mb-0" }, "尚无同一证券的冻结公共全研究快照。先在“风险、事件与变化”的本地公共快照工作台中冻结；不会以实时页面状态代替版本。"),
        ]),
      ]) : null,
    ]);
  },
});
