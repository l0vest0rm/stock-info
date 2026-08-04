import { defineComponent, h, ref } from "vue";

type R = Record<string, any>;
const labels: R = { key_driver: "关键驱动", specialty_kpi: "专属 KPI", product_customer_geography: "产品、客户与地区", thesis: "研究命题", management_capital: "管理层与资本配置", event: "事件", risk_or_invalidation: "风险与证伪", security_structure: "证券结构" };
const allowed: R = {
  key_driver: ["operating_model", "operating_driver_plan", "operating_source_fact", "industry_kpi_driver_binding"], specialty_kpi: ["operating_source_fact", "financial_specialty_fact"], product_customer_geography: ["operating_segment", "operating_source_fact", "risk_relationship"], thesis: ["research_thesis"], management_capital: ["governance_record", "governance_capital_fact"], event: ["research_catalyst"], risk_or_invalidation: ["research_risk", "risk_relationship", "research_thesis"], security_structure: ["market_structure_fact"],
};
function candidates(data: R): R[] {
  const output: R[] = []; const add = (kind: string, rows: any[], id: string, title: string, security = "") => rows.forEach((item) => output.push({ kind, id: item[id], title: item[title] || item.statement || item.summary || item[id], securityCode: security ? item[security] || null : null }));
  add("operating_model", data.operating?.models?.items || [], "operatingModelId", "primaryEarningDriver"); add("operating_driver_plan", data.operating?.driverPlans?.items || [], "operatingDriverPlanId", "scenarioName"); add("operating_source_fact", data.operating?.sourceFacts?.items || [], "operatingSourceFactId", "subjectLabel", "sourceSecurityCode");
  add("financial_specialty_fact", data.financials?.specialtyMetrics?.facts || [], "financialSpecialtyFactId", "reportedLabel", "securityCode"); add("research_thesis", data.dossier?.theses?.items || [], "thesisId", "title"); add("governance_record", data.governance?.items || [], "governanceRecordId", "title"); add("governance_capital_fact", data.governanceCapitalFacts?.latestFacts || [], "governanceCapitalFactVersionId", "factKey", "securityCode"); add("research_catalyst", data.dossier?.catalysts?.items || [], "catalystId", "title", "securityCode"); add("research_risk", data.dossier?.risks?.items || [], "riskId", "title", "securityCode"); add("risk_relationship", data.riskReview?.relationships || [], "relationshipId", "counterpartyName", "securityCode"); add("market_structure_fact", data.marketStructure?.auditableFacts || [], "marketStructureFactId", "factKey", "securityCode");
  return output.filter((item) => item.id);
}
export const CompanyFocusProfilePanel = defineComponent({ props: { securityCode: { type: String, required: true }, initial: { type: Object, required: true }, data: { type: Object, required: true }, canWrite: Boolean, onSaved: Function }, setup(props) {
  const busy = ref(false); const error = ref(""); const title = ref(""); const role = ref("key_driver"); const selected = ref<string[]>([]); const draftItems = ref<R[]>([]); const rows = candidates(props.data as R);
  const post = async (path: string, body: R) => { busy.value = true; error.value = ""; try { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存失败"); props.onSaved?.(); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { busy.value = false; } };
  return () => { const view = props.initial as R; const profile = view.profile as R | null; const membership = view.membership as R | null; const applicable = rows.filter((item) => (allowed[role.value] || []).includes(item.kind));
    const content = profile ? [h("p", { class: "research-meta" }, `公共档案 v${profile.version} · ${profile.status} · 截止 ${new Date(profile.asOf).toLocaleDateString("zh-CN")}；仅引用已有账本，不复制或改写事实。`), ...profile.items.map((item: R) => h("article", { class: "record" }, [h("strong", `${labels[item.role] || item.role} · ${item.target?.title || item.targetKind}`), h("p", { class: "research-meta mb-0" }, item.target?.summary || item.target?.statement || item.unavailableReason || `引用 ${item.targetId}`), item.target?.securityCode ? h("small", { class: "research-meta" }, `证券：${item.target.securityCode}`) : null]))] : [h("div", { class: "research-note mt-2" }, membership?.status === "active" ? "已选入当前用户的重点研究范围，等待建立来源绑定的公共侧重档案；这不影响通用研究完成状态。" : "未进入当前用户重点研究范围；该选择不影响通用、市场或行业研究完成状态。")];
    const editor = props.canWrite ? h("details", { class: "mt-3", "data-research-workbench": "company-focus-profile" }, [
      h("summary", "本地工作台：维护侧重档案（只选择已有、带证据的记录）"),
      h("div", { class: "mt-2" }, [
        h("button", { class: "btn btn-outline-primary btn-sm me-2", disabled: busy.value, onClick: () => void post("focus-membership", { ownerKey: "local-user", status: membership?.status === "active" ? "removed" : "active" }) }, membership?.status === "active" ? "移出重点范围" : "选入重点范围"),
        h("div", { class: "row g-2 mt-1" }, [
          h("label", { class: "col-md-4 small" }, ["档案标题", h("input", { class: "form-control form-control-sm", value: title.value, onInput: (e: Event) => title.value = (e.target as HTMLInputElement).value })]),
          h("label", { class: "col-md-4 small" }, ["角色", h("select", { class: "form-select form-select-sm", value: role.value, onChange: (e: Event) => { role.value = (e.target as HTMLSelectElement).value; selected.value = []; } }, Object.entries(labels).map(([key, value]) => h("option", { value: key }, value)))]),
          h("label", { class: "col-md-12 small" }, ["选择已有受证据约束记录（可多选）", h("select", { class: "form-select form-select-sm", multiple: true, size: 6, value: selected.value, onChange: (e: Event) => selected.value = [...(e.target as HTMLSelectElement).selectedOptions].map((option) => option.value) }, applicable.map((item) => h("option", { value: `${item.kind}|${item.id}|${item.securityCode || ""}` }, `${item.kind} · ${item.title}`)))])
        ]),
        h("button", { class: "btn btn-outline-success btn-sm mt-2", disabled: !selected.value.length, onClick: () => {
          const additions = selected.value.map((value) => { const [targetKind, targetId, securityCode] = value.split("|"); return { role: role.value, targetKind, targetId, securityCode: securityCode || null }; });
          const known = new Set(draftItems.value.map((item) => `${item.role}:${item.targetKind}:${item.targetId}`));
          draftItems.value = [...draftItems.value, ...additions.filter((item) => !known.has(`${item.role}:${item.targetKind}:${item.targetId}`))]; selected.value = [];
        } }, "加入此版本草稿"),
        draftItems.value.length ? h("ul", { class: "research-list small mt-2 mb-2" }, draftItems.value.map((item, index) => h("li", [
          `${labels[item.role] || item.role} · ${item.targetKind} · ${item.targetId} `,
          h("button", { class: "btn btn-link btn-sm p-0", onClick: () => { draftItems.value = draftItems.value.filter((_, candidateIndex) => candidateIndex !== index); } }, "移除"),
        ]))) : h("p", { class: "research-meta small mt-2 mb-0" }, "可分别选择不同角色的现有记录，加入同一个不可变档案版本。"),
        h("button", { class: "btn btn-success btn-sm mt-2", disabled: busy.value || !title.value.trim() || !draftItems.value.length, onClick: () => void post("focus-profiles", { title: title.value, status: "draft", items: draftItems.value.map((item, index) => ({ ...item, sortOrder: index })) }) }, busy.value ? "保存中…" : "建立新的公共档案版本"),
        error.value ? h("div", { class: "alert alert-danger py-2 mt-2 mb-0" }, error.value) : null,
      ]),
    ]) : null;
    return h("section", { class: `research-card section-card ${view.availability || "empty"}`, "aria-label": "重点公司档案" }, [h("div", { class: "section-head" }, [h("div", [h("h2", "重点公司档案"), h("p", { class: "research-meta mb-0" }, "个人选入与公共研究严格分开；公共档案是对已审计记录的版本化引用图。")]), h("span", { class: "research-state" }, profile ? `公共 v${profile.version}` : "可选增强")]), ...content, editor]);
  };
} });
