import { createApp, defineComponent, h, onMounted, ref } from "vue";

type Gate = { id: string; label: string; state: string; score: number | null; summary: string; nextStep: string };
type RiskReference = { evidenceId: string; title: string; url: string; publishedAt: number; grade: string };
type RiskProfile = { state: string; summary: string; ruleVersion: string; dimensions: Array<{ id: string; label: string; severity: string; summary: string; findingCount: number }>; findings: Array<{ id: string; dimension: string; severity: string; title: string; summary: string; whyItMatters: string; trigger: string; reviewRule: string; references: RiskReference[] }>; gaps: Array<{ id: string; label: string; impact: string; status: string }> };
type CoverageItem = { id: string; label: string; state: string; summary: string; nextStep?: string; blocking?: boolean };
type ResearchCompletion = {
  coverageLevel: string;
  state: string;
  summary: string;
  requirements: Array<{ id: string; label: string; requiredAt: string; status: string; blocking: boolean; effect: string; nextStep: string }>;
  gaps: Array<{ id: string; label: string; status: string; effect: string; nextStep: string }>;
  reviewedAt: number | null;
  frozenAt: number | null;
  ruleVersion: string;
};
type ResearchFoundation = {
  ruleVersion: string;
  object: { securityCode: string; securityName: string; exchangeName: string | null; currency: string | null; operatingCompanyId: string | null };
  completions: Partial<Record<"basic" | "standard" | "deep", ResearchCompletion>>;
  sourceFacts: Array<{ id: string; label: string; value: string | number | null; asOf: number | null; sourceIds: string[] }>;
  derivedObservations: Array<{ id: string; label: string; formula: string; unit: string; asOf: number | null; value: string | number | null; state: string; sourceFacts: string[]; adjustments: string[]; missingInputIds: string[] }>;
  forecast?: {
    state?: string;
    summary?: string;
    gaps?: Array<{ id: string; label: string; status: string; effect: string; nextStep: string }>;
  };
};
type Payload = { code: string; name: string; generatedAt: number; decision: { state: string; summary: string; gates: Gate[]; metrics: Record<string, number | null>; nextSteps: string[]; ruleVersion: string }; riskProfile: RiskProfile; evidence: Array<{ evidenceId: string; title: string; url: string; publishedAt: number; sourceId: string; grade: string; eventStatus: string }>; documents: { total: number; reports: number }; dataHealth: { kline: { source: string; rows: number; latestDate: string | null }; limitations: string[] }; foundation?: ResearchFoundation };

