import { defineComponent, h, onMounted, ref } from "vue";

type Rule = { ruleId: string; source: { targetModule: string; targetField: string }; destination: { subject: string; field: "volume" | "pricePerUnit" } };
type Evidence = { candidateId: string; targetModule: string; targetField: string; statement: string; period: string | null; sourceName: string | null; title: string | null; sourceUrl: string | null; contentUrl: string | null; reusableEvidenceReference: { evidenceReferenceId: string } | null; informationId: string; versionId: string; docId: string; contentHash: string };
type Exposure = { companyTrackExposureId: string; trackProfileId: string; businessSegment: string; productScope: string; geographicScope: string; customerScope: string; status: string };
type Kpi = { kpiId: string; trackProfileId: string; name: string; definition: string; unit: string; frequency: string; timingRole: string; financialMapping: string };
type DriverSegment = { operatingDriverSegmentYearId: string; operatingSegmentId: string; volume: number; pricePerUnit: number };
type DriverYear = { fiscalYear: number; segments: DriverSegment[] };
type DriverPlan = { operatingDriverPlanId: string; scenarioName: string; version: number; amountScale: string; valuationCurrency: string; sourceReferences: unknown[]; years: DriverYear[] };
type Binding = { industryKpiDriverBindingId: string; industryKpiName: string; evidenceReferenceId: string; companyTrackExposureId: string; industryKpiId: string; operatingDriverPlanId: string; operatingDriverSegmentYearId: string; transmissionRuleId: string; inputValue: number; inputUnit: string; mappingNote: string; mappedBy: string; mappedAt: number; sourceReference: { url?: string; title?: string; locator?: string; informationId?: string; versionId?: string; documentId?: string } };
type Context = { code: string; canWriteLocally: boolean; rules: Rule[]; bindings: Binding[]; exposures: Exposure[]; kpis: Kpi[]; driverPlans: DriverPlan[]; eligibleEvidence: Evidence[]; limitations: string[] };
type Api = { code?: number; msg?: string; data?: Context | Record<string, unknown> };

const css = `.industry-kpi-bindings{margin-top:1rem;border-left:4px solid #2563eb}.kpi-binding-item{border-top:1px solid #dbe7e5;padding:.85rem 0}.kpi-binding-item:first-of-type{border-top:0}.kpi-binding-meta{display:flex;flex-wrap:wrap;gap:.35rem .75rem;color:#64748b;font-size:.78rem}.kpi-binding-chain{margin:.55rem 0;padding:.55rem .65rem;border-radius:.5rem;background:#f8fafc;color:#475569;font:normal .72rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.kpi-binding-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem;margin-top:.75rem;padding:.8rem;border:1px solid #bfdbfe;border-radius:.7rem;background:#f8fbff}.kpi-binding-form label{font-size:.78rem;color:#1e3a5f}.kpi-binding-form input,.kpi-binding-form select,.kpi-binding-form textarea{display:block;width:100%;margin-top:.2rem;padding:.42rem;border:1px solid #93c5fd;border-radius:.4rem;background:#fff}.kpi-binding-form textarea{min-height:4rem}.kpi-binding-form .wide{grid-column:1/-1}.kpi-projection{margin-top:.8rem;padding:.75rem;border-radius:.65rem;background:#f8fafc}.kpi-projection.ready{border-left:4px solid #0f766e}.kpi-projection.blocked{border-left:4px solid #dc2626}@media(max-width:700px){.kpi-binding-form{grid-template-columns:1fr}}`;

