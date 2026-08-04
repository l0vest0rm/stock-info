import { defineComponent, h, ref } from "vue";

type Mode = "track" | "exposure" | "peers";
type Form = Record<string, string>;

const styles = `.industry-workbench{margin-top:1rem}.industry-tabs{display:flex;flex-wrap:wrap;gap:.45rem}.industry-tabs button{border:1px solid #b9d0cc;background:#fff;border-radius:999px;padding:.32rem .7rem;color:#28534f;font-size:.8rem}.industry-tabs button.active{background:#0f766e;border-color:#0f766e;color:#fff}.industry-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.65rem}.industry-form label{font-size:.76rem;color:#365653}.industry-form input,.industry-form select,.industry-form textarea{display:block;width:100%;margin-top:.18rem;padding:.42rem;border:1px solid #c6d5d2;border-radius:.42rem;background:#fff}.industry-form textarea{min-height:4.5rem}.industry-form .wide{grid-column:1/-1}.industry-boundary{border-left:4px solid #0f766e;background:#f7fffd}.industry-help{font-size:.8rem;color:#526b68}@media(max-width:800px){.industry-form{grid-template-columns:1fr}}`;

const labels: Record<Mode, string> = { track: "行业 profile", exposure: "公司业务暴露", peers: "同行比较集" };
const empty = (): Form => ({
  sourceUrl: "", sourceTitle: "", industryKey: "", taxonomy: "internal", taxonomyVersion: "1", industryName: "", boundaryIncluded: "", boundaryExcluded: "", demandEquation: "", supplyEquation: "", cyclePosition: "not_assessed", valuationPrimaryMethod: "", valuationLimitations: "", version: "1",
  trackProfileId: "", selectionBasis: "primary_business", businessSegment: "", productScope: "", geographicScope: "", customerScope: "", exposureDescription: "", exposureMeasure: "revenue", exposureValue: "", exposureUnit: "percent", exposurePeriod: "", exposureDenominator: "",
  comparisonPurpose: "operating_model", selectionCriteria: "", peerName: "", peerSecurityCode: "", peerRelationship: "direct", membershipStatus: "included", comparabilityStatus: "comparable", exclusionReason: "", comparisonDimension: "business_model", comparisonStatus: "aligned", targetValue: "", peerValue: "", adjustmentNote: "",
});

