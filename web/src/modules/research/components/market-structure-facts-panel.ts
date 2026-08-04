import { defineComponent, h, ref } from "vue";

type Value = Record<string, any>;
const stateLabel: Record<string, string> = { verified: "已核验", weighted_average_only: "仅 EPS 加权平均分母（不解除门禁）", missing: "缺失", unavailable: "不可得", not_applicable: "不适用", conflicting: "冲突", source_viewpoint: "仅来源观点" };
const reasonLabel: Record<string, string> = {
  source_backed_observed_fact: "已由来源绑定的观察事实满足。",
  missing_source_bound_record: "尚未记录来源绑定事实；这不表示数值为 0、该项不适用或已确认不存在。",
  weighted_average_eps_not_period_end: "来源仅提供 EPS 加权平均分母，不是期末在外股数，不能解除每股门禁。",
  source_viewpoint_not_observed_fact: "记录是来源观点而非可观察事实，不能解除门禁。",
  source_record_unavailable: "已有来源绑定记录明确为不可得；不可将其当作中性或已满足。",
  source_record_not_applicable: "已有来源绑定记录标为不适用；该配置仍不会自动解除跨证券比较门禁。",
  source_records_conflict: "已有来源记录存在冲突；必须先人工核验，不能选择任一条自动通过。",
};
const authorityOptions = [["issuer_disclosure", "发行人正式披露"], ["exchange_rule", "交易所规则"], ["regulator_filing", "监管备案"], ["regulator_rule", "监管规则/公告"], ["depositary_agreement", "存托协议"], ["tax_authority_rule", "税务机关规则"], ["broker_rule", "券商规则说明"]] as const;