function text(value: unknown) { return value === null || value === undefined || value === "" ? "—" : String(value); }
function date(value: number) { return Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function short(value: string) { return value.length > 46 ? `${value.slice(0, 43)}…` : value; }
function ruleLabel(rule: Rule) { return `${rule.destination.field === "volume" ? "分部数量" : "单位价格"}（${rule.ruleId}）`; }

/** A binding UI deliberately offers only IDs returned by the read context. */
export const IndustryKpiDriverBindingsPanel = defineComponent({
  name: "IndustryKpiDriverBindingsPanel",
  props: { securityCode: { type: String, required: true }, canWrite: { type: Boolean, required: true } },
  setup(props) {
    const context = ref<Context | null>(null); const loading = ref(true); const error = ref(""); const saving = ref(false); const previewing = ref(false); const preview = ref<Record<string, unknown> | null>(null);
    const evidenceId = ref(""); const exposureId = ref(""); const kpiId = ref(""); const planId = ref(""); const segmentId = ref(""); const ruleId = ref(""); const inputValue = ref(""); const inputUnit = ref(""); const mappingNote = ref("");
    const wacc = ref("0.1"); const terminalGrowth = ref("0.03"); const netDebt = ref("0"); const dilutedShares = ref(""); const previewPlanId = ref("");
    const endpoint = () => `/api/research/company/${encodeURIComponent(props.securityCode)}/industry-kpi-driver-binding-context`;
    const load = async () => {
      loading.value = true; error.value = "";
      try { const response = await fetch(endpoint()); const body = await response.json() as Api; if (!response.ok || body.code !== 200 || !body.data) throw new Error(body.msg || "读取行业 KPI 绑定上下文失败"); context.value = body.data as Context; }
      catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };
    const selectedEvidence = () => context.value?.eligibleEvidence.find((item) => item.reusableEvidenceReference?.evidenceReferenceId === evidenceId.value) || null;
    const selectedExposure = () => context.value?.exposures.find((item) => item.companyTrackExposureId === exposureId.value) || null;
    const selectedPlan = () => context.value?.driverPlans.find((item) => item.operatingDriverPlanId === planId.value) || null;
    const previewPlan = () => context.value?.driverPlans.find((item) => item.operatingDriverPlanId === previewPlanId.value) || null;
    const rulesForEvidence = () => { const evidence = selectedEvidence(); return evidence ? (context.value?.rules || []).filter((rule) => rule.source.targetModule === evidence.targetModule && rule.source.targetField === evidence.targetField) : []; };
    const kpisForExposure = () => { const exposure = selectedExposure(); return exposure ? (context.value?.kpis || []).filter((item) => item.trackProfileId === exposure.trackProfileId) : []; };
    const segmentsForPlan = () => selectedPlan()?.years.flatMap((year) => year.segments.map((segment) => ({ ...segment, fiscalYear: year.fiscalYear }))) || [];
    const resetDependent = (field: "evidence" | "exposure" | "plan") => { if (field === "evidence") ruleId.value = ""; if (field === "exposure") kpiId.value = ""; if (field === "plan") segmentId.value = ""; };
    const save = async () => {
      const evidence = selectedEvidence();
      if (!evidence?.reusableEvidenceReference || !exposureId.value || !kpiId.value || !planId.value || !segmentId.value || !ruleId.value || !inputValue.value.trim() || !inputUnit.value.trim() || !mappingNote.value.trim()) { error.value = "请从已保存的证据、行业暴露、KPI、计划和分部段中完成所有映射，并填写值、单位与说明。"; return; }
      const value = Number(inputValue.value); if (!Number.isFinite(value)) { error.value = "输入值必须为有限数字。"; return; }
      saving.value = true; error.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/industry-kpi-driver-bindings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evidenceReferenceId: evidence.reusableEvidenceReference.evidenceReferenceId, companyTrackExposureId: exposureId.value, industryKpiId: kpiId.value, operatingDriverPlanId: planId.value, operatingDriverSegmentYearId: segmentId.value, transmissionRuleId: ruleId.value, inputValue: value, inputUnit: inputUnit.value.trim(), mappingNote: mappingNote.value.trim(), mappedBy: "local-user" }) });
        const body = await response.json() as Api; if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存行业 KPI 绑定失败");
        inputValue.value = ""; inputUnit.value = ""; mappingNote.value = ""; await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    const runPreview = async () => {
      const plan = previewPlan(); const shares = Number(dilutedShares.value); const payload = { wacc: Number(wacc.value), terminalGrowth: Number(terminalGrowth.value), netDebtAtValuation: Number(netDebt.value), dilutedShares: shares, sourceReferences: plan?.sourceReferences || [] };
      if (!plan || !Number.isFinite(payload.wacc) || !Number.isFinite(payload.terminalGrowth) || !Number.isFinite(payload.netDebtAtValuation) || !Number.isFinite(shares) || shares <= 0) { error.value = "选择已有驱动计划，并填写有效 WACC、永续增长、估值日净债务和稀释股数后才能预览。"; return; }
      previewing.value = true; error.value = "";
      try { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/operating-driver-plans/${encodeURIComponent(plan.operatingDriverPlanId)}/industry-kpi-projection`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ valuation: payload }) }); const body = await response.json() as Api; if (!response.ok || body.code !== 200 || !body.data) throw new Error(body.msg || "计算绑定传导预览失败"); preview.value = body.data as Record<string, unknown>; }
      catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { previewing.value = false; }
    };
    onMounted(() => { void load(); });
    const source = (binding: Binding) => { const ref = binding.sourceReference; return ref.url ? h("a", { class: "evidence-link", href: ref.url, target: "_blank", rel: "noreferrer" }, ref.title || ref.url) : h("span", ref.title || "来源链接待补"); };
    return () => {
      const ctx = context.value; const localWrite = Boolean(props.canWrite && ctx?.canWriteLocally);
      return h("section", { class: "research-card industry-kpi-bindings" }, [
        h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "行业 KPI → 分部驱动 → 财务传导"), h("p", { class: "research-meta mb-0" }, "只有人工选择的已接受来源、行业 KPI、公司暴露和分部计划段可建立绑定。数值不从原文自动抽取；绑定不会改写历史计划。")]), h("span", { class: "research-state" }, localWrite ? "本地可绑定" : "只读")]),
        error.value ? h("div", { class: "alert alert-warning py-2 mt-3 mb-0" }, [error.value, h("button", { class: "btn btn-link btn-sm py-0 ms-2", onClick: () => void load() }, "重试")]) : null,
        loading.value ? h("p", { class: "research-meta mt-3 mb-0" }, "正在读取绑定账本和可选上下文…") : null,
        !loading.value && ctx ? [
          !ctx.bindings.length ? h("div", { class: "research-note mt-3" }, "尚无已保存的 KPI 传导绑定。缺少已接受证据、公司行业暴露、KPI 定义或分部计划时，界面不会猜测或补造 ID。") : null,
          ...ctx.bindings.map((binding) => { const rule = ctx.rules.find((item) => item.ruleId === binding.transmissionRuleId); return h("article", { class: "kpi-binding-item", key: binding.industryKpiDriverBindingId }, [h("div", { class: "d-flex justify-content-between gap-2 align-items-start" }, [h("div", [h("strong", `${binding.industryKpiName} → ${rule ? ruleLabel(rule) : binding.transmissionRuleId}`), h("div", { class: "mt-1" }, source(binding))]), h("span", { class: "research-state" }, "不可变绑定")]), h("div", { class: "kpi-binding-meta mt-2" }, [`输入：${binding.inputValue} ${binding.inputUnit}`, `计划：${short(binding.operatingDriverPlanId)}`, `分部段：${short(binding.operatingDriverSegmentYearId)}`, `映射人：${binding.mappedBy}`, `时间：${date(binding.mappedAt)}`].map((item) => h("span", item))), h("p", { class: "small mt-2 mb-1" }, binding.mappingNote), h("div", { class: "kpi-binding-chain", title: binding.sourceReference.locator || "" }, `evidence ${short(binding.evidenceReferenceId)} · information ${short(binding.sourceReference.informationId || "—")} · version ${short(binding.sourceReference.versionId || "—")} · document ${short(binding.sourceReference.documentId || "—")}`)]); }),
          localWrite ? h("div", { class: "kpi-binding-form" }, [
            h("label", ["已接受来源证据", h("select", { value: evidenceId.value, onChange: (event: Event) => { evidenceId.value = (event.target as HTMLSelectElement).value; resetDependent("evidence"); } }, [h("option", { value: "" }, "选择可复用来源引用"), ...ctx.eligibleEvidence.map((item) => h("option", { value: item.reusableEvidenceReference?.evidenceReferenceId || "" }, `${item.targetModule}.${item.targetField} · ${item.period || "期间待补"} · ${item.title || item.sourceName || item.candidateId}`))])]),
            h("label", ["直接传导规则", h("select", { value: ruleId.value, onChange: (event: Event) => ruleId.value = (event.target as HTMLSelectElement).value, disabled: !rulesForEvidence().length }, [h("option", { value: "" }, rulesForEvidence().length ? "选择匹配证据的配置规则" : "该证据没有直接传导规则"), ...rulesForEvidence().map((rule) => h("option", { value: rule.ruleId }, ruleLabel(rule)))])]),
            h("label", ["公司行业暴露", h("select", { value: exposureId.value, onChange: (event: Event) => { exposureId.value = (event.target as HTMLSelectElement).value; resetDependent("exposure"); } }, [h("option", { value: "" }, "选择已保存的公司行业暴露"), ...ctx.exposures.map((item) => h("option", { value: item.companyTrackExposureId }, `${item.businessSegment} · ${item.productScope} · ${item.companyTrackExposureId}`))])]),
            h("label", ["行业 KPI", h("select", { value: kpiId.value, onChange: (event: Event) => kpiId.value = (event.target as HTMLSelectElement).value, disabled: !kpisForExposure().length }, [h("option", { value: "" }, kpisForExposure().length ? "选择该行业轨道已保存 KPI" : "该暴露的行业轨道没有 KPI 定义"), ...kpisForExposure().map((item) => h("option", { value: item.kpiId }, `${item.name} · ${item.unit} · ${item.frequency}`))])]),
            h("label", ["分部驱动计划", h("select", { value: planId.value, onChange: (event: Event) => { planId.value = (event.target as HTMLSelectElement).value; resetDependent("plan"); } }, [h("option", { value: "" }, "选择已保存驱动计划"), ...ctx.driverPlans.map((item) => h("option", { value: item.operatingDriverPlanId }, `${item.scenarioName} v${item.version} · ${item.operatingDriverPlanId}`))])]),
            h("label", ["计划分部年度段", h("select", { value: segmentId.value, onChange: (event: Event) => segmentId.value = (event.target as HTMLSelectElement).value, disabled: !segmentsForPlan().length }, [h("option", { value: "" }, segmentsForPlan().length ? "选择已保存分部年度段" : "先选择驱动计划"), ...segmentsForPlan().map((item) => h("option", { value: item.operatingDriverSegmentYearId }, `${item.fiscalYear} · ${item.operatingSegmentId} · volume ${item.volume} / price ${item.pricePerUnit}`))])]),
            h("label", ["人工确认输入值", h("input", { type: "number", step: "any", value: inputValue.value, onInput: (event: Event) => inputValue.value = (event.target as HTMLInputElement).value })]), h("label", ["输入单位（原始口径）", h("input", { value: inputUnit.value, onInput: (event: Event) => inputUnit.value = (event.target as HTMLInputElement).value, placeholder: "例如：台、端口、CNY/单位" })]),
            h("label", { class: "wide" }, ["人工映射说明（范围、期间、单位和为何可直传）", h("textarea", { value: mappingNote.value, onInput: (event: Event) => mappingNote.value = (event.target as HTMLTextAreaElement).value })]), h("div", { class: "wide" }, h("button", { class: "btn btn-primary btn-sm", disabled: saving.value, onClick: () => void save() }, saving.value ? "保存中…" : "追加不可变 KPI 绑定")),
          ]) : h("div", { class: "research-note mt-3" }, "生产环境只展示已保存绑定与来源链；创建、候选选择和本地传导预览仅可在本地研究运行时进行。"),
          localWrite && ctx.driverPlans.length ? h("div", { class: "kpi-projection" }, [h("h3", "确定性传导预览（不保存估值输入）"), h("p", { class: "research-meta" }, "预览只读取当前计划中保存的字段与上述不可变绑定；未绑定字段明确标识为该计划版本值。WACC 等仅用于本次可复算输出，不会写入估值模型。"), h("div", { class: "kpi-binding-form" }, [h("label", ["驱动计划", h("select", { value: previewPlanId.value, onChange: (event: Event) => previewPlanId.value = (event.target as HTMLSelectElement).value }, [h("option", { value: "" }, "选择计划"), ...ctx.driverPlans.map((item) => h("option", { value: item.operatingDriverPlanId }, `${item.scenarioName} v${item.version}`))])]), h("label", ["WACC", h("input", { type: "number", step: "any", value: wacc.value, onInput: (event: Event) => wacc.value = (event.target as HTMLInputElement).value })]), h("label", ["永续增长", h("input", { type: "number", step: "any", value: terminalGrowth.value, onInput: (event: Event) => terminalGrowth.value = (event.target as HTMLInputElement).value })]), h("label", ["估值日净债务", h("input", { type: "number", step: "any", value: netDebt.value, onInput: (event: Event) => netDebt.value = (event.target as HTMLInputElement).value })]), h("label", ["稀释股数", h("input", { type: "number", step: "any", value: dilutedShares.value, onInput: (event: Event) => dilutedShares.value = (event.target as HTMLInputElement).value })]), h("div", { class: "wide" }, h("button", { class: "btn btn-outline-primary btn-sm", disabled: previewing.value, onClick: () => void runPreview() }, previewing.value ? "计算中…" : "计算传导预览"))]), preview.value ? projectionView(preview.value) : null]) : null,
          ctx.limitations.length ? h("p", { class: "research-meta small mt-3 mb-0" }, ctx.limitations.join(" ")) : null,
        ] : null,
      ]);
    };
  },
});

function projectionView(result: Record<string, unknown>) {
  const coverage = Array.isArray(result.coverage) ? result.coverage as Array<Record<string, unknown>> : [];
  const annuals = Array.isArray((result.valuationProjection as Record<string, unknown> | null)?.annuals) ? ((result.valuationProjection as Record<string, unknown>).annuals as Array<Record<string, unknown>>) : [];
  const annualTable = annuals.length ? h("div", { class: "table-responsive mt-2" }, h("table", { class: "table table-sm research-table mb-0" }, [
    h("thead", h("tr", ["年度", "收入", "EBIT", "UFCF"].map((label) => h("th", label)))),
    h("tbody", annuals.map((item) => h("tr", [
      h("td", text(item.fiscalYear)), h("td", text(item.revenue)), h("td", text(item.ebit)), h("td", text(item.unleveredFreeCashFlow)),
    ]))),
  ])) : null;
  return h("div", { class: `kpi-projection ${result.state === "ready" ? "ready" : "blocked"}` }, [
    h("strong", result.state === "ready" ? "传导已可复算" : "传导已阻断"),
    h("p", { class: "small mb-2 mt-1" }, text(result.reason || (result.state === "ready" ? "所有已绑定字段已按配置规则进入分部驱动。" : "需要处理冲突。"))),
    h("div", { class: "kpi-binding-meta" }, coverage.map((item) => h("span", `${item.field} · ${item.state} · ${item.effectiveValue ?? "—"}`))),
    annualTable,
  ]);
}