const styles = `.research-page{background:#f4f7f8;color:#172b2a;min-height:calc(100vh - 8rem);padding:1.25rem 0 2.5rem}.research-shell{max-width:1200px}.research-hero,.research-card{background:#fff;border:1px solid #dbe7e5;border-radius:1rem;box-shadow:0 .5rem 1.3rem rgba(15,52,51,.05)}.research-hero{background:linear-gradient(135deg,#112f43,#0f766e);color:#f8fafc;padding:1.35rem}.research-hero h1{font-size:1.7rem;margin:.35rem 0}.research-grid{display:grid;gap:1rem;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:1rem}.research-card{padding:1rem}.research-card h2{color:#123a67;font-size:1.05rem}.research-gate{border-left:4px solid #94a3b8}.research-gate.pass{border-color:#0f766e}.research-gate.watch{border-color:#d97706}.research-gate.blocked{border-color:#dc2626}.research-gate.unavailable{border-color:#94a3b8}.research-state{display:inline-block;background:#e2e8f0;border-radius:999px;color:#334155;font-size:.82rem;font-weight:700;padding:.28rem .65rem}.research-meta{color:#64748b;font-size:.82rem}.research-list{margin:0;padding-left:1.1rem}.research-table{font-size:.86rem}.research-table td,.research-table th{vertical-align:top}.research-note{background:#f8fafc;border:1px dashed #a9bbb9;border-radius:.75rem;padding:.75rem}.risk-workbench{margin-top:1.5rem;background:#102f43;border-radius:1rem;padding:1rem}.risk-workbench h2{color:#fff}.risk-workbench .research-meta{color:#cbd5e1}.risk-overview{display:flex;align-items:start;justify-content:space-between;gap:1rem}.risk-dimension-grid,.risk-finding-grid,.risk-gap-grid{display:grid;gap:.8rem}.risk-dimension-grid{grid-template-columns:repeat(4,minmax(0,1fr));margin:1rem 0}.risk-finding-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.risk-gap-grid{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:.8rem}.risk-dimension,.risk-finding,.risk-gap{background:#fff;border-radius:.75rem;padding:.9rem}.risk-dimension{border-top:4px solid #94a3b8}.risk-finding{border-left:5px solid #94a3b8}.risk-finding.critical{border-color:#b91c1c}.risk-finding.high{border-color:#dc2626}.risk-finding.medium{border-color:#d97706}.risk-finding.low{border-color:#0f766e}.risk-finding.unavailable{border-color:#64748b}.risk-level{font-size:.75rem;font-weight:700}.risk-detail{font-size:.86rem;margin:.55rem 0 0}.risk-detail strong{display:block;color:#334155;font-size:.75rem;margin-bottom:.1rem}.risk-references{margin:.6rem 0 0;padding-left:1rem;font-size:.82rem}@media(max-width:900px){.research-grid,.risk-dimension-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.risk-finding-grid,.risk-gap-grid{grid-template-columns:1fr}}@media(max-width:600px){.research-grid,.risk-dimension-grid{grid-template-columns:1fr}.research-page{padding:.75rem 0}.risk-overview{display:block}}`;
function queryCode(): string { return new URLSearchParams(location.search).get("code")?.trim() || ""; }
function stateText(value: string): string { return ({ pass: "通过", watch: "观察", blocked: "阻断", unavailable: "待补", available: "可用", partial: "部分", complete: "完整", missing: "待补", stale: "过期", conflicting: "冲突", object_mismatch: "对象/口径错误", conflicted: "存在冲突", ready_for_review: "待复核", frozen: "已冻结" } as Record<string, string>)[value] ?? value; }
function riskSeverityText(value: string): string { return ({ critical: "优先复核", high: "高风险", medium: "中风险", low: "低风险", unavailable: "待补" } as Record<string, string>)[value] ?? value; }
function money(value: number | null | undefined): string { return value === null || value === undefined ? "—" : Number(value).toFixed(2); }
function date(value: number): string { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }

const App = defineComponent({ setup() {
  const payload = ref<Payload | null>(null); const error = ref(""); const loading = ref(true);
  const load = async () => { const code = queryCode(); if (!code) { error.value = "请从公司页面带入股票代码。"; loading.value = false; return; } loading.value = true; error.value = ""; try { const response = await fetch(`/api/research/company/${encodeURIComponent(code)}`); const body = await response.json().catch(() => null); if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `读取研究数据失败（${response.status}）`); payload.value = body.data; } catch (err) { error.value = err instanceof Error ? err.message : String(err); } finally { loading.value = false; } };
  onMounted(() => { void load(); });
  return () => h("main", { class: "research-page" }, [h("style", styles), h("div", { class: "container research-shell" }, [loading.value ? h("div", { class: "research-card text-center text-muted py-5" }, "正在读取可审计研究数据…") : error.value ? h("div", { class: "research-card" }, [h("h1", "研究数据暂不可用"), h("p", error.value), h("button", { class: "btn btn-outline-success btn-sm", onClick: () => void load() }, "重试")]) : payload.value ? render(payload.value) : null])]);
} });

