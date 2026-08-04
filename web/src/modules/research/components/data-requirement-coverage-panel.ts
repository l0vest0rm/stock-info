import { defineComponent, h, type PropType } from "vue";

type Item = Record<string, unknown>;

function list(value: unknown): Item[] { return Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function text(value: unknown): string { return value === null || value === undefined || value === "" ? "—" : String(value); }
function date(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleDateString("zh-CN") : "待补";
}
function stateLabel(value: unknown): string {
  return ({ available: "可得", partial: "部分可得", missing: "待补", stale: "已过期", conflict: "冲突", source_error: "来源异常" } as Record<string, string>)[String(value)] || text(value);
}
function stateClass(value: unknown): string { return `requirement-state ${String(value || "missing")}`; }
function sourceList(items: Item[]): string { return items.map((item) => `${text(item.label)} · ${stateLabel(item.status)}`).join("；") || "—"; }

/** Read-only companion to the module-level coverage card.  It makes the
 * required fact, source policy and conclusion impact inspectable one by one,
 * rather than compressing them into a completion score. */
export const DataRequirementCoveragePanel = defineComponent({
  name: "DataRequirementCoveragePanel",
  props: { coverage: { type: Object as PropType<Item>, required: true } },
  setup(props) {
    return () => {
      const requirements = list(props.coverage.requirements);
      const sources = list(props.coverage.sourceHealth);
      return h("section", { class: "research-card section-card data-requirement-panel" }, [
        h("style", ".data-requirement-panel .requirement-state{display:inline-block;border-radius:999px;padding:.16rem .45rem;font-size:.74rem;font-weight:700;background:#e2e8f0;color:#334155}.data-requirement-panel .requirement-state.available{background:#d1fae5;color:#065f46}.data-requirement-panel .requirement-state.partial,.data-requirement-panel .requirement-state.stale{background:#fef3c7;color:#92400e}.data-requirement-panel .requirement-state.missing{background:#f1f5f9;color:#475569}.data-requirement-panel .requirement-state.conflict,.data-requirement-panel .requirement-state.source_error{background:#fee2e2;color:#991b1b}.data-source-health summary{cursor:pointer;color:#0f766e;font-weight:700}"),
        h("div", { class: "section-head" }, [
          h("div", [
            h("h2", "事实需求、来源健康与研究缺口"),
            h("p", { class: "research-meta mb-0" }, `规则 ${text(props.coverage.ruleVersion)}。逐项显示可得性、时效、冲突和缺失影响；不计算完成率，也不把待补视为中性。`),
          ]),
          h("span", { class: "research-state" }, `截止 ${date(props.coverage.asOf)}`),
        ]),
        requirements.length ? h("div", { class: "table-responsive mt-3" }, h("table", { class: "table table-sm research-table mb-0" }, [
          h("thead", h("tr", ["事实需求", "当前可得性 / 截止日", "来源与交叉来源", "频率 / 认识类型", "缺失影响与下一证据"].map((label) => h("th", label)))),
          h("tbody", requirements.map((item) => h("tr", { key: text(item.requirementId) }, [
            h("td", [h("strong", text(item.label)), h("div", { class: "research-meta mt-1" }, text(item.category))]),
            h("td", [h("span", { class: stateClass(item.status) }, stateLabel(item.status)), h("div", { class: "research-meta mt-1" }, `数据截止：${date(item.asOf)}${item.conflictCount ? `；冲突 ${item.conflictCount}` : ""}`)]),
            h("td", [h("div", text(sourceList(list(item.primarySources)))), list(item.crossSources).length ? h("div", { class: "research-meta mt-1" }, `交叉：${sourceList(list(item.crossSources))}`) : null]),
            h("td", [h("div", text(item.frequency)), h("div", { class: "research-meta mt-1" }, `认识类型：${text(item.epistemicType)}`)]),
            h("td", [h("div", text(item.missingImpact)), h("div", { class: "research-meta mt-1" }, `下一步：${text(item.nextEvidence)}`)]),
          ]))),
        ])) : h("p", { class: "research-meta mt-3 mb-0" }, "事实需求字典尚未加载；不能把模块卡片当作逐项来源覆盖。"),
        sources.length ? h("details", { class: "data-source-health mt-3" }, [
          h("summary", "查看来源健康、时效与冲突"),
          h("p", { class: "research-meta mt-2" }, "状态仅代表当前公司/证券在本次读取中的观察，不代表第三方供应商的全局 SLA。"),
          h("div", { class: "table-responsive" }, h("table", { class: "table table-sm research-table mb-0" }, [
            h("thead", h("tr", ["来源", "状态", "最近观察", "时效 / 冲突", "策略或异常"].map((label) => h("th", label)))),
            h("tbody", sources.map((item) => h("tr", { key: text(item.sourceId) }, [
              h("td", h("strong", text(item.label))), h("td", h("span", { class: stateClass(item.status) }, stateLabel(item.status))), h("td", date(item.observedAt)),
              h("td", `数据年龄：${item.ageDays === null || item.ageDays === undefined ? "待补" : `${text(item.ageDays)} 天`}；冲突：${text(item.conflictCount || 0)}`), h("td", text(item.detail)),
            ]))),
          ])),
        ]) : null,
      ]);
    };
  },
});
