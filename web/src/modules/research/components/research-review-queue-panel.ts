import { defineComponent, h } from "vue";

type QueueItem = {
  queueItemId: string;
  kind: string;
  state: "requires_action" | "blocked";
  observedAt: number | null;
  title: string;
  reason: string;
  source: { kind: string; id: string; url: string | null; title: string | null; version?: string | null; supersedesVersion?: string | null };
  target: { kind: string; id: string } | null;
  impactedTargets?: Array<{ kind: string; id: string }>;
  nextAction: string;
};
type Queue = { ruleVersion?: string; items?: QueueItem[]; openCount?: number };
type ReviewTarget = "evidence" | "forecasts" | "valuation" | "risk_review" | "focus-profile";

const labels: Record<string, string> = {
  source_health: "来源健康",
  thesis_review_due: "命题复核",
  risk_review_due: "风险复核",
  focus_profile_review_due: "重点档案",
  formal_actual_candidate: "法定实际候选",
  model_version: "冻结模型",
  guidance_impact_mapping: "管理层指引",
  event_actual_impact_mapping: "事件实际",
  formal_actual_impact_mapping: "法定实际影响映射",
};
const css = `.research-review-queue{margin-top:1rem;border-left:4px solid #0f766e}.research-review-queue-item{border-top:1px solid #dbe7e5;padding:.7rem 0}.research-review-queue-item.blocked{opacity:.82}.research-review-queue-state{display:inline-block;margin-left:.4rem;border-radius:999px;padding:.15rem .45rem;font-size:.72rem;background:#fef3c7;color:#92400e}.research-review-queue-state.blocked{background:#e2e8f0;color:#475569}.research-review-queue-group{margin-top:.85rem;border:1px solid #d8e5e2;border-radius:.7rem;background:#fbfefd}.research-review-queue-group>summary{cursor:pointer;padding:.7rem .8rem;color:#244d49}.research-review-queue-group>summary small{color:#64748b}.research-review-queue-group-body{padding:0 .8rem .15rem}.research-review-queue-summary{margin-top:.75rem;color:#526462;font-size:.85rem}`;
function date(value: number | null | undefined) { return value && Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "截至日待补"; }
const DEFAULT_VISIBLE_ACTIONS = 6;

/** Routes to read-only research context; never changes a queue item or opens a writer. */
function reviewTarget(item: QueueItem): ReviewTarget {
  if (item.kind === "source_health") return "evidence";
  if (["formal_actual_candidate", "guidance_impact_mapping", "event_actual_impact_mapping", "formal_actual_impact_mapping"].includes(item.kind)) return "forecasts";
  if (item.kind === "model_version") return "valuation";
  if (item.kind === "focus_profile_review_due") return "focus-profile";
  return "risk_review";
}

/** Cross-ledger review inbox.  It only routes a user to the appropriate
 * reviewer action; it never marks a conclusion, source, or model as resolved. */
export const ResearchReviewQueuePanel = defineComponent({
  name: "ResearchReviewQueuePanel",
  props: {
    queue: { type: Object as () => Queue, default: () => ({}) },
    onNavigate: { type: Function as () => ((target: ReviewTarget) => void) | undefined, default: undefined },
  },
  setup(props) {
    return () => {
      const items = Array.isArray(props.queue?.items) ? props.queue.items : [];
      const actions = items.filter((item) => item.state === "requires_action");
      const blocked = items.filter((item) => item.state === "blocked");
      const immediate = actions.slice(0, DEFAULT_VISIBLE_ACTIONS);
      const remainingActions = actions.slice(DEFAULT_VISIBLE_ACTIONS);
      const itemCard = (item: QueueItem) => h("article", { class: `research-review-queue-item ${item.state}` }, [
        h("strong", labels[item.kind] || item.kind), h("span", { class: `research-review-queue-state ${item.state}` }, item.state === "requires_action" ? "需要人工处理" : "上游阻断"),
        h("div", { class: "small mt-1" }, item.title), h("div", { class: "research-meta" }, `${date(item.observedAt)} · ${item.reason}`),
        item.source?.id ? h("div", { class: "research-meta" }, `来源：${item.source.kind} / ${item.source.id}${item.source.version ? ` · ${item.source.version}` : ""}${item.source.supersedesVersion ? ` · 前序 ${item.source.supersedesVersion}` : ""}`) : null,
        item.impactedTargets?.length ? h("div", { class: "research-meta" }, `受影响对象：${item.impactedTargets.map((target) => `${target.kind} / ${target.id}`).join("；")}`) : item.target ? h("div", { class: "research-meta" }, `目标：${item.target.kind} / ${item.target.id}`) : null,
        item.source?.url ? h("a", { class: "evidence-link", href: item.source.url, target: "_blank", rel: "noreferrer" }, item.source.title || "查看来源") : null,
        h("div", { class: "research-meta mt-1" }, `下一步：${item.nextAction}`),
        props.onNavigate ? h("button", { class: "btn btn-outline-success btn-sm mt-2", type: "button", "data-research-review-action": item.kind, onClick: () => props.onNavigate?.(reviewTarget(item)) }, "查看对应研究区") : null,
      ]);
      return h("section", { class: "research-card research-review-queue" }, [
        h("style", css),
        h("div", { class: "section-head" }, [h("div", [h("h2", "统一复核议程"), h("p", { class: "research-meta mb-0" }, `规则 ${props.queue?.ruleVersion || "待初始化"}。来源健康、定期复核、法定实际、指引/事件实际和冻结模型集中显示；任何条目都不会自动改变研究结论。`)]), h("span", { class: "research-state" }, `待处理 ${props.queue?.openCount || 0} 项`)]),
        !items.length ? h("div", { class: "research-note mt-3" }, "尚无待复核记录。没有记录不代表研究已完成，仍需查看资料完整度与研究深度门禁。") : h("div", { class: "mt-3", "data-research-review-queue": "progressive-disclosure" }, [
          h("p", { class: "research-review-queue-summary" }, `优先显示 ${immediate.length} 项可执行复核；另有 ${blocked.length} 项上游阻断，保留完整原因与来源，不把阻断误写为已处理。`),
          ...immediate.map(itemCard),
          remainingActions.length ? h("details", { class: "research-review-queue-group", "data-research-review-queue-group": "more-actions" }, [
            h("summary", [h("strong", `其余 ${remainingActions.length} 项待人工处理`), h("small", " · 默认收起，避免淹没当前优先级")]),
            h("div", { class: "research-review-queue-group-body" }, remainingActions.map(itemCard)),
          ]) : null,
          blocked.length ? h("details", { class: "research-review-queue-group", "data-research-review-queue-group": "blocked" }, [
            h("summary", [h("strong", `上游阻断 ${blocked.length} 项`), h("small", " · 展开查看字段、来源和补证据路径")]),
            h("div", { class: "research-review-queue-group-body" }, blocked.map(itemCard)),
          ]) : null,
        ]),
      ]);
    };
  },
});
