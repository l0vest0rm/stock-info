import { defineComponent, h, ref } from "vue";

type Guidance = { forecastId: string; forecastDate: string; metric: string; fiscalPeriod: string; sourceStatement: string };
type Catalyst = { title: string; reviews?: Array<{ catalystReviewId: string; asOf: number; outcomeSummary: string; reviewStatus: string }> };
type FormalActual = { actualId: string; filedAt: string; metric: string; fiscalPeriod: string; actualStatus: string; sourceStatement: string };
type Target = { thesisId?: string; riskId?: string; title: string };
type ImpactAction = { actionId: string; decision: "no_change" | "follow_up_recorded" | "not_applicable"; rationale: string; actedBy: string; followUpTargetId: string | null; actedAt: number };
type StoredTarget = { impactReviewTargetId: string; targetKind: "thesis" | "risk" | "scenario" | "dcf" | "reverse_dcf"; targetId: string; reviewState: "requires_review" | "no_change" | "follow_up_recorded" | "not_applicable"; action: ImpactAction | null };
type StoredReview = { impactReviewId: string; sourceKind: string; sourceId: string; sourceObservedAt: string | null; reviewer: string; rationale: string; targets: StoredTarget[]; sourceBinding: { statement?: string; sourceReferences?: Array<{ url?: string; title?: string }> }; modelReviewItemsCreated?: number };
type Source = { kind: "management_guidance" | "catalyst_actual" | "formal_actual"; id: string; label: string };
type ModelTarget = { targetKind: "scenario" | "dcf" | "reverse_dcf"; targetId: string; label: string };

const css = `.impact-review{margin-top:1rem;border-left:4px solid #0f766e}.impact-review-form{display:grid;gap:.65rem;grid-template-columns:repeat(2,minmax(0,1fr));margin-top:.8rem;padding:.8rem;background:#f0fdfa;border-radius:.7rem}.impact-review-form label{font-size:.8rem;color:#134e4a}.impact-review-form select,.impact-review-form textarea{display:block;width:100%;margin-top:.2rem;padding:.4rem;border:1px solid #99d6cc;border-radius:.4rem}.impact-review-form textarea{min-height:4.5rem}.impact-review-wide{grid-column:1/-1}.impact-review-targets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.35rem}.impact-review-targets label{display:flex;gap:.35rem;align-items:flex-start;font-size:.82rem}.impact-review-item{border-top:1px solid #ccebe5;padding:.7rem 0}.impact-target{border:1px solid #d7e6e3;border-radius:.55rem;background:#fbfefd;padding:.55rem;margin-top:.45rem}.impact-target.pending{border-left:3px solid #d97706}.impact-target.final{border-left:3px solid #0f766e}.impact-target-state{display:inline-block;border-radius:999px;padding:.12rem .42rem;font-size:.73rem;font-weight:700;background:#fef3c7;color:#92400e}.impact-target-state.final{background:#d1fae5;color:#065f46}.impact-resolution-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.45rem;margin-top:.55rem;padding:.55rem;background:#f0fdfa;border-radius:.45rem}.impact-resolution-form textarea,.impact-resolution-form select{width:100%;margin-top:.2rem;padding:.35rem;border:1px solid #99d6cc;border-radius:.35rem}.impact-resolution-form textarea{min-height:3.5rem}.impact-resolution-wide{grid-column:1/-1}@media(max-width:650px){.impact-review-form,.impact-review-targets,.impact-resolution-form{grid-template-columns:1fr}}`;

/** Explicitly maps a stored guidance/event outcome to records that need review.
 * It never offers a target-status selector because this action cannot decide a thesis/risk outcome. */