export const IndustryComparabilityWorkbench = defineComponent({
  name: "IndustryComparabilityWorkbench",
  props: { securityCode: { type: String, required: true }, companyId: { type: String, default: "" }, canWrite: { type: Boolean, default: false } },
  setup(props) {
    const mode = ref<Mode>("track"); const form = ref<Form>(empty()); const saving = ref(false); const error = ref(""); const saved = ref("");
    const update = (key: string, value: string) => { form.value = { ...form.value, [key]: value }; };
    const source = () => {
      const url = required(form.value.sourceUrl, "来源链接");
      return [{ sourceKind: "external_url", url, title: form.value.sourceTitle.trim() || url, publishedAt: Date.now() }];
    };
    const save = async () => {
      saving.value = true; error.value = ""; saved.value = "";
      try {
        const now = Date.now(); const refs = source(); let endpoint = ""; let body: Record<string, unknown>;
        if (mode.value === "track") {
          const id = `track:${required(form.value.industryKey, "行业键")}:${now}`;
          endpoint = "/api/research/industry/tracks";
          body = { trackProfileId: id, industryKey: required(form.value.industryKey, "行业键"), taxonomy: required(form.value.taxonomy, "分类体系"), taxonomyVersion: required(form.value.taxonomyVersion, "分类版本"), industryName: required(form.value.industryName, "行业名称"), parentIndustryKey: null, asOf: now, version: integer(form.value.version, "版本"), status: "draft", boundaryIncluded: required(form.value.boundaryIncluded, "包含边界"), boundaryExcluded: required(form.value.boundaryExcluded, "排除边界"), demandEquation: nullable(form.value.demandEquation), supplyEquation: nullable(form.value.supplyEquation), cyclePosition: form.value.cyclePosition, valuationPrimaryMethod: nullable(form.value.valuationPrimaryMethod), valuationLimitations: nullable(form.value.valuationLimitations), epistemicType: "observed_fact", sourceReferences: refs, demandDrivers: [], supplyConstraints: [], valueChainNodes: [], kpis: [], createdAt: now, updatedAt: now };
          saved.value = `已保存行业 profile。请复制其 ID 用于下方公司暴露与同行集：${id}`;
        } else if (mode.value === "exposure") {
          const id = `track-exposure:${props.securityCode}:${now}`;
          endpoint = `/api/research/company/${encodeURIComponent(props.securityCode)}/industry-exposures`;
          body = { companyTrackExposureId: id, companyId: required(props.companyId, "已确认经营公司映射"), trackProfileId: required(form.value.trackProfileId, "行业 profile ID"), asOf: now, version: integer(form.value.version, "版本"), status: "draft", selectionBasis: form.value.selectionBasis, businessSegment: required(form.value.businessSegment, "业务分部"), productScope: required(form.value.productScope, "产品范围"), geographicScope: required(form.value.geographicScope, "地区范围"), customerScope: required(form.value.customerScope, "客户范围"), exposureDescription: required(form.value.exposureDescription, "暴露说明"), epistemicType: "observed_fact", sourceReferences: refs, shares: [{ exposureShareId: `${id}:share:1`, measure: form.value.exposureMeasure, value: nonNegative(form.value.exposureValue, "归属占比"), unit: form.value.exposureUnit, basisPeriod: required(form.value.exposurePeriod, "占比期间"), denominatorDescription: nullable(form.value.exposureDenominator), sortOrder: 1, sourceReferences: refs }], createdAt: now, updatedAt: now };
          saved.value = "已保存公司业务暴露版本。";
        } else {
          const id = `peer-set:${props.securityCode}:${now}`; const member = `${id}:member:1`;
          endpoint = `/api/research/company/${encodeURIComponent(props.securityCode)}/peer-comparison-sets`;
          body = { peerComparisonSetId: id, companyId: required(props.companyId, "已确认经营公司映射"), trackProfileId: required(form.value.trackProfileId, "行业 profile ID"), asOf: now, version: integer(form.value.version, "版本"), status: "draft", comparisonPurpose: form.value.comparisonPurpose, selectionCriteria: required(form.value.selectionCriteria, "选择标准"), epistemicType: "observed_fact", sourceReferences: refs, members: [{ peerComparisonMemberId: member, companyId: null, securityCode: nullable(form.value.peerSecurityCode), peerName: required(form.value.peerName, "同行名称"), relationshipType: form.value.peerRelationship, membershipStatus: form.value.membershipStatus, comparabilityStatus: form.value.comparabilityStatus, exclusionReason: form.value.membershipStatus === "excluded" ? required(form.value.exclusionReason, "排除理由") : nullable(form.value.exclusionReason), sortOrder: 1, sourceReferences: refs, dimensions: [{ comparisonDimensionId: `${member}:dimension:1`, dimension: form.value.comparisonDimension, status: form.value.comparisonStatus, targetValue: nullable(form.value.targetValue), peerValue: nullable(form.value.peerValue), adjustmentNote: form.value.comparisonStatus === "adjustment_required" ? required(form.value.adjustmentNote, "调整说明") : nullable(form.value.adjustmentNote), sortOrder: 1, sourceReferences: refs }] }], createdAt: now, updatedAt: now };
          saved.value = "已保存同行比较集版本。新增同行或维度请以新的版本重新提交，历史不会被覆盖。";
        }
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存失败");
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); saved.value = ""; }
      finally { saving.value = false; }
    };
    return () => h("section", { class: "research-card industry-workbench industry-boundary" }, [h("style", styles), h("div", { class: "section-head" }, [h("div", [h("h2", "字段化行业与同行工作台"), h("p", { class: "research-meta mb-0" }, "每一项均以来源证据、版本和边界保存；不会回落到旧 JSON 档案，也不会把标签当成可比性。")]), h("span", { class: "research-state" }, "公共研究")]),
      h("div", { class: "industry-tabs mt-3" }, (Object.keys(labels) as Mode[]).map((key) => h("button", { class: mode.value === key ? "active" : "", onClick: () => { mode.value = key; error.value = ""; saved.value = ""; } }, labels[key]))),
      h("p", { class: "industry-help mt-3" }, mode.value === "track" ? "先定义赛道边界，随后可用生成的 profile ID 绑定公司主营暴露与同行集。" : mode.value === "exposure" ? "必须先存在确认/暂定的经营公司映射；归属占比和其期间均需有同一来源证据。" : "每份同行集至少保存一个成员和一个可比维度；排除成员必须写明原因，需调整维度必须写明调整方法。"),
      h("div", { class: "industry-form mt-2" }, fields(mode.value, form.value, update)),
      !props.canWrite ? h("div", { class: "research-note mt-3" }, "生产环境只读；字段化研究写入仅可在本地研究运行时执行。") : h("button", { class: "btn btn-success mt-3", disabled: saving.value, onClick: () => void save() }, saving.value ? "保存中…" : `保存${labels[mode.value]}版本`),
      error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null, saved.value ? h("div", { class: "alert alert-success py-2 mt-3 mb-0" }, saved.value) : null,
    ]);
  },
});

