import { computed, defineComponent, h, ref } from "vue";

type SourceKind = "knowledge_record" | "knowledge_document" | "filing" | "market_data" | "external_url" | "dossier_record" | "research_record";
type InputKind = "source_fact" | "forward_input" | "assumption";
type SubjectKind = "target" | "peer";
type GateKind = "accounting_basis" | "fiscal_period" | "currency" | "business_scope" | "cycle_position" | "security_rights";
type GateStatus = "passed" | "adjustment_required" | "blocked" | "not_assessed";
type Value = Record<string, unknown>;

type SourceForm = { sourceKind: SourceKind; url: string; title: string; locator: string };
type InputForm = {
  id: string; subjectKind: SubjectKind; peerMemberId: string; inputKind: InputKind; key: string; label: string;
  value: string; unit: string; currency: string; amountScale: string; fiscalYear: string; periodLabel: string; asOf: string;
  epistemicType: "observed_fact" | "management_guidance" | "third_party_forecast" | "analysis_assumption"; source: SourceForm;
};
type MetricForm = {
  id: string; subjectKind: SubjectKind; peerMemberId: string; metricType: string; periodBasis: "trailing" | "forward" | "normalized" | "other";
  fiscalYear: string; definition: string; numeratorInputId: string; denominatorInputId: string; displayUnit: string;
};
type GateForm = { gateKind: GateKind; status: GateStatus; rationale: string; source: SourceForm };
type LedgerForm = {
  role: "primary" | "auxiliary"; archetype: string; method: string; peerUniverseId: string; valuationCurrency: string; securityCurrency: string;
  status: "draft" | "reviewed"; applicabilityRationale: string; rationaleSource: SourceForm; supersedesLedgerId: string; inputs: InputForm[]; metrics: MetricForm[]; gates: GateForm[];
};

const archetypes = [["growth_earnings", "成长盈利"], ["stable_cash_dividend", "稳定现金/分红"], ["cyclical_commodity", "周期/商品"], ["bank", "银行"], ["insurer_broker", "保险/券商"], ["asset_utility", "资产/公用事业"], ["pre_profit_milestone", "未盈利里程碑"], ["conglomerate_sotp", "多元业务/SOTP"], ["other", "其他"]] as const;
const methods = [["forward_pe", "远期 PE"], ["ev_ebitda", "EV/EBITDA"], ["ev_revenue", "EV/收入"], ["pb_roe", "PB/ROE"], ["pb", "PB"], ["fcf_yield", "FCF 收益率"], ["dividend_yield", "股息率"], ["nav", "NAV"], ["price_to_embedded_value", "价格/内含价值"], ["other", "其他"]] as const;
const metricTypes = [["pe", "PE"], ["ev_ebitda", "EV/EBITDA"], ["ev_revenue", "EV/收入"], ["pb", "PB"], ["fcf_yield", "FCF 收益率"], ["dividend_yield", "股息率"], ["nav", "NAV"], ["other", "其他"]] as const;
const gateLabels: Record<GateKind, string> = { accounting_basis: "会计口径", fiscal_period: "财年/期间", currency: "币种", business_scope: "业务范围", cycle_position: "周期位置", security_rights: "证券权利" };
const sourceKinds: ReadonlyArray<readonly [SourceKind, string]> = [["filing", "正式披露/文件"], ["knowledge_document", "知识账本文档"], ["knowledge_record", "知识账本记录"], ["market_data", "市场数据"], ["external_url", "外部原始链接"], ["dossier_record", "研究档案记录"], ["research_record", "研究工作台记录"]];

