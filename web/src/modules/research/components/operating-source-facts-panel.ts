import { defineComponent, h, onMounted, ref } from "vue";

type Candidate = {
  candidateId: string; targetModule: string; targetField: string; statement: string; period: string | null; informationType: string;
  sourceUrl: string | null; contentUrl: string | null; title: string | null; sourceName: string | null;
  reusableEvidenceReference: { evidenceReferenceId: string; fieldStatus: string } | null;
};
type Fact = { operatingSourceFactId: string; sourceSecurityCode: string; evidenceReferenceId: string; candidateId: string; candidateReviewId: string; targetModule: string; targetField: string; factKind: string; subjectLabel: string; segmentLabel: string | null; customerOrChannel: string | null; periodLabel: string; periodKind: string; reportedValue: string; numericValue: number | null; unit: string | null; currency: string | null; amountScale: string | null; scopeDescription: string; comparabilityNote: string; statement: string; informationType: string; recordedBy: string; recordedAt: number; sourceUrl: string | null; sourceTitle: string | null; sourcePublishedAt: string | null };
type FactsBody = { code?: number; msg?: string; data?: { availability?: string; reason?: string | null; items?: Fact[] } };
type CandidatesBody = { code?: number; msg?: string; data?: { items?: Candidate[] } };
type Form = { subjectLabel: string; segmentLabel: string; customerOrChannel: string; periodLabel: string; periodKind: string; reportedValue: string; numericValue: string; unit: string; currency: string; amountScale: string; scopeDescription: string; comparabilityNote: string };

const kindFor = (candidate: Candidate) => ({
  "operating_driver.segment_volume": "segment_volume", "operating_driver.price_per_unit": "unit_price",
  "operating_driver.capacity_utilization": "capacity_utilization", "operating_model.order_backlog": "order_backlog",
  "operating_model.contract_driver": "contract_commitment", "operating_model.customer_relationship": "customer_relationship",
  "operating_model.capacity_constraint": "capacity_constraint", "operating_model.growth_constraint": "growth_constraint",
} as Record<string, string>)[`${candidate.targetModule}.${candidate.targetField}`] || "";
const numericRequired = (kind: string) => ["segment_volume", "unit_price", "capacity_utilization"].includes(kind);
const unitRequired = numericRequired;
const customerRequired = (kind: string) => ["contract_commitment", "customer_relationship"].includes(kind);
const css = `.operating-source-facts{border-left:4px solid #2563eb}.operating-source-facts .fact-item{border-top:1px solid #dbeafe;padding:.8rem 0}.operating-source-facts .fact-item:first-of-type{border-top:0}.operating-source-facts .fact-chain{font:normal .72rem ui-monospace,SFMono-Regular,Menlo,monospace;color:#475569;overflow-wrap:anywhere}.operating-source-facts .fact-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem;padding:.7rem;margin-top:.6rem;border-radius:.6rem;background:#eff6ff}.operating-source-facts label{font-size:.79rem;color:#1e3a5f}.operating-source-facts input,.operating-source-facts select,.operating-source-facts textarea{width:100%;margin-top:.2rem;border:1px solid #93c5fd;border-radius:.4rem;padding:.4rem;background:#fff}.operating-source-facts textarea{min-height:3.7rem}.operating-source-facts .wide{grid-column:1/-1}@media(max-width:600px){.operating-source-facts .fact-form{grid-template-columns:1fr}}`;
const empty = (): Form => ({ subjectLabel: "", segmentLabel: "", customerOrChannel: "", periodLabel: "", periodKind: "historical", reportedValue: "", numericValue: "", unit: "", currency: "", amountScale: "", scopeDescription: "", comparabilityNote: "" });
function date(value: number) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }

/**
 * The only bridge from a reviewed information record to a reusable operating
 * fact. The form deliberately has no model/plan/valuation selector: facts
 * remain source-layer records until a later human uses them as evidence.
 */