function fields(mode: Mode, form: Form, update: (key: string, value: string) => void) {
  const input = (label: string, key: string, type = "text", wide = false) => h("label", { class: wide ? "wide" : "" }, [label, type === "textarea" ? h("textarea", { value: form[key], onInput: (event: Event) => update(key, (event.target as HTMLTextAreaElement).value) }) : h("input", { type, value: form[key], onInput: (event: Event) => update(key, (event.target as HTMLInputElement).value) })]);
  const select = (label: string, key: string, choices: string[]) => h("label", [label, h("select", { value: form[key], onChange: (event: Event) => update(key, (event.target as HTMLSelectElement).value) }, choices.map((value) => h("option", { value }, value)))]);
  const evidence = [input("来源链接", "sourceUrl", "url"), input("来源标题（可选）", "sourceTitle")];
  if (mode === "track") return [...evidence, input("行业键", "industryKey"), input("行业名称", "industryName"), input("分类体系", "taxonomy"), input("分类版本", "taxonomyVersion"), input("版本", "version", "number"), select("周期位置", "cyclePosition", ["not_assessed", "trough", "recovery", "expansion", "peak", "contraction", "structurally_non_cyclical"]), input("包含边界", "boundaryIncluded", "textarea", true), input("排除边界", "boundaryExcluded", "textarea", true), input("需求方程（可选）", "demandEquation", "textarea", true), input("供给方程（可选）", "supplyEquation", "textarea", true), input("优先估值方法（可选）", "valuationPrimaryMethod"), input("估值限制（可选）", "valuationLimitations")];
  if (mode === "exposure") return [...evidence, input("行业 profile ID", "trackProfileId", "text", true), select("选择依据", "selectionBasis", ["primary_business", "secondary_business"]), input("业务分部", "businessSegment"), input("产品范围", "productScope"), input("地区范围", "geographicScope"), input("客户范围", "customerScope"), input("版本", "version", "number"), input("业务暴露说明", "exposureDescription", "textarea", true), select("归属指标", "exposureMeasure", ["revenue", "gross_profit", "operating_profit", "assets", "volume", "other"]), input("归属数值", "exposureValue", "number"), select("数值单位", "exposureUnit", ["percent", "ratio", "currency", "units"]), input("归属期间", "exposurePeriod"), input("分母/计算说明（可选）", "exposureDenominator", "textarea", true)];
  return [...evidence, input("行业 profile ID", "trackProfileId", "text", true), select("比较目的", "comparisonPurpose", ["operating_model", "financial_quality", "valuation_context", "competitive_context"]), input("选择标准", "selectionCriteria", "textarea", true), input("版本", "version", "number"), input("同行名称", "peerName"), input("同行证券代码（可选）", "peerSecurityCode"), select("竞争关系", "peerRelationship", ["direct", "adjacent", "substitute", "upstream", "downstream", "benchmark"]), select("成员状态", "membershipStatus", ["included", "excluded", "watchlist"]), select("可比状态", "comparabilityStatus", ["comparable", "partially_comparable", "not_comparable", "unreviewed"]), input("排除理由（排除必填）", "exclusionReason", "textarea", true), select("可比维度", "comparisonDimension", ["business_model", "product_scope", "customer_scope", "geography", "reporting_currency", "accounting_basis", "fiscal_year", "capital_intensity", "cycle_position", "security_rights"]), select("维度状态", "comparisonStatus", ["aligned", "adjustment_required", "not_comparable", "not_assessed"]), input("本公司值（可选）", "targetValue"), input("同行值（可选）", "peerValue"), input("调整说明（需调整必填）", "adjustmentNote", "textarea", true)];
}

function required(value: string, label: string) { const result = value.trim(); if (!result) throw new Error(`${label}不能为空`); return result; }
function nullable(value: string) { return value.trim() || null; }
function integer(value: string, label: string) { const result = Number(value); if (!Number.isInteger(result) || result <= 0) throw new Error(`${label}必须为正整数`); return result; }
function nonNegative(value: string, label: string) { const result = Number(value); if (!Number.isFinite(result) || result < 0) throw new Error(`${label}必须为非负数`); return result; }