const css = `.relative-valuation-workbench{border-left:4px solid #7c3aed}.relative-valuation-workbench .rv-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.65rem}.relative-valuation-workbench .rv-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.relative-valuation-workbench .rv-card{border:1px solid #ddd6fe;border-radius:.7rem;padding:.75rem;margin-top:.7rem;background:#fafaff}.relative-valuation-workbench label{display:grid;gap:.22rem;font-size:.78rem;color:#374151}.relative-valuation-workbench input,.relative-valuation-workbench select,.relative-valuation-workbench textarea{width:100%;padding:.38rem;border:1px solid #c4b5fd;border-radius:.4rem;background:#fff}.relative-valuation-workbench textarea{min-height:4.4rem}.relative-valuation-workbench .wide{grid-column:1/-1}.relative-valuation-workbench .rv-row{display:flex;justify-content:space-between;gap:.7rem;align-items:center}.relative-valuation-workbench .rv-result{font:600 .88rem ui-monospace,SFMono-Regular,Menlo,monospace;color:#312e81}.relative-valuation-workbench .rv-gate.blocked{border-left:3px solid #dc2626}.relative-valuation-workbench .rv-gate.adjustment_required{border-left:3px solid #d97706}.relative-valuation-workbench .rv-gate.passed{border-left:3px solid #059669}@media(max-width:800px){.relative-valuation-workbench .rv-grid,.relative-valuation-workbench .rv-grid.two{grid-template-columns:1fr}}`;

const nowDate = () => new Date().toISOString().slice(0, 10);
const emptySource = (): SourceForm => ({ sourceKind: "filing", url: "", title: "", locator: "" });
const newInput = (subjectKind: SubjectKind, peerMemberId = "", kind: InputKind = "source_fact"): InputForm => ({
  id: crypto.randomUUID(), subjectKind, peerMemberId, inputKind: kind, key: "", label: "", value: "", unit: "", currency: "", amountScale: "", fiscalYear: kind === "forward_input" ? String(new Date().getFullYear() + 1) : "", periodLabel: "", asOf: nowDate(), epistemicType: kind === "source_fact" ? "observed_fact" : kind === "assumption" ? "analysis_assumption" : "third_party_forecast", source: emptySource(),
});
const newMetric = (subjectKind: SubjectKind, peerMemberId = ""): MetricForm => ({ id: crypto.randomUUID(), subjectKind, peerMemberId, metricType: "pe", periodBasis: "forward", fiscalYear: String(new Date().getFullYear() + 1), definition: "", numeratorInputId: "", denominatorInputId: "", displayUnit: "x" });
const gates = (): GateForm[] => (Object.keys(gateLabels) as GateKind[]).map((gateKind) => ({ gateKind, status: "not_assessed", rationale: "", source: emptySource() }));
const initialForm = (securityCurrency: string): LedgerForm => {
  const targetNumerator = newInput("target"); targetNumerator.key = "target_valuation_input"; targetNumerator.label = "目标证券估值日分子";
  const targetDenominator = newInput("target", "", "forward_input"); targetDenominator.key = "target_forward_denominator"; targetDenominator.label = "目标证券远期分母";
  const peerNumerator = newInput("peer", "peer:replace-me"); peerNumerator.key = "peer_valuation_input"; peerNumerator.label = "同行估值日分子";
  const peerDenominator = newInput("peer", "peer:replace-me", "forward_input"); peerDenominator.key = "peer_forward_denominator"; peerDenominator.label = "同行远期分母";
  const targetMetric = newMetric("target"); targetMetric.numeratorInputId = targetNumerator.id; targetMetric.denominatorInputId = targetDenominator.id;
  const peerMetric = newMetric("peer", "peer:replace-me"); peerMetric.numeratorInputId = peerNumerator.id; peerMetric.denominatorInputId = peerDenominator.id;
  return { role: "primary", archetype: "growth_earnings", method: "forward_pe", peerUniverseId: "", valuationCurrency: securityCurrency, securityCurrency, status: "draft", applicabilityRationale: "", rationaleSource: emptySource(), supersedesLedgerId: "", inputs: [targetNumerator, targetDenominator, peerNumerator, peerDenominator], metrics: [targetMetric, peerMetric], gates: gates() };
};

