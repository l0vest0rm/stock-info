import { defineComponent, h, onMounted, ref } from "vue";

type ReviewDecision = "accepted" | "rejected" | "needs_evidence";
type Candidate = {
  candidateId: string;
  securityCode: string;
  informationId: string;
  resultId: string;
  runId: string;
  versionId: string;
  contentHash: string;
  docId: string;
  entity: string;
  informationType: string;
  category: string;
  period: string | null;
  statement: string;
  targetModule: string;
  targetField: string;
  requiredFields: string[];
  sourceUrl: string | null;
  contentUrl: string | null;
  title: string | null;
  sourceName: string | null;
  publishedAt: string | number | null;
  latestReview: { decision: ReviewDecision; reviewNote: string; reviewedBy: string; reviewedAt: number } | null;
  reusableEvidenceReference: { evidenceReferenceId: string; fieldStatus: string } | null;
  statutoryProvenance: { registry: "cninfo" | "hkex" | "sec"; documentId: string; documentUrl: string; sourceLocator: string } | null;
};

type ApiBody = { code?: number; msg?: string; data?: { items?: Candidate[] } };

const css = `.information-evidence-candidates{margin-top:1rem;border-left:4px solid #0f766e}.information-evidence-item{border-top:1px solid #dbe7e5;padding:.85rem 0}.information-evidence-item:first-of-type{border-top:0}.information-evidence-meta{display:flex;flex-wrap:wrap;gap:.3rem .75rem;color:#64748b;font-size:.78rem}.information-evidence-chain{margin:.55rem 0;padding:.55rem .65rem;border-radius:.5rem;background:#f8fafc;color:#475569;font:normal .72rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.information-evidence-form{display:grid;grid-template-columns:10rem minmax(0,1fr);gap:.55rem;margin-top:.7rem;padding:.7rem;border-radius:.65rem;background:#f0fdfa}.information-evidence-form label{font-size:.8rem;color:#28534f}.information-evidence-form select,.information-evidence-form textarea{display:block;width:100%;margin-top:.2rem;padding:.4rem;border:1px solid #94bfb8;border-radius:.4rem;background:#fff}.information-evidence-form textarea{min-height:3.5rem}.information-evidence-wide{grid-column:1/-1}@media(max-width:600px){.information-evidence-form{grid-template-columns:1fr}}`;

function date(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "未注明";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN", { hour12: false }) : String(value);
}
function short(value: string) { return value.length > 34 ? `${value.slice(0, 31)}…` : value; }
function reviewLabel(value: ReviewDecision) { return ({ accepted: "已接受为可复用引用", rejected: "已拒绝", needs_evidence: "需补充证据" } as Record<ReviewDecision, string>)[value]; }

/**
 * Presents local information-processing outputs as reviewable source bindings.
 * Acceptance deliberately creates only a reusable `needs_field_entry` reference.
 */
