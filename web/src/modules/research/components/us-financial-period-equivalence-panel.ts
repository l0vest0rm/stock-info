import { defineComponent, h, ref } from "vue";

type Value = Record<string, any>;

export const UsFinancialPeriodEquivalencePanel = defineComponent({
  name: "UsFinancialPeriodEquivalencePanel",
  props: { securityCode: { type: String, required: true }, initial: { type: Object, required: true }, canWrite: { type: Boolean, required: true } },
  setup(props) {
    const data = ref<Value>(props.initial as Value); const saving = ref(false); const error = ref(""); const notice = ref("");
    const form = ref<Value>(emptyForm());
    const input = (label: string, key: string, required = true) => h("label", { class: "us-period-field" }, [h("span", label), h("input", { value: form.value[key], required, onInput: (event: Event) => { form.value[key] = (event.target as HTMLInputElement).value; } })]);
    const save = async () => {
      saving.value = true; error.value = ""; notice.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/us-financial-period-equivalences`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form.value, reviewedAt: Date.now() }) });
        const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "追加报告期映射失败");
        const item = body.data; data.value = { availability: "available", reason: null, items: [item, ...(data.value.items || [])] };
        notice.value = item.reviewDecision === "accepted" ? "已追加已接受映射；请再显式运行 SEC 核验，原 Yahoo 日期和值均未改写。" : "已追加拒绝记录；它不会被 SEC 核验消费。";
        form.value = emptyForm();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { saving.value = false; }
    };
    return () => h("details", { class: "research-card mt-3", "data-us-financial-period-equivalence-workbench": "local" }, [
      h("summary", [h("strong", "本地工作台：Yahoo—SEC 非自然财年报告期等价映射"), h("span", { class: "research-meta ms-2" }, "默认收起；必须人工审核")]),
      h("div", { class: "mt-3" }, [
        h("style", ".us-period-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.65rem}.us-period-field{display:grid;gap:.2rem;font-size:.8rem}.us-period-field input{min-width:0;padding:.35rem}.us-period-record{border-top:1px solid #e5e7eb;padding:.6rem 0}"),
        h("p", { class: "research-note" }, "仅用于已人工确认的 Yahoo 显示日期与同一 SEC 申报精确报告期。不会按邻近日期或金额自动匹配，不会回填 Yahoo 主源，也不会解除期末稀释股数门禁。"),
        (data.value.items || []).length ? h("div", (data.value.items || []).map((item: Value) => h("article", { class: "us-period-record" }, [
          h("strong", `${item.reviewDecision === "accepted" ? "已接受" : "已拒绝"} · ${item.metric} · Yahoo ${item.primaryPeriod?.startDate}–${item.primaryPeriod?.endDate}`),
          h("div", { class: "research-meta" }, `SEC ${item.secPeriodStartDate || "时点"}–${item.secPeriodEndDate} · ${item.secNamespace}:${item.secConcept} · ${item.secAccession}`),
          h("div", { class: "research-meta" }, `${item.reviewedBy} · ${new Date(item.reviewedAt).toLocaleString("zh-CN", { hour12: false })} · ${item.reviewReason}`),
          h("a", { href: item.evidenceUrl, target: "_blank", rel: "noreferrer", class: "evidence-link small" }, item.evidenceTitle),
        ]))) : h("p", { class: "research-meta" }, data.value.reason || "尚无映射。"),
        props.canWrite ? h("div", { class: "mt-3" }, [
          h("h4", { class: "h6" }, "追加人工审核记录"),
          h("div", { class: "us-period-grid" }, [
            input("Yahoo 报表", "primaryStatementType"), input("字段", "metric"), input("Yahoo 期间起", "primaryPeriodStartDate"), input("Yahoo 期间止", "primaryPeriodEndDate"),
            input("SEC CIK（10 位）", "secCik"), input("SEC accession", "secAccession"), input("SEC namespace", "secNamespace"), input("SEC concept", "secConcept"), input("SEC unit", "secUnit"),
            input("SEC 期间起（时点留空）", "secPeriodStartDate", false), input("SEC 期间止", "secPeriodEndDate"), input("SEC form", "secForm"), input("SEC 文件 URL", "evidenceUrl"), input("文件标题", "evidenceTitle"), input("审核理由", "reviewReason"), input("审核人", "reviewedBy"),
          ]),
          h("label", { class: "us-period-field mt-2" }, [h("span", "审核决定"), h("select", { value: form.value.reviewDecision, onChange: (event: Event) => { form.value.reviewDecision = (event.target as HTMLSelectElement).value; } }, [h("option", { value: "accepted" }, "接受：允许严格 SEC 核验"), h("option", { value: "rejected" }, "拒绝：仅保留审计记录")])]),
          error.value ? h("p", { class: "text-danger small mt-2" }, error.value) : null, notice.value ? h("p", { class: "text-success small mt-2" }, notice.value) : null,
          h("button", { class: "btn btn-outline-primary btn-sm mt-2", disabled: saving.value, onClick: () => void save() }, saving.value ? "追加中…" : "追加不可变审核记录"),
        ]) : h("p", { class: "research-meta" }, "生产环境只读；映射录入仅本地运行。"),
      ]),
    ]);
  },
});

function emptyForm() { return { primaryStatementType: "income", metric: "revenue", primaryPeriodStartDate: "", primaryPeriodEndDate: "", secCik: "", secAccession: "", secNamespace: "us-gaap", secConcept: "", secUnit: "USD", secPeriodStartDate: "", secPeriodEndDate: "", secForm: "10-Q", evidenceUrl: "", evidenceTitle: "", reviewDecision: "accepted", reviewReason: "", reviewedBy: "local-user" }; }