/** Local-only source-bound record creator. It never fetches quotes, forecasts, or peer averages. */
export const RelativeValuationWorkbench = defineComponent({
  name: "RelativeValuationWorkbench",
  props: { securityCode: { type: String, required: true }, securityCurrency: { type: String, default: "" }, initial: { type: Object, required: true }, canWrite: { type: Boolean, required: true } },
  setup(props) {
    const data = ref<Value>(props.initial as Value); const form = ref<LedgerForm>(initialForm(props.securityCurrency.toUpperCase())); const saving = ref(false); const error = ref(""); const notice = ref("");
    const inputOptions = computed(() => form.value.inputs.map((item) => [item.id, `${item.subjectKind === "target" ? "目标" : `同行 ${item.peerMemberId || "待填"}`} · ${item.label || item.key || "未命名输入"}`] as const));
    const refresh = async () => { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/relative-valuations`); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取相对估值账本失败"); data.value = body.data; };
    const sourceReference = (source: SourceForm, label: string) => {
      const url = source.url.trim();
      if (!url || !/^https:\/\//i.test(url)) throw new Error(`${label}必须填写 HTTPS 原始来源链接`);
      if (!source.title.trim()) throw new Error(`${label}必须填写来源标题`);
      return { sourceKind: source.sourceKind, url, title: source.title.trim(), locator: source.locator.trim() || undefined };
    };
    const toTimestamp = (value: string, label: string) => { const timestamp = Date.parse(value); if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`${label}必须是有效日期`); return timestamp; };
    const finite = (value: string, label: string) => { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${label}必须是有限数值`); return number; };
    const currency = (value: string, label: string) => { const result = value.trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(result)) throw new Error(`${label}必须为 ISO 三位币种代码`); return result; };
    const inputPayload = (item: InputForm) => {
      if (!item.key.trim() || !item.label.trim() || !item.unit.trim()) throw new Error("每个来源/预测输入都必须填写键、标签和单位");
      if (item.subjectKind === "peer" && !item.peerMemberId.trim()) throw new Error("每个同行输入都必须填写已审核同行成员 ID");
      if (item.subjectKind === "target" && item.peerMemberId.trim()) throw new Error("目标证券输入不能填写同行成员 ID");
      const fiscalYear = item.inputKind === "forward_input" ? Number(item.fiscalYear) : null;
      if (item.inputKind === "forward_input" && (!Number.isInteger(fiscalYear) || fiscalYear! < 1900 || fiscalYear! > 2200)) throw new Error("远期输入必须填写有效财年");
      if (item.inputKind !== "forward_input" && item.fiscalYear.trim()) throw new Error("只有远期输入可以填写财年");
      const expected = item.inputKind === "source_fact" ? ["observed_fact"] : item.inputKind === "assumption" ? ["analysis_assumption"] : ["management_guidance", "third_party_forecast", "analysis_assumption"];
      if (!expected.includes(item.epistemicType)) throw new Error(`${item.label || item.key} 的认识类型与输入类型不匹配`);
      return { inputId: item.id, subjectKind: item.subjectKind, peerMemberId: item.subjectKind === "peer" ? item.peerMemberId.trim() : null, inputKind: item.inputKind, key: item.key.trim(), label: item.label.trim(), value: finite(item.value, item.label || item.key), unit: item.unit.trim(), currency: item.currency.trim() ? currency(item.currency, `${item.label}币种`) : null, amountScale: item.amountScale.trim() || null, fiscalYear, periodLabel: item.periodLabel.trim() || null, asOf: toTimestamp(item.asOf, `${item.label || item.key}截至日`), epistemicType: item.epistemicType, sourceReferences: [sourceReference(item.source, `${item.label || item.key}来源`)] };
    };
    const metricPayload = (item: MetricForm, inputById: Map<string, ReturnType<typeof inputPayload>>) => {
      if (!item.definition.trim() || !item.displayUnit.trim()) throw new Error("每个确定性指标都必须填写定义和展示单位");
      if (item.subjectKind === "peer" && !item.peerMemberId.trim()) throw new Error("每个同行指标都必须填写已审核同行成员 ID");
      const numerator = inputById.get(item.numeratorInputId); const denominator = inputById.get(item.denominatorInputId);
      if (!numerator || !denominator) throw new Error("指标必须选择已有的分子和分母输入");
      const peerMemberId = item.subjectKind === "peer" ? item.peerMemberId.trim() : null;
      if (numerator.subjectKind !== item.subjectKind || denominator.subjectKind !== item.subjectKind || numerator.peerMemberId !== peerMemberId || denominator.peerMemberId !== peerMemberId) throw new Error("指标只能引用同一个目标或同行成员的输入");
      if (denominator.value === 0) throw new Error("指标分母不能为零");
      if (item.periodBasis === "forward" && (denominator.inputKind !== "forward_input" || denominator.fiscalYear === null)) throw new Error("远期指标的分母必须是相同财年的远期输入");
      if (numerator.currency && denominator.currency && numerator.currency !== denominator.currency) throw new Error("指标不能直接相除不同币种；请先录入显式换算后的输入");
      if (numerator.amountScale && denominator.amountScale && numerator.amountScale !== denominator.amountScale) throw new Error("指标不能直接相除不同数值缩放；请先录入显式换算后的输入");
      const fiscalYear = item.periodBasis === "forward" ? Number(item.fiscalYear) : null;
      if (item.periodBasis === "forward" && (!Number.isInteger(fiscalYear) || fiscalYear! < 1900 || fiscalYear! > 2200)) throw new Error("远期指标必须填写财年");
      if (item.periodBasis !== "forward" && item.fiscalYear.trim()) throw new Error("只有远期指标可以填写财年");
      return { metricId: item.id, subjectKind: item.subjectKind, peerMemberId, metricType: item.metricType, periodBasis: item.periodBasis, fiscalYear, definition: item.definition.trim(), numeratorInputId: numerator.inputId, denominatorInputId: denominator.inputId, displayUnit: item.displayUnit.trim() };
    };
    const save = async () => {
      saving.value = true; error.value = ""; notice.value = "";
      try {
        if (!form.value.peerUniverseId.trim() || !form.value.applicabilityRationale.trim()) throw new Error("必须填写预先审核的同行集版本 ID 和估值原型适用理由");
        const inputs = form.value.inputs.map(inputPayload); const identities = new Set<string>();
        for (const item of inputs) { const identity = `${item.subjectKind}|${item.peerMemberId || ""}|${item.key}`; if (identities.has(identity)) throw new Error("同一对象中不能重复输入键"); identities.add(identity); }
        const inputById = new Map(inputs.map((item) => [item.inputId, item])); const metrics = form.value.metrics.map((item) => metricPayload(item, inputById));
        if (!metrics.some((item) => item.subjectKind === "target") || !metrics.some((item) => item.subjectKind === "peer")) throw new Error("必须同时记录目标证券与至少一个同行的确定性指标");
        const gatesPayload = form.value.gates.map((item) => ({ gateId: `relative-gate:${item.gateKind}:${crypto.randomUUID()}`, gateKind: item.gateKind, status: item.status, rationale: item.rationale.trim(), sourceReferences: [sourceReference(item.source, `${gateLabels[item.gateKind]}门禁来源`)] }));
        if (gatesPayload.some((item) => !item.rationale)) throw new Error("六项可比性门禁均须填写已核查理由；未完成请选择“未评估”而非留空");
        const payload = { ledgerId: `relative-valuation:${crypto.randomUUID()}`, asOf: Date.now(), createdAt: Date.now(), status: form.value.status, role: form.value.role, archetype: form.value.archetype, method: form.value.method, peerUniverseId: form.value.peerUniverseId.trim(), valuationCurrency: currency(form.value.valuationCurrency, "估值币种"), securityCurrency: currency(form.value.securityCurrency, "证券币种"), applicabilityRationale: form.value.applicabilityRationale.trim(), rationaleSourceReferences: [sourceReference(form.value.rationaleSource, "估值原型理由来源")], supersedesLedgerId: form.value.supersedesLedgerId.trim() || null, inputs, metrics, comparabilityGates: gatesPayload };
        const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/relative-valuations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存相对估值账本失败");
        await refresh(); form.value = initialForm(payload.securityCurrency); notice.value = `已追加不可变相对估值账本：${body.data.recordId}。`;
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    const inputField = (label: string, value: string, update: (value: string) => void, type = "text", wide = false) => h("label", { class: wide ? "wide" : "" }, [h("span", label), type === "textarea" ? h("textarea", { value, onInput: (event: Event) => update((event.target as HTMLTextAreaElement).value) }) : h("input", { type, value, onInput: (event: Event) => update((event.target as HTMLInputElement).value) })]);
    const selectField = (label: string, value: string, options: ReadonlyArray<readonly [string, string]>, update: (value: string) => void, wide = false) => h("label", { class: wide ? "wide" : "" }, [h("span", label), h("select", { value, onChange: (event: Event) => update((event.target as HTMLSelectElement).value) }, options.map(([key, title]) => h("option", { value: key }, title)))]);
    const sourceFields = (source: SourceForm, update: (next: SourceForm) => void, prefix: string) => h("div", { class: "rv-grid two mt-2" }, [selectField(`${prefix}来源类型`, source.sourceKind, sourceKinds, (value) => update({ ...source, sourceKind: value as SourceKind })), inputField(`${prefix}HTTPS 原始链接`, source.url, (value) => update({ ...source, url: value }), "url"), inputField(`${prefix}标题`, source.title, (value) => update({ ...source, title: value })), inputField(`${prefix}页码/段落/定位（可选）`, source.locator, (value) => update({ ...source, locator: value }))]);
    const renderedLedgers = () => {
      const items = Array.isArray(data.value.items) ? data.value.items as Value[] : [];
      if (!items.length) return h("div", { class: "research-note mt-3" }, data.value.availability === "unavailable" ? `账本待初始化：${String(data.value.reason || "unknown")}` : "尚无已保存相对估值账本。请先建立有来源的同行集和全部六项可比性审查。");
      return h("details", { class: "mt-3", open: true }, [
        h("summary", `已保存的不可变相对估值账本（${items.length}）`),
        ...items.map((ledger) => {
          const readiness = ledger.readiness as Value | undefined;
          const blockedReasons = readiness?.blockedReasons as Value[] | undefined;
          return h("article", { class: "rv-card" }, [
            h("div", { class: "rv-row" }, [h("strong", `${ledger.role === "primary" ? "主" : "辅助"} · ${ledger.archetype} / ${ledger.method}`), h("span", { class: "research-state" }, String(readiness?.status || "blocked"))]),
            h("p", { class: "research-meta mb-1" }, `同行集 ${ledger.peerUniverseId} · ${ledger.valuationCurrency}/${ledger.securityCurrency} · ${ledger.status}`),
            h("p", { class: "small mb-1" }, String(ledger.applicabilityRationale || "—")),
            h("div", { class: "table-responsive mt-2" }, h("table", { class: "table table-sm research-table mb-0" }, [
              h("thead", h("tr", [h("th", "对象"), h("th", "指标"), h("th", "期间"), h("th", "冻结计算")])),
              h("tbody", ((ledger.metrics as Value[]) || []).map((metric) => h("tr", [h("td", metric.subjectKind === "target" ? "目标证券" : `同行 · ${metric.peerMemberId}`), h("td", String(metric.metricType)), h("td", String(metric.fiscalYear || metric.periodBasis)), h("td", `${String(metric.value)} ${String(metric.displayUnit || "")}`)]))),
            ])),
            h("ul", { class: "research-list research-meta mt-2" }, ((ledger.comparabilityGates as Value[]) || []).map((gate) => h("li", `${gateLabels[String(gate.gateKind) as GateKind] || gate.gateKind}：${gate.status}；${gate.rationale}`))),
            blockedReasons?.length ? h("div", { class: "research-note mt-2" }, `比较限制：${blockedReasons.map((reason) => String(reason.message)).join("；")}`) : null,
          ]);
        }),
      ]);
    };
    return () => h("section", { class: "research-card relative-valuation-workbench" }, [
      h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "主估值原型与辅助相对估值工作台"), h("p", { class: "research-meta mb-0" }, "只冻结有来源的目标/同行输入、逐年远期口径和六项可比性门禁。这里不抓行情或研报，不算同行平均、市场一致预期、目标价或交易建议。")]), h("span", { class: "research-state" }, props.canWrite ? "本地可追加" : "生产只读")]),
      renderedLedgers(),
      props.canWrite ? h("div", { class: "rv-card" }, [
        h("h3", "追加完整不可变账本"), h("p", { class: "research-meta" }, "同行成员 ID 必须指向已审核同行集；每一条输入和门禁都保留独立的原始来源。未评估门禁会明确阻断比较，而不是默认通过。"),
        h("div", { class: "rv-grid" }, [selectField("角色", form.value.role, [["primary", "主估值原型"], ["auxiliary", "辅助方法"]], (value) => form.value.role = value as LedgerForm["role"]), selectField("估值原型", form.value.archetype, archetypes, (value) => form.value.archetype = value), selectField("方法", form.value.method, methods, (value) => form.value.method = value), inputField("已审核同行集版本 ID", form.value.peerUniverseId, (value) => form.value.peerUniverseId = value), inputField("估值币种", form.value.valuationCurrency, (value) => form.value.valuationCurrency = value), inputField("证券交易币种", form.value.securityCurrency, (value) => form.value.securityCurrency = value), selectField("账本状态", form.value.status, [["draft", "草稿"], ["reviewed", "已复核"]], (value) => form.value.status = value as LedgerForm["status"]), inputField("替代的历史账本 ID（可选）", form.value.supersedesLedgerId, (value) => form.value.supersedesLedgerId = value), inputField("原型适用理由", form.value.applicabilityRationale, (value) => form.value.applicabilityRationale = value, "textarea", true)]),
        sourceFields(form.value.rationaleSource, (value) => form.value.rationaleSource = value, "原型理由"),
        h("h4", { class: "h6 mt-3" }, "目标与同行的冻结分子/分母输入"),
        ...form.value.inputs.map((item, index) => h("article", { class: "rv-card" }, [h("div", { class: "rv-row" }, [h("strong", `${item.subjectKind === "target" ? "目标证券" : `同行 ${item.peerMemberId || "待填"}`}输入 ${index + 1}`), h("button", { class: "btn btn-outline-danger btn-sm", disabled: form.value.inputs.length <= 1, onClick: () => { form.value.inputs = form.value.inputs.filter((entry) => entry.id !== item.id); form.value.metrics = form.value.metrics.map((metric) => metric.numeratorInputId === item.id || metric.denominatorInputId === item.id ? { ...metric, numeratorInputId: "", denominatorInputId: "" } : metric); } }, "移除")]), h("div", { class: "rv-grid" }, [selectField("对象", item.subjectKind, [["target", "目标证券"], ["peer", "同行成员"]], (value) => { item.subjectKind = value as SubjectKind; if (value === "target") item.peerMemberId = ""; }), item.subjectKind === "peer" ? inputField("已审核同行成员 ID", item.peerMemberId, (value) => item.peerMemberId = value) : null, selectField("输入性质", item.inputKind, [["source_fact", "来源事实"], ["forward_input", "远期输入"], ["assumption", "自建假设"]], (value) => { item.inputKind = value as InputKind; item.epistemicType = value === "source_fact" ? "observed_fact" : value === "assumption" ? "analysis_assumption" : "third_party_forecast"; if (value !== "forward_input") item.fiscalYear = ""; }), inputField("输入键", item.key, (value) => item.key = value), inputField("标签", item.label, (value) => item.label = value), inputField("数值", item.value, (value) => item.value = value, "number"), inputField("单位", item.unit, (value) => item.unit = value), inputField("币种（可选）", item.currency, (value) => item.currency = value), inputField("数值缩放（可选）", item.amountScale, (value) => item.amountScale = value), item.inputKind === "forward_input" ? inputField("远期财年", item.fiscalYear, (value) => item.fiscalYear = value, "number") : null, inputField("期间标签（可选）", item.periodLabel, (value) => item.periodLabel = value), inputField("输入截至日", item.asOf, (value) => item.asOf = value, "date"), selectField("认识类型", item.epistemicType, item.inputKind === "source_fact" ? [["observed_fact", "来源事实"]] : item.inputKind === "assumption" ? [["analysis_assumption", "自建假设"]] : [["third_party_forecast", "第三方预测"], ["management_guidance", "管理层指引"], ["analysis_assumption", "自建假设"]], (value) => item.epistemicType = value as InputForm["epistemicType"]) ]), sourceFields(item.source, (value) => item.source = value, "输入") ])),
        h("div", { class: "d-flex gap-2 mt-2" }, [h("button", { class: "btn btn-outline-primary btn-sm", onClick: () => form.value.inputs.push(newInput("target")) }, "新增目标输入"), h("button", { class: "btn btn-outline-primary btn-sm", onClick: () => form.value.inputs.push(newInput("peer", "peer:replace-me")) }, "新增同行输入")]),
        h("h4", { class: "h6 mt-3" }, "确定性可重放指标（仅分子 ÷ 分母）"),
        ...form.value.metrics.map((metric, index) => h("article", { class: "rv-card" }, [h("div", { class: "rv-row" }, [h("strong", `指标 ${index + 1}`), h("button", { class: "btn btn-outline-danger btn-sm", disabled: form.value.metrics.length <= 2, onClick: () => form.value.metrics = form.value.metrics.filter((entry) => entry.id !== metric.id) }, "移除")]), h("div", { class: "rv-grid" }, [selectField("对象", metric.subjectKind, [["target", "目标证券"], ["peer", "同行成员"]], (value) => { metric.subjectKind = value as SubjectKind; if (value === "target") metric.peerMemberId = ""; }), metric.subjectKind === "peer" ? inputField("同行成员 ID", metric.peerMemberId, (value) => metric.peerMemberId = value) : null, selectField("指标", metric.metricType, metricTypes, (value) => metric.metricType = value), selectField("期间", metric.periodBasis, [["forward", "远期"], ["trailing", "历史"], ["normalized", "正常化"], ["other", "其他"]], (value) => { metric.periodBasis = value as MetricForm["periodBasis"]; if (value !== "forward") metric.fiscalYear = ""; }), metric.periodBasis === "forward" ? inputField("远期财年", metric.fiscalYear, (value) => metric.fiscalYear = value, "number") : null, selectField("分子", metric.numeratorInputId, [["", "选择已录入输入"], ...inputOptions.value], (value) => metric.numeratorInputId = value), selectField("分母", metric.denominatorInputId, [["", "选择已录入输入"], ...inputOptions.value], (value) => metric.denominatorInputId = value), inputField("定义", metric.definition, (value) => metric.definition = value, "textarea", true), inputField("展示单位", metric.displayUnit, (value) => metric.displayUnit = value) ]) ])),
        h("button", { class: "btn btn-outline-primary btn-sm mt-2", onClick: () => form.value.metrics.push(newMetric("target")) }, "新增确定性指标"),
        h("h4", { class: "h6 mt-3" }, "六项可比性门禁（全部必填）"),
        ...form.value.gates.map((gate) => h("article", { class: `rv-card rv-gate ${gate.status}` }, [h("strong", gateLabels[gate.gateKind]), h("div", { class: "rv-grid mt-2" }, [selectField("状态", gate.status, [["passed", "已通过"], ["adjustment_required", "需调整"], ["blocked", "阻断"], ["not_assessed", "未评估"]], (value) => gate.status = value as GateStatus), inputField("核查理由/差异", gate.rationale, (value) => gate.rationale = value, "textarea", true)]), sourceFields(gate.source, (value) => gate.source = value, `${gateLabels[gate.gateKind]}门禁`) ])),
        error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null, notice.value ? h("div", { class: "alert alert-success py-2 mt-3 mb-0" }, notice.value) : null, h("button", { class: "btn btn-success btn-sm mt-3", disabled: saving.value, onClick: () => void save() }, saving.value ? "保存中…" : "追加不可变相对估值账本")
      ]) : null,
    ]);
  },
});