export const InformationEvidenceCandidatesPanel = defineComponent({
  name: "InformationEvidenceCandidatesPanel",
  props: { securityCode: { type: String, required: true }, canWrite: { type: Boolean, required: true } },
  setup(props) {
    const candidates = ref<Candidate[]>([]); const loading = ref(true); const refreshing = ref(false); const producingStatutory = ref(false); const savingId = ref(""); const error = ref("");
    const editorId = ref(""); const decision = ref<ReviewDecision>("needs_evidence"); const reviewNote = ref("");
    const endpoint = () => `/api/research/company/${encodeURIComponent(props.securityCode)}/information-evidence-candidates`;
    const load = async () => {
      loading.value = true; error.value = "";
      try {
        const response = await fetch(endpoint()); const body = await response.json() as ApiBody;
        if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取信息证据候选失败");
        candidates.value = Array.isArray(body.data?.items) ? body.data!.items! : [];
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };
    const refresh = async () => {
      refreshing.value = true; error.value = "";
      try {
        const response = await fetch(`${endpoint()}/refresh`, { method: "POST" }); const body = await response.json() as ApiBody;
        if (!response.ok || body.code !== 200) throw new Error(body.msg || "刷新信息证据候选失败");
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { refreshing.value = false; }
    };
    const produceStatutory = async () => {
      producingStatutory.value = true; error.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/statutory-operating-candidates/produce`, { method: "POST" });
        const body = await response.json() as ApiBody & { data?: { created?: number; existing?: number; rejectionReasons?: string[] } };
        if (!response.ok || body.code !== 200) throw new Error(body.msg || "法定披露候选生产失败");
        const reasons = body.data?.rejectionReasons || [];
        if (reasons.length) error.value = `未生成候选：${reasons.join("、")}。请先索引法定披露，并将原文导入且完成信息预处理。`;
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { producingStatutory.value = false; }
    };
    const openEditor = (candidate: Candidate) => { editorId.value = candidate.candidateId; decision.value = candidate.latestReview?.decision || "needs_evidence"; reviewNote.value = ""; error.value = ""; };
    const saveReview = async (candidate: Candidate) => {
      if (!reviewNote.value.trim()) { error.value = "审核说明不能为空。"; return; }
      savingId.value = candidate.candidateId; error.value = "";
      try {
        const response = await fetch(`${endpoint()}/${encodeURIComponent(candidate.candidateId)}/reviews`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: decision.value, reviewNote: reviewNote.value.trim(), reviewedBy: "local-user" }),
        });
        const body = await response.json() as ApiBody;
        if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存证据审核失败");
        editorId.value = ""; reviewNote.value = ""; await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { savingId.value = ""; }
    };
    onMounted(() => { void load(); });
    const source = (candidate: Candidate) => {
      const url = candidate.sourceUrl || candidate.contentUrl;
      return url ? h("a", { class: "evidence-link", href: url, target: "_blank", rel: "noreferrer" }, candidate.title || candidate.sourceName || url) : h("span", "原始链接待补");
    };
    return () => h("section", { class: "research-card information-evidence-candidates" }, [
      h("style", css),
      h("div", { class: "section-head" }, [h("div", [h("h2", "信息预处理证据候选"), h("p", { class: "research-meta mb-0" }, "仅精确公司—证券映射且命中配置规则的已提取信息才会出现。法定披露生产器只复用已索引、已导入并完成信息预处理的原文；接受只建立可复用来源引用和待填字段，不会写入经营模型、市场空间或估值。")]),
        props.canWrite ? h("div", { class: "d-flex gap-2 flex-wrap" }, [h("button", { class: "btn btn-outline-primary btn-sm", disabled: producingStatutory.value || loading.value, onClick: () => void produceStatutory() }, producingStatutory.value ? "核对法定链路中…" : "从法定披露生成候选"), h("button", { class: "btn btn-outline-success btn-sm", disabled: refreshing.value || loading.value, onClick: () => void refresh() }, refreshing.value ? "刷新中…" : "刷新全部信息候选")]) : h("span", { class: "research-meta" }, "生产环境只读；候选审核仅本地运行")]),
      error.value ? h("div", { class: "alert alert-warning py-2 mt-3 mb-0" }, [error.value, h("button", { class: "btn btn-link btn-sm py-0 ms-2", onClick: () => void load() }, "重试")]) : null,
      loading.value ? h("p", { class: "research-meta mt-3 mb-0" }, "正在读取可审计信息证据候选…") : null,
      !loading.value && !error.value && !candidates.value.length ? h("div", { class: "research-note mt-3" }, "尚无候选。未精确映射到本证券、未命中配置类别或未完成信息提取的数据均不会被放宽为候选。") : null,
      ...candidates.value.map((candidate) => h("article", { class: "information-evidence-item", key: candidate.candidateId }, [
        h("div", { class: "d-flex justify-content-between gap-2 align-items-start" }, [h("div", [h("strong", `${candidate.targetModule}.${candidate.targetField}`), h("div", { class: "mt-1" }, source(candidate))]), candidate.reusableEvidenceReference ? h("span", { class: "research-state" }, `已建引用 · ${candidate.reusableEvidenceReference.fieldStatus}`) : candidate.latestReview ? h("span", { class: "research-state" }, reviewLabel(candidate.latestReview.decision)) : h("span", { class: "research-state" }, "待审核")]),
        h("p", { class: "small mb-1 mt-2" }, candidate.statement),
        h("div", { class: "information-evidence-meta" }, [`实体：${candidate.entity}`, `类别：${candidate.category}`, `类型：${candidate.informationType}`, `期间：${candidate.period || "未注明"}`, `来源：${candidate.sourceName || "未注明"}`, `发布：${date(candidate.publishedAt)}`].map((item) => h("span", item))),
        h("p", { class: "research-meta small mb-1 mt-2" }, `仍需人工填写：${candidate.requiredFields.length ? candidate.requiredFields.join("、") : "字段口径与适用范围"}`),
        candidate.statutoryProvenance ? h("div", { class: "research-note small mt-2" }, ["法定披露绑定：", h("a", { class: "evidence-link", href: candidate.statutoryProvenance.documentUrl, target: "_blank", rel: "noreferrer" }, `${candidate.statutoryProvenance.registry.toUpperCase()} · ${candidate.statutoryProvenance.documentId}`), ` · ${candidate.statutoryProvenance.sourceLocator}`]) : null,
        h("div", { class: "information-evidence-chain", title: `information=${candidate.informationId}\nresult=${candidate.resultId}\nrun=${candidate.runId}\nversion=${candidate.versionId}\ndocument=${candidate.docId}\ncontent_hash=${candidate.contentHash}` }, `information ${short(candidate.informationId)} · version ${short(candidate.versionId)} · document ${short(candidate.docId)} · hash ${short(candidate.contentHash)}`),
        candidate.latestReview ? h("div", { class: "research-note small mt-2" }, `最近审核：${reviewLabel(candidate.latestReview.decision)} · ${date(candidate.latestReview.reviewedAt)} · ${candidate.latestReview.reviewedBy}。${candidate.latestReview.reviewNote}`) : null,
        props.canWrite ? editorId.value === candidate.candidateId ? h("div", { class: "information-evidence-form" }, [
          h("label", ["审核结论", h("select", { value: decision.value, onChange: (event: Event) => decision.value = (event.target as HTMLSelectElement).value as ReviewDecision }, [["accepted", "接受：建立可复用引用"], ["needs_evidence", "需补充证据"], ["rejected", "拒绝"]].map(([value, label]) => h("option", { value }, label)))]),
          h("label", ["审核说明（必填）", h("textarea", { value: reviewNote.value, onInput: (event: Event) => reviewNote.value = (event.target as HTMLTextAreaElement).value, placeholder: "说明来源适用范围、口径或需补证据原因" })]),
          h("div", { class: "information-evidence-wide d-flex gap-2" }, [h("button", { class: "btn btn-success btn-sm", disabled: savingId.value === candidate.candidateId, onClick: () => void saveReview(candidate) }, savingId.value === candidate.candidateId ? "保存中…" : "追加审核"), h("button", { class: "btn btn-link btn-sm", disabled: savingId.value === candidate.candidateId, onClick: () => { editorId.value = ""; reviewNote.value = ""; } }, "取消")]),
        ]) : h("button", { class: "btn btn-outline-secondary btn-sm mt-2", onClick: () => openEditor(candidate) }, "追加审核") : null,
      ])),
    ]);
  },
});
