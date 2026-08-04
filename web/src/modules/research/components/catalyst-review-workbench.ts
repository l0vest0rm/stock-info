import { defineComponent, h, ref } from "vue";

type Catalyst = { catalystId: string; title: string; eventAt: number | null; status: string; impactedAssumption: string; expectedEffect: string | null; reviews?: Review[] };
type Review = { catalystReviewId: string; asOf: number; reviewStatus: string; outcomeSummary: string; expectedVsActual: string; impactedAssumptionStatus: string; nextAction: string; sourceReferences: Array<{ url?: string; title?: string }> };

const css = `.catalyst-review{margin-top:1rem;border-left:4px solid #7c3aed}.catalyst-review-item{border-top:1px solid #e9d5ff;padding:.7rem 0}.catalyst-review-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem;margin-top:.8rem;padding:.8rem;background:#faf5ff;border-radius:.7rem}.catalyst-review-form label{font-size:.8rem;color:#4c1d95}.catalyst-review-form input,.catalyst-review-form select,.catalyst-review-form textarea{display:block;width:100%;margin-top:.2rem;padding:.4rem;border:1px solid #d8b4fe;border-radius:.4rem}.catalyst-review-form textarea{min-height:4rem}.catalyst-review-wide{grid-column:1/-1}@media(max-width:600px){.catalyst-review-form{grid-template-columns:1fr}}`;

function date(value: number | null | undefined) { return value && Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未设日期"; }

/** Records the later outcome separately from a catalyst's original expectation. */
export const CatalystReviewWorkbench = defineComponent({
  name: "CatalystReviewWorkbench",
  props: { securityCode: { type: String, required: true }, canWrite: { type: Boolean, required: true }, catalysts: { type: Array as () => Catalyst[], required: true } },
  emits: ["saved"],
  setup(props, { emit }) {
    const open = ref(false); const selectedId = ref(""); const saving = ref(false); const error = ref("");
    const form = ref({ reviewStatus: "observed", outcomeSummary: "", expectedVsActual: "", impactedAssumptionStatus: "not_tested", nextAction: "", sourceUrl: "", sourceTitle: "" });
    const eligible = () => props.catalysts.filter((item) => item.eventAt !== null && item.eventAt <= Date.now());
    const start = () => { selectedId.value = eligible()[0]?.catalystId || ""; error.value = ""; open.value = true; };
    const save = async () => {
      if (!selectedId.value) { error.value = "请选择已经到期或已发生的事件。"; return; }
      saving.value = true; error.value = "";
      try {
        const sourceUrl = form.value.sourceUrl.trim(); const sourceTitle = form.value.sourceTitle.trim() || sourceUrl;
        const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/catalysts/${encodeURIComponent(selectedId.value)}/reviews`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            reviewStatus: form.value.reviewStatus, outcomeSummary: form.value.outcomeSummary.trim(), expectedVsActual: form.value.expectedVsActual.trim(),
            impactedAssumptionStatus: form.value.impactedAssumptionStatus, nextAction: form.value.nextAction.trim(),
            sourceReferences: sourceUrl ? [{ sourceKind: "external_url", url: sourceUrl, title: sourceTitle, publishedAt: Date.now() }] : [],
          }),
        });
        const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存事件复盘失败");
        open.value = false; emit("saved");
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    const input = (label: string, key: keyof typeof form.value, multiline = false, wide = false) => h("label", { class: wide ? "catalyst-review-wide" : "" }, [label, multiline
      ? h("textarea", { value: form.value[key], onInput: (event: Event) => { form.value = { ...form.value, [key]: (event.target as HTMLTextAreaElement).value }; } })
      : h("input", { value: form.value[key], onInput: (event: Event) => { form.value = { ...form.value, [key]: (event.target as HTMLInputElement).value }; } })]);
    return () => h("section", { class: "research-card catalyst-review" }, [
      h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "事件结果与假设复盘"), h("p", { class: "research-meta mb-0" }, "原事件和事后结果分版本保存；结果必须来自原始/可追溯证据，不会改写当时预期。")]), props.canWrite ? h("button", { class: "btn btn-outline-secondary btn-sm", disabled: !eligible().length, title: eligible().length ? "为已发生事件追加复盘" : "尚无到期或已发生事件", onClick: start }, "复盘事件") : null]),
      !props.catalysts.length ? h("div", { class: "research-note mt-3" }, "尚无催化剂或事件记录，不能凭空生成事后复盘。") : null,
      props.catalysts.filter((item) => item.reviews?.length).map((catalyst) => h("article", { class: "catalyst-review-item" }, [
        h("strong", catalyst.title), h("div", { class: "research-meta" }, `${date(catalyst.eventAt)} · ${catalyst.status} · 影响假设：${catalyst.impactedAssumption}`),
        ...(catalyst.reviews || []).map((review) => h("div", { class: "mt-2 small" }, [h("b", `${date(review.asOf)} · ${review.reviewStatus} / 假设${review.impactedAssumptionStatus}`), h("p", { class: "mb-1" }, review.outcomeSummary), h("p", { class: "research-meta mb-1" }, `预期与实际：${review.expectedVsActual}；下一步：${review.nextAction}`), ...review.sourceReferences.map((source) => source.url ? h("a", { class: "evidence-link me-2", href: source.url, target: "_blank", rel: "noreferrer" }, source.title || source.url) : null)])),
      ])),
      open.value ? h("div", { class: "catalyst-review-form" }, [
        h("label", { class: "catalyst-review-wide" }, ["复盘的事件", h("select", { value: selectedId.value, onChange: (event: Event) => selectedId.value = (event.target as HTMLSelectElement).value }, eligible().map((item) => h("option", { value: item.catalystId }, `${date(item.eventAt)} · ${item.title}`)))]),
        h("label", ["结果状态", h("select", { value: form.value.reviewStatus, onChange: (event: Event) => form.value = { ...form.value, reviewStatus: (event.target as HTMLSelectElement).value } }, [["observed", "已观察"], ["partially_confirmed", "部分确认"], ["confirmed", "已确认"], ["missed", "未兑现"], ["not_comparable", "不可比"]].map(([value, label]) => h("option", { value }, label)))]),
        h("label", ["受影响假设", h("select", { value: form.value.impactedAssumptionStatus, onChange: (event: Event) => form.value = { ...form.value, impactedAssumptionStatus: (event.target as HTMLSelectElement).value } }, [["not_tested", "尚未检验"], ["confirmed", "确认"], ["weakened", "削弱"], ["invalidated", "证伪"]].map(([value, label]) => h("option", { value }, label)))]),
        input("实际结果摘要", "outcomeSummary", true, true), input("原预期与实际的差异", "expectedVsActual", true, true), input("下一步复核动作", "nextAction", true, true),
        input("原始/正式结果来源链接", "sourceUrl", false, true), input("来源标题", "sourceTitle", false, true),
        error.value ? h("div", { class: "alert alert-danger py-2 mb-0 catalyst-review-wide" }, error.value) : null,
        h("div", { class: "catalyst-review-wide d-flex gap-2" }, [h("button", { class: "btn btn-secondary btn-sm", disabled: saving.value, onClick: () => void save() }, saving.value ? "保存中…" : "保存复盘"), h("button", { class: "btn btn-link btn-sm", disabled: saving.value, onClick: () => open.value = false }, "取消")]),
      ]) : null,
    ]);
  },
});