export const MarketStructureFactsPanel = defineComponent({
  name: "MarketStructureFactsPanel",
  props: { securityCode: { type: String, required: true }, initial: { type: Object, required: true }, canWrite: { type: Boolean, required: true } },
  setup(props) {
    const data = ref<Value>(props.initial as Value); const saving = ref(false); const error = ref(""); const notice = ref("");
    const firstKey = () => data.value?.requirements?.find((item: Value) => item.state !== "verified")?.factKey || data.value?.requirements?.[0]?.factKey || "basic_shares";
    const form = ref<Value>({ factKey: firstKey(), factStatus: "verified", valueKind: "number", valueNumber: "", valueText: "", unit: "shares", measurementBasis: "period_end_outstanding", asOf: new Date().toISOString().slice(0, 10), frequency: "event", epistemicType: "observed_fact", sourceAuthority: "issuer_disclosure", sourceUrl: "", sourceTitle: "", sourceNote: "", effectiveFrom: "", effectiveTo: "" });
    const isShareCount = () => ["basic_shares", "diluted_shares"].includes(form.value.factKey);
    const updateKind = () => { const target = data.value?.requirements?.find((item: Value) => item.factKey === form.value.factKey); if (target) { form.value.valueKind = target.valueKind; form.value.unit = target.valueKind === "number" ? form.value.unit || "shares" : ""; if (!isShareCount()) form.value.measurementBasis = ""; else if (!form.value.measurementBasis) form.value.measurementBasis = "period_end_outstanding"; } };
    const refresh = async () => { const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/market-structure`); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取市场结构事实失败"); data.value = body.data; };
    const save = async () => { saving.value = true; error.value = ""; notice.value = ""; try { const payload = { ...form.value, measurementBasis: isShareCount() ? form.value.measurementBasis || null : null, valueNumber: form.value.valueKind === "number" && form.value.valueNumber !== "" ? Number(form.value.valueNumber) : null, valueText: form.value.valueKind === "text" && form.value.valueText.trim() ? form.value.valueText.trim() : null, unit: form.value.valueKind === "number" ? form.value.unit.trim() || null : null, effectiveFrom: form.value.effectiveFrom || null, effectiveTo: form.value.effectiveTo || null }; const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/market-structure/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存市场结构事实失败"); await refresh(); notice.value = "已追加来源绑定事实；不会改写历史记录或估值版本。"; } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { saving.value = false; } };
    const input = (label: string, key: string, type = "text") => h("label", { class: "market-structure-field" }, [h("span", label), h("input", { type, value: form.value[key], onInput: (event: Event) => { form.value[key] = (event.target as HTMLInputElement).value; } })]);
    const select = (label: string, key: string, choices: ReadonlyArray<readonly [string, string]>, change?: () => void) => h("label", { class: "market-structure-field" }, [h("span", label), h("select", { value: form.value[key], onChange: (event: Event) => { form.value[key] = (event.target as HTMLSelectElement).value; change?.(); } }, choices.map(([value, label]) => h("option", { value }, label)))]);
    return () => {
      const requirements: Value[] = data.value?.requirements || [];
      const gate = (title: string, value: Value) => {
        const missing = (value?.missingFactKeys || []).map((factKey: string) => {
          const item = requirements.find((candidate: Value) => candidate.factKey === factKey);
          return `${item?.label || factKey}（${stateLabel[item?.state] || item?.state || "缺失"}）`;
        });
        return h("article", { class: `market-structure-gate ${value?.status === "ready" ? "ready" : "blocked"}` }, [h("strong", `${title}：${value?.status === "ready" ? "可用" : "阻断"}`), h("div", { class: "research-meta" }, value?.reason || "已满足配置化必填事实"), value?.status === "blocked" ? h("div", { class: "small mt-1" }, `待补事实：${missing.join("；")}。缺失、不可得、来源观点和 EPS 分母均不会自动变为可用输入。`) : null]);
      };
      return h("section", { class: "research-card section-card market-structure-panel" }, [
        h("style", ".market-structure-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.65rem}.market-structure-field{display:grid;gap:.25rem;font-size:.82rem}.market-structure-field input,.market-structure-field select{width:100%;padding:.35rem}.market-structure-gate{padding:.65rem;border-radius:.4rem;background:#fff5f5;border:1px solid #fecaca}.market-structure-gate.ready{background:#f0fdf4;border-color:#bbf7d0}.market-structure-fact{border-top:1px solid #e5e7eb;padding:.55rem 0}") ,
        h("div", { class: "section-head" }, [h("div", [h("h2", "证券市场结构事实"), h("p", { class: "research-meta mb-0" }, "基础/稀释股数、流通与可达性、税费、交易/结算以及 ADR/VIE 均按具体证券、市场与证券类型保存。未核验事实不替代缺口。")]), h("span", { class: "research-state" }, data.value?.profileId || "待识别")]),
        data.value?.availability === "unavailable" ? h("div", { class: "research-note mt-3" }, "市场结构账本尚未初始化；每股估值和跨证券比较保持阻断。") : [
          h("div", { class: "research-grid mt-3" }, [gate("每股估值", data.value?.perShareValuation), gate("跨证券比较", data.value?.crossSecurityComparison)]),
          h("div", { class: "mt-3" }, requirements.map((item) => h("article", { class: "market-structure-fact" }, [h("strong", `${item.label} · ${stateLabel[item.state] || item.state}`), h("div", { class: "research-meta" }, item.fact ? `${item.fact.asOf} · ${item.fact.frequency} · ${item.fact.epistemicType}` : "配置要求，尚无来源绑定记录"), h("div", { class: "small" }, reasonLabel[item.reasonCode] || "该状态未满足证券级门禁。"), item.fact ? h("div", { class: "small" }, [item.fact.valueKind === "number" ? `${item.fact.valueNumber} ${item.fact.unit || ""}` : item.fact.valueText || "状态记录", item.fact.measurementBasis === "weighted_average_eps" ? " · EPS 加权平均分母，不是期末在外股数" : "", " · ", h("a", { href: item.fact.sourceUrl, target: "_blank", rel: "noreferrer" }, item.fact.sourceTitle)]) : null]))),
          h("details", { class: "mt-3" }, [h("summary", "查看全部可审计市场结构来源记录"), h("div", { class: "mt-2" }, (data.value?.auditableFacts || []).map((item: Value) => h("article", { class: "market-structure-fact" }, [h("strong", `${item.factKey}${item.measurementBasis === "weighted_average_eps" ? " · EPS 加权平均分母" : ""}`), h("div", { class: "research-meta" }, `${item.asOf} · ${item.frequency} · ${item.epistemicType}`), h("div", { class: "small" }, [item.valueKind === "number" ? `${item.valueNumber} ${item.unit || ""}` : item.valueText || "状态记录", " · ", h("a", { href: item.sourceUrl, target: "_blank", rel: "noreferrer" }, item.sourceTitle)])])))]),
          props.canWrite ? h("details", { class: "mt-3", "data-research-workbench": "market-structure-facts" }, [h("summary", "本地工作台：追加来源绑定市场结构事实"), h("div", { class: "mt-2" }, [h("p", { class: "research-meta" }, "只能为配置中的字段追加记录；选择不可得/不适用也必须保留正式来源及原因，不能用空值解除门禁。"), h("div", { class: "market-structure-grid" }, [select("字段", "factKey", requirements.map((item) => [item.factKey, item.label] as const), updateKind), select("状态", "factStatus", [["verified", "已核验"], ["unavailable", "不可得"], ["not_applicable", "不适用"], ["conflicting", "冲突"]]), form.value.valueKind === "number" ? input("数值", "valueNumber", "number") : input("事实文本/不可得原因", "valueText"), form.value.valueKind === "number" ? input("单位", "unit") : null, isShareCount() ? select("股数口径", "measurementBasis", [["period_end_outstanding", "期末在外股数（可用于门禁）"], ["weighted_average_eps", "EPS 加权平均分母（仅审计展示）"]]) : null, isShareCount() && form.value.measurementBasis === "weighted_average_eps" ? h("div", { class: "research-note" }, "EPS 加权平均分母不是期末在外股数，保存后每股估值仍会保持阻断。") : null, input("截至日", "asOf", "date"), select("频率", "frequency", [["event", "事件"], ["annual", "年度"], ["quarterly", "季度"], ["periodic", "定期"], ["rule_change", "规则变更"]]), select("认识类型", "epistemicType", [["observed_fact", "来源事实"], ["source_viewpoint", "来源观点（不满足门禁）"]]), select("来源权威类型", "sourceAuthority", authorityOptions), input("来源 URL", "sourceUrl", "url"), input("来源标题", "sourceTitle"), input("证据定位/说明", "sourceNote")]), error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null, notice.value ? h("div", { class: "alert alert-success py-2 mt-3 mb-0" }, notice.value) : null, h("button", { class: "btn btn-outline-success btn-sm mt-3", disabled: saving.value, onClick: () => void save() }, saving.value ? "保存中…" : "追加市场结构事实")])]) : null,
        ],
      ]);
    };
  },
});
