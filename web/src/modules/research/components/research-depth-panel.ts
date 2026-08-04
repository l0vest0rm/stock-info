import { defineComponent, h, type PropType } from "vue";

type Requirement = { id: string; label: string; status: string; blockedConclusion: string; nextEvidence: string };
type Level = { depth: string; label: string; status: string; requirements: Requirement[]; allowedOutput: string; prohibitedOutput: string };

/** A read-first rendering of the framework depth gates. It intentionally has
 * no score and cannot turn a later level green when an earlier input blocks. */
export const ResearchDepthPanel = defineComponent({
  name: "ResearchDepthPanel",
  props: { assessment: { type: Object as PropType<{ ruleVersion?: string; levels?: Level[] }>, required: true } },
  setup(props) {
    return () => {
      const levels = Array.isArray(props.assessment?.levels) ? props.assessment.levels : [];
      return h("section", { class: "research-card section-card" }, [
        h("h2", "研究深度门禁"),
        h("p", { class: "research-meta" }, `按逐项证据判断，不计算总分；规则 ${props.assessment?.ruleVersion || "待初始化"}。后置层级包含前置层级的全部阻断项。`),
        levels.length ? h("div", { class: "research-grid three" }, levels.map((level) => h("article", { class: "research-note" }, [
          h("div", { class: "section-head" }, [h("strong", level.label), h("span", { class: "research-state" }, level.status)]),
          h("p", { class: "small mt-2 mb-1" }, `可输出：${level.allowedOutput}`),
          h("p", { class: "research-meta mb-2" }, `不得输出：${level.prohibitedOutput}`),
          h("ul", { class: "research-list small mb-0" }, level.requirements.map((item) => h("li", [
            h("strong", `${item.label} · ${item.status}`),
            item.status === "ready" ? null : h("div", { class: "research-meta" }, `${item.blockedConclusion} 下一步：${item.nextEvidence}`),
          ]))),
        ]))) : h("p", { class: "research-note mb-0" }, "研究深度尚未计算；不能从页面长度或模型数量推断完成度。"),
      ]);
    };
  },
});