export const GuidanceEventImpactReviewWorkbench = defineComponent({
  name: "GuidanceEventImpactReviewWorkbench",
  props: { securityCode: { type: String, required: true }, canWrite: { type: Boolean, default: false }, guidance: { type: Array as () => Guidance[], default: () => [] }, catalysts: { type: Array as () => Catalyst[], default: () => [] }, formalActuals: { type: Array as () => FormalActual[], default: () => [] }, scenarios: { type: Array as () => Array<{ scenarioId: string; scenarioName: string; version: number; status: string }>, default: () => [] }, valuationModels: { type: Array as () => Array<{ modelVersionId: string; asOf: number; status: string }>, default: () => [] }, reverseValuationModels: { type: Array as () => Array<{ modelVersionId: string; asOf: number; status: string }>, default: () => [] }, theses: { type: Array as () => Target[], default: () => [] }, risks: { type: Array as () => Target[], default: () => [] }, reviews: { type: Array as () => StoredReview[], default: () => [] } },
  emits: ["saved"],
  setup(props, { emit }) {
    const open = ref(false); const sourceValue = ref(""); const rationale = ref(""); const thesisIds = ref<string[]>([]); const riskIds = ref<string[]>([]); const modelTargets = ref<Array<{ targetKind: "scenario" | "dcf" | "reverse_dcf"; targetId: string }>>([]); const saving = ref(false); const error = ref(""); const notice = ref("");
    const resolvingTargetId = ref(""); const disposition = ref<ImpactAction["decision"]>("no_change"); const dispositionRationale = ref(""); const followUpTargetId = ref(""); const resolving = ref(false);
    const sources = () => [
      ...props.guidance.map((item): Source => ({ kind: "management_guidance", id: item.forecastId, label: `管理层指引 · ${item.forecastDate} · ${item.fiscalPeriod} ${item.metric} · ${item.sourceStatement}` })),
      ...props.catalysts.flatMap((item) => (item.reviews || []).map((review): Source => ({ kind: "catalyst_actual", id: review.catalystReviewId, label: `事件实际 · ${new Date(review.asOf).toLocaleDateString("zh-CN")} · ${item.title} · ${review.reviewStatus}` }))),
      ...props.formalActuals.filter((item) => item.actualStatus !== "superseded").map((item): Source => ({ kind: "formal_actual", id: item.actualId, label: `已接受法定实际 · ${item.filedAt} · ${item.fiscalPeriod} ${item.metric} · ${item.sourceStatement}` })),
    ];
    const availableModelTargets = (): ModelTarget[] => [
      ...props.scenarios.filter((item) => item.status !== "superseded").map((item) => ({ targetKind: "scenario" as const, targetId: item.scenarioId, label: `自建情景 · ${item.scenarioName} v${item.version}` })),
      ...props.valuationModels.filter((item) => item.status !== "superseded").map((item) => ({ targetKind: "dcf" as const, targetId: item.modelVersionId, label: `正向 DCF 冻结版本 · ${new Date(item.asOf).toLocaleDateString("zh-CN")}` })),
      ...props.reverseValuationModels.filter((item) => item.status !== "superseded").map((item) => ({ targetKind: "reverse_dcf" as const, targetId: item.modelVersionId, label: `反向 DCF 冻结版本 · ${new Date(item.asOf).toLocaleDateString("zh-CN")}` })),
    ];
    const selected = () => sources().find((item) => `${item.kind}:${item.id}` === sourceValue.value) || null;
    const toggle = (target: "thesis" | "risk", id: string, checked: boolean) => {
      const current = target === "thesis" ? thesisIds : riskIds;
      current.value = checked ? [...new Set([...current.value, id])] : current.value.filter((item) => item !== id);
    };
    const toggleModel = (target: ModelTarget, checked: boolean) => {
      const key = `${target.targetKind}:${target.targetId}`;
      modelTargets.value = checked ? [...modelTargets.value, { targetKind: target.targetKind, targetId: target.targetId }]
        : modelTargets.value.filter((item) => `${item.targetKind}:${item.targetId}` !== key);
    };
    const targetLabel = (target: StoredTarget) => target.targetKind === "thesis" ? `命题 · ${target.targetId}`
      : target.targetKind === "risk" ? `风险 · ${target.targetId}`
        : target.targetKind === "scenario" ? `自建情景（冻结版本）· ${target.targetId}`
          : target.targetKind === "dcf" ? `正向 DCF（冻结版本）· ${target.targetId}` : `反向 DCF（冻结版本）· ${target.targetId}`;
    const decisionLabel = (value: StoredTarget["reviewState"]) => ({ requires_review: "待最终人工处置", no_change: "已复核：原对象不变", follow_up_recorded: "已记录后续不可变版本", not_applicable: "已处置：不适用" } as Record<string, string>)[value] || value;
    const targetCandidates = (target: StoredTarget) => target.targetKind === "thesis"
      ? props.theses.filter((item) => item.thesisId && item.thesisId !== target.targetId).map((item) => ({ id: item.thesisId!, label: item.title }))
      : target.targetKind === "risk" ? props.risks.filter((item) => item.riskId && item.riskId !== target.targetId).map((item) => ({ id: item.riskId!, label: item.title })) : [];
    const beginDisposition = (target: StoredTarget) => { resolvingTargetId.value = target.impactReviewTargetId; disposition.value = "no_change"; dispositionRationale.value = ""; followUpTargetId.value = ""; error.value = ""; notice.value = ""; };
    const resolveTarget = async (target: StoredTarget) => { resolving.value = true; error.value = ""; notice.value = ""; try {
      if (!dispositionRationale.value.trim()) throw new Error("请记录最终处置的理由；这不会改写命题或风险。");
      if (disposition.value === "follow_up_recorded" && !followUpTargetId.value) throw new Error("请选择已经另行追加的同类命题或风险版本。");
      const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/guidance-event-impact-review-targets/${encodeURIComponent(target.impactReviewTargetId)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: disposition.value, rationale: dispositionRationale.value.trim(), followUpTargetId: disposition.value === "follow_up_recorded" ? followUpTargetId.value : null }) });
      const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存最终处置失败");
      notice.value = "已追加目标级最终处置；原命题或风险及既有快照均未被改写。"; resolvingTargetId.value = ""; emit("saved");
    } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { resolving.value = false; } };
    const save = async () => { saving.value = true; error.value = ""; notice.value = ""; try {
      const source = selected(); if (!source) throw new Error("请选择已有、来源绑定的管理层指引或事件实际复盘");
      if (!rationale.value.trim()) throw new Error("请说明为什么这些记录需要复核");
      if (!thesisIds.value.length && !riskIds.value.length && !modelTargets.value.length) throw new Error("至少选择一项研究命题、风险、情景或估值版本");
      const response = await fetch(`/api/research/company/${encodeURIComponent(props.securityCode)}/guidance-event-impact-reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceKind: source.kind, sourceId: source.id, rationale: rationale.value.trim(), thesisIds: thesisIds.value, riskIds: riskIds.value, modelTargets: modelTargets.value }) });
      const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "保存复核映射失败");
      notice.value = `已追加复核映射；为明确选定的 ${body.data.modelReviewItemsCreated || 0} 个冻结版本创建待复核项，未改写任何命题、风险、情景或模型。`;
      open.value = false; rationale.value = ""; thesisIds.value = []; riskIds.value = []; modelTargets.value = []; emit("saved");
    } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { saving.value = false; } };
    return () => h("section", { class: "research-card impact-review" }, [h("style", css), h("div", { class: "section-head" }, [h("div", [h("h2", "来源结果 → 精确复核队列"), h("p", { class: "research-meta mb-0" }, "仅把已有来源绑定的管理层指引、事件实际或已接受法定实际映射到明确选定的命题、风险、情景和冻结估值版本；不会自动确认、削弱、推翻或改写任何结论。")]), props.canWrite ? h("button", { class: "btn btn-outline-success btn-sm", onClick: () => { open.value = !open.value; error.value = ""; notice.value = ""; if (!sourceValue.value) sourceValue.value = sources()[0] ? `${sources()[0].kind}:${sources()[0].id}` : ""; } }, open.value ? "收起" : "新增复核映射") : h("span", { class: "research-meta" }, "生产只读")]),
      !sources().length ? h("div", { class: "research-note mt-3" }, "尚无可映射来源：先保存带来源的管理层指引、事件实际复盘，或接受法定实际候选。") : null,
      props.reviews.length ? props.reviews.slice(0, 8).map((item) => h("article", { class: "impact-review-item" }, [
        h("strong", `${sourceKindLabel(item.sourceKind)} · 已映射 ${item.targets.length} 项`), h("p", { class: "mb-1 small" }, item.sourceBinding?.statement || "来源陈述待补"),
        h("p", { class: "research-meta mb-1" }, `映射理由：${item.rationale}。映射不是结论，目标必须逐项人工处置。`),
        ...(item.sourceBinding?.sourceReferences || []).map((ref) => ref.url ? h("a", { class: "evidence-link me-2", href: ref.url, target: "_blank", rel: "noreferrer" }, ref.title || ref.url) : null),
        ...item.targets.map((target) => {
          const isModel = ["scenario", "dcf", "reverse_dcf"].includes(target.targetKind);
          const pending = target.reviewState === "requires_review";
          const action = target.action;
          const candidates = targetCandidates(target);
          return h("div", { class: `impact-target ${pending ? "pending" : "final"}` }, [
            h("div", { class: "d-flex flex-wrap gap-2 align-items-center" }, [h("strong", { class: "small" }, targetLabel(target)), h("span", { class: `impact-target-state ${pending ? "" : "final"}` }, isModel && pending ? "冻结模型待复核" : decisionLabel(target.reviewState))]),
            action ? h("div", { class: "research-meta mt-1" }, [
              `最终理由：${action.rationale}；操作者：${action.actedBy}；时间：${new Date(action.actedAt).toLocaleString("zh-CN", { hour12: false })}`,
              action.followUpTargetId ? `；后续不可变版本：${action.followUpTargetId}` : "",
            ]) : pending ? h("p", { class: "research-meta mb-0 mt-1" }, isModel ? "请在对应冻结模型待复核项中记录处置；本处不改写模型。" : "尚无最终人工处置；不会自动改变命题、风险或结论。") : null,
            pending && !isModel && props.canWrite ? h("div", { class: "mt-2" }, [
              resolvingTargetId.value === target.impactReviewTargetId ? h("div", { class: "impact-resolution-form" }, [
                h("label", ["最终处置", h("select", { value: disposition.value, onChange: (event: Event) => disposition.value = (event.target as HTMLSelectElement).value as ImpactAction["decision"] }, [h("option", { value: "no_change" }, "已复核，原对象不变"), h("option", { value: "follow_up_recorded" }, "已另行追加后续不可变版本"), h("option", { value: "not_applicable" }, "不适用")])]),
                disposition.value === "follow_up_recorded" ? h("label", ["后续版本", h("select", { value: followUpTargetId.value, onChange: (event: Event) => followUpTargetId.value = (event.target as HTMLSelectElement).value }, [h("option", { value: "" }, "请选择已追加版本"), ...candidates.map((candidate) => h("option", { value: candidate.id }, `${candidate.label} · ${candidate.id}`))])]) : null,
                h("label", { class: "impact-resolution-wide" }, ["最终处置理由", h("textarea", { value: dispositionRationale.value, onInput: (event: Event) => dispositionRationale.value = (event.target as HTMLTextAreaElement).value, placeholder: "记录为什么不变、为何不适用，或为何引用这个后续不可变版本。" })]),
                h("div", { class: "impact-resolution-wide d-flex gap-2" }, [h("button", { class: "btn btn-success btn-sm", disabled: resolving.value, onClick: () => void resolveTarget(target) }, resolving.value ? "保存中…" : "追加最终处置"), h("button", { class: "btn btn-link btn-sm", disabled: resolving.value, onClick: () => resolvingTargetId.value = "" }, "取消")]),
              ]) : h("button", { class: "btn btn-outline-success btn-sm", onClick: () => beginDisposition(target) }, "记录最终处置")
            ]) : pending && !isModel ? h("p", { class: "research-meta mb-0 mt-2" }, "生产只读；目标级处置只能在本地研究运行时追加。") : null,
          ]);
        }),
      ])) : h("p", { class: "research-meta mt-3" }, "尚无来源—目标复核映射。来源记录本身不是投资判断。"),
      open.value ? h("div", { class: "impact-review-form" }, [h("label", { class: "impact-review-wide" }, ["来源记录", h("select", { value: sourceValue.value, onChange: (event: Event) => sourceValue.value = (event.target as HTMLSelectElement).value }, [h("option", { value: "" }, "请选择"), ...sources().map((item) => h("option", { value: `${item.kind}:${item.id}` }, item.label))])]), h("label", { class: "impact-review-wide" }, ["需要人工复核的原因", h("textarea", { value: rationale.value, onInput: (event: Event) => rationale.value = (event.target as HTMLTextAreaElement).value, placeholder: "说明来源记录与既有对象的可审计关联；不要写成系统结论。" })]), h("div", { class: "impact-review-wide" }, [h("strong", { class: "small" }, "受影响研究命题（仅加入待复核）"), h("div", { class: "impact-review-targets mt-2" }, props.theses.map((item) => h("label", [h("input", { type: "checkbox", checked: thesisIds.value.includes(item.thesisId || ""), onChange: (event: Event) => toggle("thesis", item.thesisId || "", (event.target as HTMLInputElement).checked) }), item.title])))]), h("div", { class: "impact-review-wide" }, [h("strong", { class: "small" }, "受影响风险台账（仅加入待复核）"), h("div", { class: "impact-review-targets mt-2" }, props.risks.map((item) => h("label", [h("input", { type: "checkbox", checked: riskIds.value.includes(item.riskId || ""), onChange: (event: Event) => toggle("risk", item.riskId || "", (event.target as HTMLInputElement).checked) }), item.title])))]), h("div", { class: "impact-review-wide" }, [h("strong", { class: "small" }, "受影响情景 / 冻结估值版本（只创建明确选择的待复核项）"), availableModelTargets().length ? h("div", { class: "impact-review-targets mt-2" }, availableModelTargets().map((item) => h("label", [h("input", { type: "checkbox", checked: modelTargets.value.some((target) => target.targetKind === item.targetKind && target.targetId === item.targetId), onChange: (event: Event) => toggleModel(item, (event.target as HTMLInputElement).checked) }), item.label]))) : h("p", { class: "research-meta mb-0" }, "当前没有可选择的自建情景或冻结估值版本；可只映射命题或风险。")]), h("div", { class: "impact-review-wide d-flex gap-2" }, [h("button", { class: "btn btn-success btn-sm", disabled: saving.value, onClick: () => void save() }, saving.value ? "保存中…" : "追加待复核映射"), h("button", { class: "btn btn-link btn-sm", disabled: saving.value, onClick: () => open.value = false }, "取消")])]) : null,
      error.value ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error.value) : null, notice.value ? h("div", { class: "alert alert-success py-2 mt-3 mb-0" }, notice.value) : null,
    ]);
  },
});

function sourceKindLabel(kind: string) { return kind === "management_guidance" ? "管理层指引" : kind === "catalyst_actual" ? "事件实际" : kind === "formal_actual" ? "已接受法定实际" : kind; }