function render(data: Payload) {
  const metrics = data.decision.metrics;
  const evidenceRows = data.evidence.map((item) => h("tr", { key: item.evidenceId }, [
    h("td", [h("a", { href: item.url, target: "_blank", rel: "noreferrer" }, item.title)]),
    h("td", `${item.grade} / ${item.eventStatus}`),
    h("td", `${item.sourceId} · ${date(item.publishedAt)}`),
  ]));
  const evidenceBody = evidenceRows.length
    ? h("div", { class: "table-responsive" }, h("table", { class: "table table-sm research-table mb-0" }, [
      h("thead", h("tr", [h("th", "证据"), h("th", "等级"), h("th", "来源 / 时间")])),
      h("tbody", evidenceRows),
    ]))
    : h("div", { class: "research-note" }, "尚无精确关联证据；这不是负面判断，而是要求先补原始来源。");
  const hero = h("section", { class: "research-hero" }, [
    h("div", { class: "small opacity-75" }, "AUDITABLE SECURITY RESEARCH"), h("h1", `${data.name} · ${data.code}`),
    h("span", { class: "research-state" }, data.decision.state), h("p", { class: "mb-0 mt-2 opacity-75" }, data.decision.summary),
    h("div", { class: "research-meta text-white-50 mt-2" }, `生成于 ${date(data.generatedAt)} · 规则 ${data.decision.ruleVersion}`),
  ]);
  const foundation = data.foundation;
  const researchObject = foundation?.object;
  const scopeCard = h("section", { class: "research-card mt-3" }, [
    h("div", { class: "d-flex flex-wrap justify-content-between gap-2 align-items-start" }, [
      h("div", [h("h2", "研究对象与边界"), h("p", { class: "small mb-0" }, "经营公司与上市证券是两个对象。本页不会把当前代码的价格、估值或股东权利自动当作经营公司的通用结论。")]),
      h("span", { class: "research-state" }, "对象待持续核验"),
    ]),
    h("div", { class: "row g-3 mt-1" }, [
      h("div", { class: "col-md-6" }, [h("div", { class: "research-note h-100" }, [h("strong", "当前上市证券"), h("div", { class: "mt-1" }, `${researchObject?.securityName ?? data.name} · ${researchObject?.securityCode ?? data.code}`), h("div", { class: "research-meta mt-1" }, `${researchObject?.exchangeName ?? "交易市场待补"} · ${researchObject?.currency ?? "币种待补"}。股份类别与股东权利仍待证券基础档案确认。`)])]),
      h("div", { class: "col-md-6" }, [h("div", { class: "research-note h-100" }, [h("strong", "对应经营公司"), h("div", { class: "mt-1" }, researchObject?.operatingCompanyId ?? "尚未建立可复核的经营主体映射"), h("div", { class: "research-meta mt-1" }, researchObject?.operatingCompanyId ? "经营公司基础档案需与证券价格、股本和权利信息分层复核。" : "在有明确映射前，不能假定名称相同的经营公司、A/H 股或 ADR 可共用本页结论。")])]),
    ]),
  ]);
  const defaultCoverage: CoverageItem[] = [
    { id: "evidence", label: "来源证据", state: data.evidence.length ? "partial" : "missing", summary: data.evidence.length ? `已关联 ${data.evidence.length} 条可访问证据；仍须按事实、指引、预测、观点和假设分层。` : "没有精确关联的原始证据，不能以摘要补写命题。", nextStep: "补充公告、法定披露或可访问的原始材料。" },
    { id: "market", label: "证券市场数据", state: data.dataHealth.kline.rows >= 30 ? "partial" : "missing", summary: `日线 ${data.dataHealth.kline.rows} 行，来源 ${data.dataHealth.kline.source}，最新 ${data.dataHealth.kline.latestDate ?? "待补"}。价格只作辅助观察。`, nextStep: "核对市场、币种、股本和证券权利的基础档案。" },
    { id: "financial", label: "财务质量", state: "missing", summary: "尚未在此研究快照中加载三表、现金流、资本效率或每股价值的统一口径。", nextStep: "先确认财报期、币种、基本/稀释股本与报表覆盖。" },
    { id: "industry", label: "行业与竞争", state: "missing", summary: "尚未建立从主营赛道到公司实际暴露、竞争市场和同行可比性的可复核映射。", nextStep: "建立主营行业档案与公司暴露证据，避免以主题标签替代主营。" },
    { id: "forecast", label: "预测与估值", state: "missing", summary: "当前仅有历史 PE/PB 位置，不等同于盈利路径、反向估值或价值区间。", nextStep: "分开录入管理层指引、来源预测与分析假设，再加载情景估值。" },
  ];
  const completionEntries = foundation ? (Object.entries(foundation.completions) as Array<[string, ResearchCompletion | undefined]>).filter((entry): entry is [string, ResearchCompletion] => Boolean(entry[1])) : [];
  const foundationCoverage: CoverageItem[] = completionEntries.flatMap(([level, completion]) => [
    ...completion.requirements.map((item) => ({ id: `${level}:requirement:${item.id}`, label: `${level}层 · ${item.label}`, state: item.status, summary: item.effect, nextStep: item.nextStep, blocking: item.blocking })),
    ...completion.gaps.map((item) => ({ id: `${level}:gap:${item.id}`, label: `${level}层 · ${item.label}`, state: item.status, summary: item.effect, nextStep: item.nextStep, blocking: true })),
  ]);
  const coverage = foundationCoverage.length ? foundationCoverage : defaultCoverage;
  const coverageCard = h("section", { class: "research-card mt-3" }, [
    h("div", { class: "d-flex flex-wrap justify-content-between gap-2" }, [h("div", [h("h2", "研究覆盖与下一步"), h("p", { class: "research-meta mb-3" }, completionEntries.length ? `基础、标准、深度层分别保留阻断条件；规则 ${foundation?.ruleVersion ?? "待补"}。` : "状态按阻断缺失、冲突、过期和已验证输入展示，不计算会掩盖关键缺口的总分。")]), completionEntries.length ? h("div", { class: "d-flex flex-wrap gap-2" }, completionEntries.map(([level, completion]) => h("span", { class: "research-state", key: level }, `${level}层 · ${stateText(completion.state)}`))) : null]),
    h("div", { class: "research-grid mt-0" }, coverage.map((item) => h("article", { class: `research-note research-gate ${item.state}`, key: item.id }, [h("div", { class: "d-flex justify-content-between gap-2" }, [h("strong", item.label), h("span", { class: "research-state" }, item.blocking ? `阻断 · ${stateText(item.state)}` : stateText(item.state))]), h("p", { class: "small mb-1 mt-2" }, item.summary), item.nextStep ? h("div", { class: "research-meta" }, `下一步：${item.nextStep}`) : null]))),
  ]);
  const sourceFacts = foundation?.sourceFacts ?? [];
  const observations = foundation?.derivedObservations ?? [];
  const sourceFactsTable = sourceFacts.length ? h("div", { class: "table-responsive" }, [
    h("table", { class: "table table-sm research-table" }, [
      h("thead", h("tr", [h("th", "来源事实"), h("th", "值"), h("th", "截止日 / 关联来源")])),
      h("tbody", sourceFacts.map((item) => h("tr", { key: item.id }, [
        h("td", item.label),
        h("td", item.value === null ? "待补" : String(item.value)),
        h("td", `${item.asOf ? date(item.asOf) : "待补"} · ${item.sourceIds.length} 个来源`),
      ]))),
    ]),
  ]) : null;
  const observationTable = observations.length ? h("div", { class: "table-responsive mt-3" }, [
    h("table", { class: "table table-sm research-table mb-0" }, [
      h("thead", h("tr", [h("th", "派生观察"), h("th", "值"), h("th", "公式 / 状态")])),
      h("tbody", observations.map((item) => h("tr", { key: item.id }, [
        h("td", [h("strong", item.label), h("div", { class: "research-meta" }, `截止 ${item.asOf ? date(item.asOf) : "待补"} · 输入 ${item.sourceFacts.length} 项`)]),
        h("td", item.value === null ? "不可得" : `${item.value}${item.unit ? ` ${item.unit}` : ""}`),
        h("td", [h("div", item.formula), h("div", { class: "research-meta" }, `${stateText(item.state)}${item.missingInputIds.length ? ` · 缺 ${item.missingInputIds.length} 项输入` : ""}`)]),
      ]))),
    ]),
  ]) : null;
  const observationsCard = (sourceFacts.length || observations.length) ? h("section", { class: "research-card mt-3" }, [
    h("h2", "来源事实与可复算观察"),
    h("p", { class: "research-meta" }, "来源事实、公式输出和研究判断分开显示；缺失输入不会被自动补零。"),
    sourceFactsTable,
    observationTable,
  ]) : null;
  const gates = h("section", { class: "research-grid" }, data.decision.gates.map((gate) => h("article", { class: `research-card research-gate ${gate.state}`, key: gate.id }, [
    h("div", { class: "d-flex justify-content-between gap-2" }, [h("h2", gate.label), h("span", { class: "research-state" }, stateText(gate.state))]),
    h("div", { class: "fs-4 fw-bold mb-2" }, gate.score === null ? "—" : gate.id === "trigger" || gate.id === "risk" ? `${gate.score.toFixed(1)}%` : gate.score.toFixed(1)),
    h("p", { class: "small mb-2" }, gate.summary), h("div", { class: "research-meta" }, `下一步：${gate.nextStep}`),
  ])));
  const risk = data.riskProfile;
  const riskWorkbench = h("section", { class: "risk-workbench" }, [
    h("div", { class: "risk-overview" }, [h("div", [h("div", { class: "small text-white-50" }, "RISK REGISTER · 可审计风险台账"), h("h2", { class: "mt-1 mb-2" }, "风险分析与持续监测"), h("p", { class: "mb-0 text-white-50" }, risk.summary)]), h("span", { class: "research-state" }, risk.state)]),
    h("div", { class: "research-meta mt-2" }, `规则 ${risk.ruleVersion} · 风险条目不会生成交易指令`),
    h("div", { class: "risk-dimension-grid" }, risk.dimensions.map((item) => h("article", { class: `risk-dimension ${item.severity}`, key: item.id }, [h("div", { class: "d-flex justify-content-between gap-2" }, [h("strong", item.label), h("span", { class: "risk-level" }, riskSeverityText(item.severity))]), h("div", { class: "research-meta mt-1" }, `${item.findingCount} 项可审计条目`), h("p", { class: "small mb-0 mt-2" }, item.summary)]))),
    h("div", { class: "risk-finding-grid" }, risk.findings.length ? risk.findings.map((item) => h("article", { class: `risk-finding ${item.severity}`, key: item.id }, [h("div", { class: "d-flex justify-content-between gap-2" }, [h("h3", { class: "h6 mb-1" }, item.title), h("span", { class: "risk-level" }, riskSeverityText(item.severity))]), h("p", { class: "small mb-0" }, item.summary), h("div", { class: "risk-detail" }, [h("strong", "为何重要"), item.whyItMatters]), h("div", { class: "risk-detail" }, [h("strong", "升级触发"), item.trigger]), h("div", { class: "risk-detail" }, [h("strong", "复核/降级规则"), item.reviewRule]), item.references.length ? h("ul", { class: "risk-references" }, item.references.map((ref) => h("li", { key: ref.evidenceId }, [h("a", { href: ref.url, target: "_blank", rel: "noreferrer" }, ref.title), ` · ${ref.grade} · ${date(ref.publishedAt)}`]))) : null])) : h("div", { class: "risk-note" }, "当前没有可审计的具体风险条目；这不等同于没有风险，请先检查下方覆盖缺口。")),
    h("h3", { class: "h6 text-white mt-3 mb-1" }, "尚未覆盖的风险输入"),
    h("div", { class: "risk-gap-grid" }, risk.gaps.map((item) => h("article", { class: "risk-gap", key: item.id }, [h("strong", item.label), h("div", { class: "research-meta mt-1" }, item.status === "source_unhealthy" ? "来源健康异常" : "尚未接入"), h("p", { class: "small mb-0 mt-2" }, item.impact)]))),
  ]);
  const metricPairs: Array<[string, string]> = [["收盘价", money(metrics.close)], ["PE(TTM)", money(metrics.peTtm)], ["PB", money(metrics.pb)], ["PE 历史分位", metrics.pePercentile === null ? "待补" : `${metrics.pePercentile.toFixed(1)}%`], ["PB 历史分位", metrics.pbPercentile === null ? "待补" : `${metrics.pbPercentile.toFixed(1)}%`], ["近20日", metrics.return20d === null ? "待补" : `${metrics.return20d.toFixed(1)}%`], ["近90日回撤", metrics.drawdown90d === null ? "待补" : `${metrics.drawdown90d.toFixed(1)}%`], ["本地文档", `${data.documents.total} 条 / 研报 ${data.documents.reports} 条`]];
  const metricCard = h("section", { class: "research-card mt-3" }, [h("h2", "市场与资料快照"), h("div", { class: "row g-3" }, metricPairs.map(([label, value]) => h("div", { class: "col-6 col-md-3" }, [h("div", { class: "research-meta" }, label), h("strong", value)])))]);
  const evidenceCard = h("article", { class: "research-card h-100" }, [h("h2", "关联原始证据"), evidenceBody]);
  const healthCard = h("article", { class: "research-card h-100" }, [h("h2", "研究缺口与数据健康"), h("ul", { class: "research-list small" }, data.decision.nextSteps.map((item) => h("li", item))), h("hr"), h("div", { class: "research-meta" }, `日线：${data.dataHealth.kline.rows} 行 · ${data.dataHealth.kline.source} · 最新 ${data.dataHealth.kline.latestDate ?? "待补"}`), h("ul", { class: "research-list small mt-2" }, data.dataHealth.limitations.map((item) => h("li", item)))]);
  return [hero, scopeCard, coverageCard, observationsCard, gates, riskWorkbench, metricCard, h("section", { class: "row g-3 mt-1" }, [h("div", { class: "col-lg-7" }, [evidenceCard]), h("div", { class: "col-lg-5" }, [healthCard])])];
}
const root = document.getElementById("company-research-vue-root"); if (root) createApp(App).mount(root);