export const OperatingSourceFactsPanel = defineComponent({
  name: "OperatingSourceFactsPanel",
  props: { securityCode: { type: String, required: true }, canWrite: { type: Boolean, required: true }, initial: { type: Object, required: false, default: null } },
  setup(props) {
    const facts = ref<Fact[]>(Array.isArray((props.initial as any)?.items) ? (props.initial as any).items : []);
    const candidates = ref<Candidate[]>([]); const loading = ref(true); const error = ref(""); const selectedId = ref(""); const saving = ref(false); const form = ref<Form>(empty());
    const factsEndpoint = () => `/api/research/company/${encodeURIComponent(props.securityCode)}/operating-source-facts`;
    const candidatesEndpoint = () => `/api/research/company/${encodeURIComponent(props.securityCode)}/information-evidence-candidates`;
    const accepted = () => candidates.value.filter((item) => item.reusableEvidenceReference && kindFor(item));
    const selected = () => accepted().find((item) => item.candidateId === selectedId.value) || null;
    const loadFacts = async () => {
      const response = await fetch(factsEndpoint()); const body = await response.json() as FactsBody;
      if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取经营来源事实失败");
      facts.value = Array.isArray(body.data?.items) ? body.data!.items! : [];
    };
    const load = async () => {
      loading.value = true; error.value = "";
      try {
        await loadFacts();
        if (props.canWrite) {
          const response = await fetch(candidatesEndpoint()); const body = await response.json() as CandidatesBody;
          if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取已审核证据失败");
          candidates.value = Array.isArray(body.data?.items) ? body.data!.items! : [];
        }
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };
    const choose = (id: string) => {
      selectedId.value = id; const candidate = selected();
      form.value = { ...empty(), periodLabel: candidate?.period || "", reportedValue: candidate?.statement || "", scopeDescription: candidate ? `仅按该来源陈述的对象、范围与期间记录；未自动外推。` : "", comparabilityNote: "尚未与其他来源或模型口径合并。" };
    };
    const save = async () => {
      const candidate = selected(); if (!candidate?.reusableEvidenceReference) { error.value = "请选择已接受的来源证据。"; return; }
      const factKind = kindFor(candidate); const n = form.value.numericValue.trim() ? Number(form.value.numericValue) : null;
      if (!form.value.subjectLabel.trim() || !form.value.periodLabel.trim() || !form.value.reportedValue.trim() || !form.value.scopeDescription.trim() || !form.value.comparabilityNote.trim()) { error.value = "对象、期间、原始口径值、范围与可比性说明均为必填。"; return; }
      if (numericRequired(factKind) && !Number.isFinite(n)) { error.value = "该字段必须人工确认并填入有限的标准化数值。"; return; }
      if (unitRequired(factKind) && !form.value.unit.trim()) { error.value = "该字段必须填写单位。"; return; }
      if (factKind === "unit_price" && !form.value.currency.trim()) { error.value = "单位价格必须填写币种。"; return; }
      if (customerRequired(factKind) && !form.value.customerOrChannel.trim()) { error.value = "合同或客户关系必须填写客户或渠道。"; return; }
      saving.value = true; error.value = "";
      try {
        const response = await fetch(factsEndpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evidenceReferenceId: candidate.reusableEvidenceReference.evidenceReferenceId, factKind, subjectLabel: form.value.subjectLabel.trim(), segmentLabel: form.value.segmentLabel.trim() || null, customerOrChannel: form.value.customerOrChannel.trim() || null, periodLabel: form.value.periodLabel.trim(), periodKind: form.value.periodKind, reportedValue: form.value.reportedValue.trim(), numericValue: n, unit: form.value.unit.trim() || null, currency: form.value.currency.trim() || null, amountScale: form.value.amountScale.trim() || null, scopeDescription: form.value.scopeDescription.trim(), comparabilityNote: form.value.comparabilityNote.trim(), statement: candidate.statement, recordedBy: "local-user" }) });
        const body = await response.json() as FactsBody; if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存经营来源事实失败");
        selectedId.value = ""; form.value = empty(); await loadFacts();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    onMounted(() => { void load(); });
    const source = (candidate: Candidate) => { const url = candidate.sourceUrl || candidate.contentUrl; return url ? h("a", { href: url, target: "_blank", rel: "noreferrer", class: "evidence-link" }, candidate.title || candidate.sourceName || url) : h("span", "原始链接由相邻证据候选保留"); };
    const factSource = (item: Fact) => item.sourceUrl
      ? h("a", { href: item.sourceUrl, target: "_blank", rel: "noreferrer", class: "evidence-link" }, item.sourceTitle || item.sourceUrl)
      : h("span", "来源链接在证据引用中不可得");
    const field = (label: string, key: keyof Form, wide = false, type = "text") => h("label", { class: wide ? "wide" : "" }, [label, type === "textarea" ? h("textarea", { value: form.value[key], onInput: (e: Event) => form.value = { ...form.value, [key]: (e.target as HTMLTextAreaElement).value } }) : h("input", { type, value: form.value[key], onInput: (e: Event) => form.value = { ...form.value, [key]: (e.target as HTMLInputElement).value } })]);
    return () => h("section", { class: "research-card operating-source-facts" }, [
      h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "经营披露来源事实账本"), h("p", { class: "research-meta mb-0" }, "已接受的信息预处理证据可在本地人工规范化为可复用的经营事实。保存不会填充经营模型、驱动计划、情景或估值；这些仍须在后续人工版本中明确引用。")]), h("span", { class: "research-state" }, props.canWrite ? "本地可录入" : "生产只读")]),
      error.value ? h("div", { class: "alert alert-warning py-2 mt-3 mb-0" }, [error.value, h("button", { class: "btn btn-link btn-sm py-0 ms-2", onClick: () => void load() }, "重试")]) : null,
      loading.value ? h("p", { class: "research-meta mt-3 mb-0" }, "正在读取经营来源事实…") : null,
      !loading.value && !facts.value.length ? h("div", { class: "research-note mt-3" }, "尚无已规范化的经营来源事实。没有精确公司映射、已接受证据或人工口径时保持为空，不能用模型假设替代。") : null,
      ...facts.value.map((item) => h("article", { class: "fact-item", key: item.operatingSourceFactId }, [h("div", { class: "d-flex justify-content-between gap-2" }, [h("strong", `${item.factKind} · ${item.subjectLabel}`), h("span", { class: "research-state" }, `${item.periodLabel} · ${item.informationType}`)]), h("p", { class: "small mb-1 mt-2" }, item.reportedValue), h("p", { class: "research-meta mb-1" }, `标准化值：${item.numericValue ?? "未填写"}${item.unit ? ` ${item.unit}` : ""}${item.currency ? ` · ${item.currency}` : ""}${item.amountScale ? ` · 缩放 ${item.amountScale}` : ""}`), h("p", { class: "research-meta mb-1" }, ["来源：", factSource(item), item.sourcePublishedAt ? ` · 发布 ${item.sourcePublishedAt}` : ""]), h("p", { class: "research-meta mb-1" }, `范围：${item.scopeDescription}；可比性：${item.comparabilityNote}`), h("p", { class: "fact-chain mb-0" }, `fact=${item.operatingSourceFactId} · evidence=${item.evidenceReferenceId} · candidate=${item.candidateId} · review=${item.candidateReviewId} · source security=${item.sourceSecurityCode} · recorded=${date(item.recordedAt)}`)])),
      props.canWrite ? h("div", { class: "fact-form" }, [
        h("label", { class: "wide" }, ["已接受来源证据", h("select", { value: selectedId.value, onChange: (e: Event) => choose((e.target as HTMLSelectElement).value) }, [h("option", { value: "" }, "选择已接受且字段兼容的候选"), ...accepted().map((item) => h("option", { value: item.candidateId }, `${kindFor(item)} · ${item.period || "未注明期间"} · ${item.statement.slice(0, 48)}`))])]),
        selected() ? h("div", { class: "wide research-note small" }, [h("strong", `${kindFor(selected()!)} · ${selected()!.targetModule}.${selected()!.targetField}`), h("p", { class: "mb-1 mt-1" }, selected()!.statement), source(selected()!)]) : null,
        field("对象/字段标签", "subjectLabel"), field("分部标签（可选）", "segmentLabel"), field("客户或渠道（合同/关系必填）", "customerOrChannel"), field("期间", "periodLabel"), h("label", ["期间性质", h("select", { value: form.value.periodKind, onChange: (e: Event) => form.value = { ...form.value, periodKind: (e.target as HTMLSelectElement).value } }, [["historical", "已发生"], ["current", "当前状态"], ["future_guidance", "未来指引"], ["event", "事件"], ["other", "其他"]].map(([value, label]) => h("option", { value }, label)))]), field("来源原始口径值", "reportedValue"), field(`标准化数值${selected() && numericRequired(kindFor(selected()!)) ? "（必填）" : "（可选）"}`, "numericValue", false, "number"), field(`单位${selected() && unitRequired(kindFor(selected()!)) ? "（必填）" : "（可选）"}`, "unit"), field("币种（单位价格必填）", "currency"), field("数值缩放（可选，如百万）", "amountScale"), field("适用范围与边界", "scopeDescription", true, "textarea"), field("可比性/未解决口径", "comparabilityNote", true, "textarea"), h("div", { class: "wide" }, h("button", { class: "btn btn-primary btn-sm", disabled: saving.value || !selected(), onClick: () => void save() }, saving.value ? "保存中…" : "保存不可变来源事实")),
      ]) : null,
    ]);
  },
});
