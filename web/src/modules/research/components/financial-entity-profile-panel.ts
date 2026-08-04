import { defineComponent, h, ref } from "vue";

type Value = Record<string, any>;
const typeLabels: Record<string, string> = { non_financial: "非金融企业", bank: "银行", insurer: "保险", broker: "券商", financial_other: "其他金融实体" };
const authorityOptions = [["issuer_disclosure", "发行人正式披露"], ["exchange_filing", "交易所文件"], ["regulator_or_court", "监管/司法文件"], ["audit_report", "审计报告"]] as const;

export const FinancialEntityProfilePanel = defineComponent({
  name: "FinancialEntityProfilePanel",
  props: { securityCode: { type: String, required: true }, initial: { type: Object, required: true }, canWrite: { type: Boolean, required: true } },
  setup(props) {
    const data = ref<Value>(props.initial as Value); const saving = ref(false); const error = ref(""); const notice = ref("");
    const form = ref<Value>({ entityType: "non_financial", asOf: new Date().toISOString().slice(0, 10), sourceAuthority: "issuer_disclosure", sourceUrl: "", sourceTitle: "", sourceNote: "" });
    const refresh = async () => { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/financial-profile`); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取金融实体类型失败"); data.value = body.data; };
    const save = async () => { saving.value = true; error.value = ""; notice.value = ""; try { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/financial-profile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form.value) }); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "追加金融实体类型失败"); data.value = body.data; notice.value = "已追加来源绑定分类；历史记录不会被改写。"; } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { saving.value = false; } };
    const input = (label: string, key: string, type = "text") => h("label", { class: "financial-profile-field" }, [h("span", label), h("input", { type, value: form.value[key], onInput: (event: Event) => { form.value[key] = (event.target as HTMLInputElement).value; } })]);
    const select = (label: string, key: string, choices: ReadonlyArray<readonly [string, string]>) => h("label", { class: "financial-profile-field" }, [h("span", label), h("select", { value: form.value[key], onChange: (event: Event) => { form.value[key] = (event.target as HTMLSelectElement).value; } }, choices.map(([value, text]) => h("option", { value }, text)))]);
    return () => h("section", { class: "research-card section-card financial-profile-panel" }, [
      h("style", ".financial-profile-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.65rem}.financial-profile-field{display:grid;gap:.25rem;font-size:.82rem}.financial-profile-field input,.financial-profile-field select{width:100%;padding:.35rem}.financial-profile-row{border-top:1px solid #e5e7eb;padding:.55rem 0}"),
      h("div", { class: "section-head" }, [h("div", [h("h2", "金融实体类型与指标适用性"), h("p", { class: "research-meta mb-0" }, "经营实体类型必须由来源确认；不会按证券代码、名称或行业标签猜测。银行/保险/券商不会显示通用 FCF、营运资本、现金转换或 ROIC。")]), h("span", { class: "research-state" }, data.value.status === "confirmed" ? typeLabels[data.value.entityType] || data.value.entityType : data.value.status === "conflicting" ? "分类冲突" : "待确认")]),
      h("div", { class: `research-note mt-3 ${data.value.status === "confirmed" ? "" : ""}` }, data.value.reason || "金融实体类型待补"),
      (data.value.records || []).length ? h("details", { class: "mt-3" }, [h("summary", `查看 ${data.value.records.length} 条可审计分类记录`), h("div", { class: "mt-2" }, data.value.records.map((item: Value) => h("article", { class: "financial-profile-row" }, [h("strong", typeLabels[item.entityType] || item.entityType), h("div", { class: "research-meta" }, `${item.asOf} · ${item.sourceAuthority} · ${item.recordedBy}`), h("div", { class: "small" }, [h("a", { href: item.sourceUrl, target: "_blank", rel: "noreferrer" }, item.sourceTitle), `：${item.sourceNote}`])])) )]) : null,
      props.canWrite ? h("details", { class: "mt-3", "data-research-workbench": "financial-entity-profile" }, [h("summary", "本地工作台：追加来源绑定分类"), h("div", { class: "mt-2" }, [h("p", { class: "research-meta" }, "只能追加，不会覆盖历史；同一截至日出现不同类型会显式标记冲突并继续阻断通用非金融指标。"), h("div", { class: "financial-profile-grid" }, [select("经营实体类型", "entityType", Object.entries(typeLabels)), input("截至日", "asOf", "date"), select("来源权威类型", "sourceAuthority", authorityOptions), input("来源 URL（HTTPS）", "sourceUrl", "url"), input("来源标题", "sourceTitle"), input("证据定位/说明", "sourceNote")]), error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null, notice.value ? h("div", { class: "alert alert-success py-2 mt-3 mb-0" }, notice.value) : null, h("button", { class: "btn btn-outline-success btn-sm mt-3", disabled: saving.value, onClick: () => void save() }, saving.value ? "保存中…" : "追加金融实体类型")])]) : null,
    ]);
  },
});
