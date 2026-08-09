import { createApp, defineComponent, h, nextTick, onMounted, ref } from "vue";
import { IndustryComparabilityWorkbench } from "../components/industry-comparability-workbench";
import { OperatingMarketWorkbench } from "../components/operating-market-workbench";
import { RiskReviewWorkbench } from "../components/risk-review-workbench";
import { SnapshotHistoryWorkbench } from "../components/snapshot-history-workbench";
import { ResearchSnapshotHistoryWorkbench } from "../components/research-snapshot-history-workbench";
import { CatalystReviewWorkbench } from "../components/catalyst-review-workbench";
import { GuidanceEventImpactReviewWorkbench } from "../components/guidance-event-impact-review-workbench";
import { InformationEvidenceCandidatesPanel } from "../components/information-evidence-candidates-panel";
import { OperatingSourceFactsPanel } from "../components/operating-source-facts-panel";
import { OperatingSourceFactBindingsPanel } from "../components/operating-source-fact-bindings-panel";
import { IndustryKpiDriverBindingsPanel } from "../components/industry-kpi-driver-bindings-panel";
import { ResearchDepthPanel } from "../components/research-depth-panel";
import { DataRequirementCoveragePanel } from "../components/data-requirement-coverage-panel";
import { MarketStructureFactsPanel } from "../components/market-structure-facts-panel";
import { FinancialEntityProfilePanel } from "../components/financial-entity-profile-panel";
import { FinancialSpecialtyMetricsPanel } from "../components/financial-specialty-metrics-panel";
import { GovernanceCapitalFactsPanel } from "../components/governance-capital-facts-panel";
import { ResearchReviewQueuePanel } from "../components/research-review-queue-panel";
import { CompanyFocusProfilePanel } from "../components/company-focus-profile-panel";
import { StatutoryRevisionCandidatesPanel } from "../components/statutory-revision-candidates-panel";
import { UsFinancialPeriodEquivalencePanel } from "../components/us-financial-period-equivalence-panel";
import { OwnerHoldingSnapshotReferencesPanel } from "../components/owner-holding-snapshot-references-panel";

type RecordValue = Record<string, any>;
type Screen = "overview" | "foundation" | "model" | "review" | "personal";
type ComposerKind = "identity" | "business-model" | "market-space" | "governance" | "competitive-market" | "thesis" | "valuation" | "risk" | "catalyst" | "snapshot" | "user-note";
type ResearchTargetId = "identity" | "financials" | "operating" | "competition" | "forecasts" | "valuation" | "risk_review" | "evidence" | "market" | "focus-profile";
type ResearchTarget = { id: ResearchTargetId; section: Screen; anchor: string; fallbackLabel: string };

const styles = `.research-page{background:#f3f7f7;color:#183230;min-height:calc(100vh - 8rem);padding:1.25rem 0 2.5rem;overflow-x:hidden}.research-shell{max-width:1260px}.research-hero,.research-card{min-width:0;background:#fff;border:1px solid #d8e5e2;border-radius:1rem;box-shadow:0 .5rem 1.5rem rgba(15,52,51,.05)}.research-hero{background:linear-gradient(120deg,#102f43,#0c766d);color:#f8fafc;padding:1.45rem}.research-hero h1{font-size:1.75rem;margin:.3rem 0}.research-card{padding:1rem;margin-top:1rem}.research-card h2{color:#123b62;font-size:1.05rem}.research-card h3{font-size:.95rem;color:#123b62}.research-meta{color:#64748b;font-size:.82rem}.research-state{display:inline-block;background:#e2e8f0;border-radius:999px;color:#334155;font-size:.75rem;font-weight:700;padding:.24rem .55rem}.research-nav,.research-local-nav{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:1rem}.research-nav button,.research-local-nav button{border:1px solid #b9d0cc;background:#fff;border-radius:999px;padding:.38rem .78rem;color:#28534f;font-size:.86rem}.research-nav button.active{background:#0f766e;border-color:#0f766e;color:#fff}.research-local-nav{align-items:center;border:1px solid #d8e5e2;border-radius:.8rem;background:#f8fcfb;padding:.65rem}.research-local-nav strong{font-size:.82rem;color:#365653}.research-local-nav button{background:#f0fdfa}.research-grid{display:grid;gap:1rem;grid-template-columns:repeat(2,minmax(0,1fr));margin-top:1rem}.research-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}.record{border-top:1px solid #e2e8f0;padding:.7rem 0}.record:first-child{border-top:0}.record p{margin:.3rem 0}.research-note{background:#f8fafc;border:1px dashed #a9bbb9;border-radius:.75rem;padding:.75rem}.research-list{margin:0;padding-left:1.1rem}.section-card{border-top:4px solid #0f766e}.section-card.empty,.section-card.unavailable{border-top-color:#94a3b8}.section-head{display:flex;align-items:start;justify-content:space-between;gap:.75rem}.research-table{font-size:.82rem}.research-table td,.research-table th{vertical-align:top}.composer{border:1px solid #94bfb8;background:#f7fffd;border-radius:.9rem;padding:1rem}.composer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem}.composer label{display:block;font-size:.78rem;color:#365653}.composer input,.composer select,.composer textarea{width:100%;border:1px solid #c6d5d2;border-radius:.45rem;background:#fff;padding:.45rem;margin-top:.2rem}.composer textarea{min-height:4.8rem}.composer .wide{grid-column:1/-1}.public-boundary{border-left:4px solid #0f766e}.private-boundary{border-left:4px solid #7c3aed}.risk{border-left:4px solid #d97706}.risk.upgraded{border-left-color:#dc2626}.evidence-link{font-size:.8rem}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.65rem}.metric-grid article{min-width:0;border-radius:.65rem;background:#f8fafc;padding:.7rem}.empty-action{display:flex;justify-content:space-between;gap:.7rem;align-items:center}.research-summary-card{display:flex;min-width:0;min-height:8.6rem;flex-direction:column;align-items:flex-start;gap:.35rem;border:1px solid #d7e6e3;border-radius:.75rem;background:#f8fcfb;padding:.8rem;text-align:left;color:#173f3b}.research-summary-card:hover{border-color:#0f766e;background:#f0fdfa}.research-summary-card span{font-weight:700;font-size:.95rem}.research-summary-card small{color:#64748b;line-height:1.35}.research-summary-card em{margin-top:auto;color:#0f766e;font-size:.8rem;font-style:normal}.research-layer-grid{display:grid;gap:.65rem;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:.8rem}.research-layer-card{display:flex;min-width:0;min-height:13rem;flex-direction:column;align-items:flex-start;gap:.42rem;border:1px solid #d7e6e3;border-radius:.75rem;background:#f8fcfb;padding:.8rem;text-align:left;color:#173f3b}.research-layer-card:hover,.research-layer-card:focus-visible{border-color:#0f766e;background:#f0fdfa;outline:2px solid #0f766e;outline-offset:2px}.research-layer-card strong{font-size:.92rem}.research-layer-card p,.research-layer-card small{margin:0;color:#526462;font-size:.78rem;line-height:1.4}.research-layer-card p span{color:#173f3b;font-weight:700}.research-layer-card em{margin-top:auto;color:#0f766e;font-size:.8rem;font-style:normal}.research-results-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.65rem;margin-top:.8rem}.research-result-card{display:flex;min-width:0;min-height:8rem;flex-direction:column;align-items:flex-start;border:1px solid #d7e6e3;border-radius:.75rem;background:#fbfefd;padding:.8rem;text-align:left;color:#173f3b}.research-result-card:hover{border-color:#0f766e;background:#f0fdfa}.research-result-card strong{font-size:.92rem}.research-result-card span{margin-top:.3rem;font-weight:700;line-height:1.35}.research-result-card small{margin-top:.35rem;color:#64748b;line-height:1.35}.research-result-card em{margin-top:auto;color:#0f766e;font-size:.8rem;font-style:normal}.research-audit-details{margin-top:1rem;border:1px solid #d8e5e2;border-radius:1rem;background:#fff;box-shadow:0 .5rem 1.5rem rgba(15,52,51,.05)}.research-audit-details>summary{cursor:pointer;padding:1rem;color:#123b62}.research-audit-details>summary span{color:#64748b;font-size:.82rem;font-weight:400}.research-audit-details>.research-audit-body{padding:0 1rem 1rem}.research-audit-details .research-card{margin-top:1rem;box-shadow:none}.research-gate{border-left:4px solid #94a3b8;border-radius:.55rem;background:#f8fafc;padding:.75rem}.research-gate.watch{border-left-color:#d97706}.research-gate.blocked{border-left-color:#dc2626}.research-gate p{margin:.35rem 0;color:#334155;font-size:.88rem}.research-gate small{color:#64748b}@media(max-width:1050px){.research-layer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:900px){.research-grid.three,.metric-grid,.research-results-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.research-grid,.research-grid.three,.research-layer-grid,.metric-grid,.research-results-grid,.composer-grid{grid-template-columns:minmax(0,1fr)}.research-page{padding:.75rem 0}}`;

const readingSurfaceStyles = `.research-result-card{gap:.45rem;min-height:14.25rem;white-space:normal}.research-result-card:focus-visible{border-color:#0f766e;outline:2px solid #0f766e;outline-offset:2px}.research-result-card[data-result-status="blocked"]{border-color:#f3c4c4;background:#fffafa}.research-result-card[data-result-status="partial"]{border-color:#f0d5a8;background:#fffcf5}.research-result-card[data-result-status="ready"]{border-color:#9ed4c9}.research-result-status{font-size:.74rem}.research-result-conclusion{margin:0;color:#183230;font-size:.91rem;font-weight:700;line-height:1.38}.research-result-detail{margin:0;color:#526462;font-size:.79rem;line-height:1.4}.research-result-detail b{color:#284b47}.research-result-next{margin-top:auto;color:#0f766e;font-size:.79rem;font-style:normal;line-height:1.35}.research-result-card[data-result-status="blocked"] .research-result-next{color:#b42318}.research-result-card[data-result-status="partial"] .research-result-next{color:#9a6700}.research-results-note{margin:.7rem 0 0;color:#64748b;font-size:.79rem;line-height:1.4}`;

const kinds: Array<[ComposerKind, string]> = [["identity", "经营公司与证券关系"], ["business-model", "业务与分部"], ["market-space", "市场空间与份额"], ["governance", "治理与资本配置"], ["competitive-market", "竞争与壁垒"], ["thesis", "研究命题"], ["valuation", "估值案例"], ["risk", "风险台账"], ["catalyst", "事件与催化"], ["snapshot", "研究快照"], ["user-note", "个人笔记"]];
const nav: Array<[Screen, string, string]> = [["overview", "研究总览", "先处理阻断项与下一步"], ["foundation", "基础事实", "公司、财务、业务、治理"], ["model", "预测与估值", "来源预测、自建模型与证券估值"], ["review", "竞争、风险与复盘", "命题、证伪、事件与快照"], ["personal", "个人研究", "不改变公共研究事实"]];
const researchTargets: Record<ResearchTargetId, ResearchTarget> = {
  identity: { id: "identity", section: "foundation", anchor: "research-identity", fallbackLabel: "公司与证券" },
  financials: { id: "financials", section: "foundation", anchor: "research-financials", fallbackLabel: "正式财务" },
  operating: { id: "operating", section: "foundation", anchor: "research-operating", fallbackLabel: "业务与市场" },
  competition: { id: "competition", section: "foundation", anchor: "research-competition", fallbackLabel: "行业、竞争与同行" },
  forecasts: { id: "forecasts", section: "model", anchor: "research-forecasts", fallbackLabel: "来源预测" },
  valuation: { id: "valuation", section: "model", anchor: "research-valuation", fallbackLabel: "估值版本" },
  risk_review: { id: "risk_review", section: "review", anchor: "research-risk-review", fallbackLabel: "命题与风险" },
  evidence: { id: "evidence", section: "overview", anchor: "research-evidence", fallbackLabel: "原始证据与来源健康" },
  market: { id: "market", section: "overview", anchor: "research-market", fallbackLabel: "市场状态" },
  "focus-profile": { id: "focus-profile", section: "foundation", anchor: "research-focus-profile", fallbackLabel: "重点公司档案" },
};
const canonicalCoverageModules: ResearchTargetId[] = ["identity", "financials", "operating", "forecasts", "valuation", "risk_review"];

function queryCode() { return new URLSearchParams(location.search).get("code")?.trim() || ""; }
function queryScreen(): Screen {
  const value = new URLSearchParams(location.search).get("section");
  return nav.some(([screen]) => screen === value) ? value as Screen : "overview";
}
function queryFocus(): ResearchTargetId | null {
  const value = new URLSearchParams(location.search).get("focus")?.trim() as ResearchTargetId | undefined;
  return value && researchTargets[value] ? value : null;
}
function date(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
    const sourceDate = new Date(value);
    if (!Number.isNaN(sourceDate.getTime())) return sourceDate.toLocaleString("zh-CN", { hour12: false });
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString("zh-CN", { hour12: false }) : "待补";
}
function text(value: unknown) { return value === null || value === undefined || value === "" ? "—" : String(value); }
function sectionState(section: RecordValue | undefined) { return section?.availability || "unavailable"; }
function sectionLabel(state: string) { return ({ available: "已覆盖", empty: "待补", unavailable: "受阻" } as RecordValue)[state] || state; }
function compact(value: unknown) { try { const raw = JSON.stringify(value); return raw.length > 150 ? `${raw.slice(0, 147)}…` : raw; } catch { return "待补"; } }
function refs(items: any[] = []) { return items.length ? h("ul", { class: "research-list research-meta mt-2" }, items.slice(0, 4).map((item, index) => h("li", { key: item.sourceId || item.url || index }, item.url ? h("a", { href: item.url, target: "_blank", rel: "noreferrer", class: "evidence-link" }, item.title || item.url) : `${item.sourceKind || "source"} · ${item.informationId || item.documentId || item.sourceId || "可追溯引用"}`))) : null; }
function asList(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }

const App = defineComponent({ setup() {
  const payload = ref<RecordValue | null>(null); const error = ref(""); const loading = ref(true); const active = ref<Screen>(queryScreen()); const focus = ref<ResearchTargetId | null>(queryFocus());
  const composer = ref<ComposerKind | null>(null); const form = ref<RecordValue>(emptyForm()); const saving = ref(false); const saveError = ref("");
  const statutoryIndexPage = ref("1");
  const scrollToFocus = async (targetId: ResearchTargetId | null) => { if (!targetId) return; await nextTick(); const target = researchTargets[targetId]; const node = document.getElementById(target.anchor); if (!node) return; node.scrollIntoView({ block: "start" }); node.focus({ preventScroll: true }); };
  const load = async () => { const code = queryCode(); if (!code) { error.value = "请从公司页面带入股票代码。"; loading.value = false; return; } loading.value = true; error.value = ""; try { const response = await fetch(`/api/research/company/${encodeURIComponent(code)}?owner=local-user`); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取研究数据失败"); payload.value = body.data; await scrollToFocus(focus.value); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { loading.value = false; } };
  const refreshStatutory = async (page = statutoryIndexPage.value) => {
    const normalizedPage = Number(page);
    if (!Number.isInteger(normalizedPage) || normalizedPage < 1 || normalizedPage > 100) { error.value = "历史索引页码必须是 1 至 100 的整数。"; return; }
    try {
      const query = new URLSearchParams({ page: String(normalizedPage), pageSize: "30" });
      const response = await fetch(`/api/research/company/${encodeURIComponent(queryCode())}/statutory-disclosures/refresh?${query}`, { method: "POST" });
      const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "刷新法定披露索引失败"); await load();
    } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  };
  const refreshSecVerification = async () => { try { const response = await fetch(`/api/research/company/${encodeURIComponent(queryCode())}/financial-statutory-verifications/refresh`, { method: "POST" }); const body = await response.json(); if (!response.ok || body.code !== 200) throw new Error(body.msg || "SEC 字段核验失败"); await load(); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } };
  const openComposer = (kind: ComposerKind) => { composer.value = kind; form.value = emptyForm(kind); saveError.value = ""; };
  const chooseScreen = (screen: Screen) => {
    active.value = screen; focus.value = null;
    const url = new URL(location.href);
    if (screen === "overview") url.searchParams.delete("section"); else url.searchParams.set("section", screen); url.searchParams.delete("focus");
    history.replaceState({}, "", url);
  };
  const chooseTarget = async (targetId: ResearchTargetId) => {
    const target = researchTargets[targetId]; active.value = target.section; focus.value = targetId;
    const url = new URL(location.href); url.searchParams.set("section", target.section); url.searchParams.set("focus", targetId); history.replaceState({}, "", url);
    await scrollToFocus(targetId);
  };
  const save = async () => { if (!composer.value) return; saving.value = true; saveError.value = ""; try { const path = composer.value === "identity" ? "identity" : `dossier/${composer.value}`; const response = await fetch(`/api/research/company/${encodeURIComponent(queryCode())}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildPayload(composer.value, form.value)) }); const result = await response.json(); if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存失败"); composer.value = null; await load(); } catch (reason) { saveError.value = reason instanceof Error ? reason.message : String(reason); } finally { saving.value = false; } };
  onMounted(() => { void load(); });
  return () => h("main", { class: "research-page" }, [h("style", `${styles}${readingSurfaceStyles}`), h("div", { class: "container research-shell" }, [
    loading.value ? h("div", { class: "research-card text-center text-muted py-5" }, "正在读取可审计研究档案…") : null,
    error.value ? h("div", { class: "research-card" }, [h("h1", "公司研究暂不可用"), h("p", error.value), h("button", { class: "btn btn-outline-success btn-sm", onClick: () => void load() }, "重试")]) : null,
    payload.value ? render(payload.value, active.value, focus.value, chooseScreen, chooseTarget, openComposer, composer.value, form.value, (key, value) => { form.value = { ...form.value, [key]: value }; }, saving.value, saveError.value, save, () => { composer.value = null; }, refreshStatutory, statutoryIndexPage.value, (value) => { statutoryIndexPage.value = value; }, refreshSecVerification) : null,
  ])]);
} });

function render(data: RecordValue, active: Screen, focus: ResearchTargetId | null, choose: (value: Screen) => void, chooseTarget: (value: ResearchTargetId) => Promise<void>, open: (kind: ComposerKind) => void, composer: ComposerKind | null, form: RecordValue, update: (key: string, value: string) => void, saving: boolean, saveError: string, save: () => Promise<void>, close: () => void, refreshStatutory: (page?: string) => Promise<void>, statutoryIndexPage: string, setStatutoryIndexPage: (value: string) => void, refreshSecVerification: () => Promise<void>) {
  const identity = data.identity || {}; const financials = data.financials || {}; const dossier = data.dossier || {}; const canWrite = Boolean(data.capabilities?.canWriteLocally);
  const listedSecurity = identity.listedSecurity || {};
  const currency = listedSecurity.tradingCurrency || (listedSecurity.expectedTradingCurrency ? `${listedSecurity.expectedTradingCurrency}（市场规则）` : "币种待补");
  const primaryExposure = primaryTrackExposure(data);
  const valuation = data.coverage?.modules?.find?.((item: RecordValue) => item.moduleId === "valuation") || {};
  const hero = h("section", { class: "research-hero" }, [
    h("div", { class: "small opacity-75" }, "AUDITABLE INVESTMENT RESEARCH · 研究辅助，不含自动交易指令"), h("h1", `${data.name} · ${data.code}`),
    h("p", { class: "mb-1 opacity-75" }, `经营公司：${identity.operatingCompany?.canonicalName || "待确认"}；证券：${listedSecurity.market || "待确认"} / ${currency}`),
    h("p", { class: "mb-1 opacity-75", "data-research-hero-scope": "track-and-valuation" }, `主营赛道：${primaryExposure || "待补（无来源绑定主营暴露）"}；估值原型：${valuation.status === "ready" ? "已具备门禁，见估值阅读区" : "待确认（当前估值门禁受阻）"}`),
    h("div", { class: "small text-white-50", "data-research-read-at": "true" }, `本次读取 ${date(data.generatedAt)} · 财务、行情与来源分别按各卡数据日期；公共研究与个人决定物理分层`),
  ]);
  const tabs = h("nav", { class: "research-nav", role: "tablist", "aria-label": "研究层级" }, nav.map(([key, label, hint]) => h("button", { id: `research-tab-${key}`, role: "tab", "aria-selected": active === key ? "true" : "false", "aria-controls": `research-panel-${key}`, class: active === key ? "active" : "", title: hint, onClick: () => choose(key) }, label)));
  const page = active === "overview" ? overview(data, chooseTarget) : active === "foundation" ? foundation(data, focus, chooseTarget, canWrite, refreshStatutory, statutoryIndexPage, setStatutoryIndexPage, refreshSecVerification) : active === "model" ? model(data, canWrite) : active === "review" ? review(data, canWrite, chooseTarget) : personal(data);
  return [hero, tabs, h("section", { id: `research-panel-${active}`, role: "tabpanel", "aria-labelledby": `research-tab-${active}` }, [page, localDossierWorkbench(active, canWrite, open, composer, form, update, saving, saveError, save, close)])];
}

function localDossierWorkbench(active: Screen, canWrite: boolean, open: (kind: ComposerKind) => void, composer: ComposerKind | null, form: RecordValue, update: (key: string, value: string) => void, saving: boolean, saveError: string, save: () => Promise<void>, close: () => void) {
  if (!canWrite || active === "overview") return null;
  const allowed: Record<Exclude<Screen, "overview">, ComposerKind[]> = {
    foundation: ["identity", "business-model", "market-space", "governance", "competitive-market"],
    model: ["valuation"],
    review: ["thesis", "risk", "catalyst", "snapshot"],
    personal: ["user-note"],
  };
  const available = allowed[active];
  return h("details", { class: "research-card research-workbench", open: composer ? true : undefined, "data-research-workbench": "dossier-records" }, [
    h("summary", [h("strong", "本地研究工作台：追加版本化研究记录"), h("span", { class: "research-meta ms-2" }, "默认收起；仅本地可写，历史与阅读结果不受影响")]),
    h("div", { class: "research-workbench-body" }, [
      h("p", { class: "research-meta mb-2" }, "选择记录类型后才显示录入表单。每次保存均追加新版本，不能回填或改写已冻结事实。"),
      h("div", { class: "d-flex gap-2 flex-wrap" }, available.map((kind) => h("button", { class: "btn btn-outline-success btn-sm", type: "button", onClick: () => open(kind) }, `新增${kinds.find(([id]) => id === kind)?.[1] || kind}`))),
      composer ? composerCard(composer, form, update, saving, saveError, save, close) : null,
    ]),
  ]);
}

function overview(data: RecordValue, chooseTarget: (value: ResearchTargetId) => Promise<void>) {
  const coverage = data.coverage || {}; const requirementCoverage = data.dataRequirementCoverage || {}; const coverageModules: RecordValue[] = Array.isArray(coverage.modules) ? coverage.modules : [];
  const coverageModule = (id: string) => coverageModules.find((item) => item.moduleId === id) || { status: "unavailable", nextEvidence: "读取统一覆盖状态失败", target: "foundation" };
  const decision = data.decision || {}; const riskProfile = data.riskProfile || {}; const health = data.dataHealth || {};
  const cockpitModules = canonicalCoverageModules.map((id) => ({ ...researchTargets[id], ...coverageModule(id) }));
  const cockpit = h("section", { class: "research-card section-card" }, [
    h("div", { class: "section-head" }, [h("div", [h("h2", "研究驾驶舱"), h("p", { class: "research-meta mb-0" }, "此处是模块状态、结论边界和下一条证据的唯一总览；逐项门禁与来源审计可在下方展开。")]), h("span", { class: "research-state" }, decision.state || "资料待补")]),
    h("section", { class: "research-grid three mt-3", "data-research-cockpit": "canonical" }, cockpitModules.map((module) => h("button", { class: "research-summary-card", "data-research-module": module.id, onClick: () => void chooseTarget(module.id) }, [h("strong", module.label || module.fallbackLabel), h("span", coverageStatusLabel(module.status)), h("small", module.nextEvidence || "下一条证据待明确"), h("em", "进入对应证据区 →")])))
  ]);
  const coreResults = coreResultsCard(data, coverageModule, chooseTarget);
  const marketSignals = decision.gates?.length ? h("section", { class: "research-card section-card" }, [h("h2", "市场观察与研究门禁"), h("p", { class: "research-meta" }, `${decision.summary || ""} 市场观察不构成模型输入或交易指令。`), h("div", { class: "research-grid" }, decision.gates.map((gate: RecordValue) => h("article", { class: `research-gate ${gate.state || "unavailable"}` }, [h("strong", `${gate.label} · ${gate.state || "待补"}`), h("p", gate.summary), h("small", `下一条证据：${gate.nextStep || "待明确"}`)])))]) : null;
  const riskSummary = riskProfile.dimensions?.length ? h("section", { class: "research-card section-card" }, [h("h2", "风险覆盖与缺口"), h("p", { class: "research-meta" }, riskProfile.summary || "风险输入待补。"), h("ul", { class: "research-list" }, riskProfile.dimensions.map((dimension: RecordValue) => h("li", [h("strong", `${dimension.label} · ${dimension.severity}`), `：${dimension.summary}`]))), riskProfile.gaps?.length ? h("p", { class: "research-meta mb-0" }, `未接入：${riskProfile.gaps.map((gap: RecordValue) => gap.label).join("、")}`) : null]) : null;
  const healthSummary = h("section", { class: "research-card section-card" }, [h("h2", "数据健康与边界"), health.kline ? h("p", { class: "research-meta" }, `行情序列：${health.kline.rows || 0} 条，最新 ${health.kline.latestDate || "待补"}，读取 ${health.kline.source || "待补"}${health.kline.originSource ? `（原始来源 ${health.kline.originSource}）` : ""}。股票 K 线仅使用 Xueqiu。`) : null, h("ul", { class: "research-list research-meta" }, (health.limitations || []).slice(0, 4).map((item: string) => h("li", item)))]);
  const audit = h("details", { class: "research-audit-details", "data-research-audit": "depth-and-requirements" }, [
    h("summary", [h("strong", "研究门禁与逐项来源审计"), h("span", { class: "ms-2" }, `规则 ${data.researchDepth?.ruleVersion || "待初始化"} / ${requirementCoverage.ruleVersion || "待初始化"}`)]),
    h("div", { class: "research-audit-body" }, [h(ResearchDepthPanel, { assessment: data.researchDepth || {} }), h(DataRequirementCoveragePanel, { coverage: requirementCoverage })]),
  ]);
  return h("div", [cockpit, researchLayerMap(data, coverageModule, chooseTarget), coreResults, audit, researchAnchor("market", h("section", { class: "research-grid" }, [marketSignals, riskSummary, healthSummary])), researchAnchor("evidence", evidenceCard(data))]);
}

function coverageStatusLabel(status: unknown) { return ({ ready: "可进入下一层", partial: "部分可用", blocked: "受阻", unavailable: "待补" } as Record<string, string>)[String(status)] || String(status || "待补"); }
function primaryTrackExposure(data: RecordValue): string | null {
  const industry = data.industry || {};
  const typed = Array.isArray(industry.typedTrackExposures?.items) ? industry.typedTrackExposures.items : [];
  const legacy = Array.isArray(industry.exposures?.items) ? industry.exposures.items : [];
  const exposure = typed.find((item: RecordValue) => item.selectionBasis === "primary_business") || legacy.find((item: RecordValue) => item.selectionBasis === "primary_business");
  if (!exposure) return null;
  return exposure.trackName || exposure.industryName || exposure.primaryBusinessDescription || exposure.exposureDescription || null;
}
function materialStatus(requirements: RecordValue[]): { status: "ready" | "partial" | "blocked" | "unavailable"; summary: string; nextEvidence: string | null } {
  const counts = requirements.reduce((all: RecordValue, item) => { const status = String(item.status || "missing"); all[status] = (all[status] || 0) + 1; return all; }, {});
  const missing = (counts.missing || 0) + (counts.unavailable || 0);
  const partial = (counts.partial || 0) + (counts.stale || 0);
  const conflicts = (counts.conflicting || 0) + (counts.source_error || 0);
  const status = conflicts ? "blocked" : missing ? "unavailable" : partial ? "partial" : "ready";
  const firstUnready = requirements.find((item) => ["conflicting", "source_error", "missing", "unavailable", "partial", "stale"].includes(String(item.status)));
  return { status, summary: `事实要求：已验证 ${counts.available || 0} 项；部分/过期 ${partial} 项；待补 ${missing} 项；冲突/来源异常 ${conflicts} 项。`, nextEvidence: firstUnready?.nextEvidence || null };
}
function researchLayerMap(data: RecordValue, coverageModule: (id: string) => RecordValue, chooseTarget: (value: ResearchTargetId) => Promise<void>) {
  const identity = data.identity || {}; const listedSecurity = identity.listedSecurity || {}; const industry = data.industry || {}; const focusProfile = data.focusProfile || {};
  const typedExposures = Array.isArray(industry.typedTrackExposures?.items) ? industry.typedTrackExposures.items : [];
  const legacyExposures = Array.isArray(industry.exposures?.items) ? industry.exposures.items : [];
  const exposure = typedExposures.find((item: RecordValue) => item.selectionBasis === "primary_business") || typedExposures[0] || legacyExposures.find((item: RecordValue) => item.selectionBasis === "primary_business") || legacyExposures[0];
  const operating = coverageModule("operating"); const competition = coverageModule("industry_competition"); const identityCoverage = coverageModule("identity");
  const layers: Array<{ id: string; title: string; target: ResearchTargetId; status: string; basis: string; boundary: string; nextEvidence: string }> = [
    {
      id: "company",
      title: "通用公司层",
      target: "identity",
      status: coverageStatusLabel(identityCoverage.status),
      basis: identity.operatingCompany?.canonicalName ? `经营公司：${identity.operatingCompany.canonicalName}；可跨其关联证券复用。` : "需先确认经营公司与证券关系，才可跨证券复用。",
      boundary: "只承载经营主体、业务和来源事实；不替代特定证券的权利、流动性、币种或估值结论。",
      nextEvidence: identityCoverage.nextEvidence || "补经营公司身份及与证券的可追溯关系。",
    },
    {
      id: "market-security",
      title: "市场与上市结构层",
      target: "identity",
      status: coverageStatusLabel(identityCoverage.status),
      basis: listedSecurity.market ? `当前研究对象：${data.code}（${listedSecurity.market} / ${listedSecurity.instrumentKind || "证券类型待补"}）。` : `当前研究对象：${data.code}；市场与证券类型待确认。`,
      boundary: "仅适用于当前证券；不会把 A/H/ADR 的权利、股本、交易币种或估值自动带到关联证券。",
      nextEvidence: identityCoverage.nextEvidence || "补证券权利、股本与市场结构的来源绑定。",
    },
    {
      id: "industry-track",
      title: "行业/赛道层",
      target: "operating",
      status: exposure ? coverageStatusLabel(competition.status) : "待补主营暴露",
      basis: exposure ? `${exposure.selectionBasis === "primary_business" ? "主营" : "次要"}暴露：${exposure.exposureDescription || exposure.primaryBusinessDescription || "描述待补"}` : "尚无以主营或次要业务为依据的已记录行业暴露。",
      boundary: "行业标签、媒体主题或资金流不是公司结论；需以业务暴露、赛道边界和来源事实审计后使用。",
      nextEvidence: exposure ? (competition.nextEvidence || "核验赛道边界、KPI 与财务传导。") : "补主营/次要业务选择依据、暴露范围与来源证据。",
    },
    {
      id: "focus-company",
      title: "重点公司侧重层",
      target: "focus-profile",
      status: focusProfile.profile ? `公共 v${focusProfile.profile.version} · ${focusProfile.profile.status || "待复核"}` : "待建立公共侧重档案",
      basis: focusProfile.profile ? `当前公共档案：${focusProfile.profile.title || "未命名"}` : "仅在已有公共研究基础上记录本公司的复核侧重与版本。",
      boundary: "不改变通用公司、证券或行业层的公共完成状态；也不包含持仓、交易计划或个人决定。",
      nextEvidence: focusProfile.profile?.reviewBy ? `按 ${date(focusProfile.profile.reviewBy)} 前复核档案及其来源引用。` : "明确需侧重的已审计对象、理由、来源引用与复核日期。",
    },
  ];
  return h("section", { class: "research-card section-card", "data-research-layer-map": "four-layer" }, [
    h("div", { class: "section-head" }, [h("div", [h("h2", "研究对象四层地图"), h("p", { class: "research-meta mb-0" }, "先确认结论属于哪一层，再进入对应证据区；四层相互引用，但不会互相升级为结论。")])]),
    h("div", { class: "research-layer-grid" }, layers.map((layer) => h("button", { type: "button", class: "research-layer-card", "data-research-layer": layer.id, "data-research-layer-anchor": researchTargets[layer.target].anchor, "aria-describedby": `research-layer-${layer.id}-boundary`, onClick: () => void chooseTarget(layer.target) }, [
      h("strong", layer.title), h("span", { class: "research-state" }, layer.status), h("p", [h("span", "适用/选择："), layer.basis]), h("p", { id: `research-layer-${layer.id}-boundary` }, [h("span", "结论边界："), layer.boundary]), h("small", `下一条证据：${layer.nextEvidence}`), h("em", `进入${researchTargets[layer.target].fallbackLabel} →`),
    ]))),
  ]);
}
function coreResultsCard(data: RecordValue, coverageModule: (id: string) => RecordValue, chooseTarget: (value: ResearchTargetId) => Promise<void>) {
  const financials = data.financials || {}; const financialGate = financials.statutoryGate || {}; const decision = data.decision || {}; const riskProfile = data.riskProfile || {};
  const actuals = Array.isArray(data.formalActuals) ? data.formalActuals : []; const sourceFacts = Array.isArray(data.operating?.sourceFacts?.items) ? data.operating.sourceFacts.items : []; const governanceFacts = Array.isArray(data.governanceCapitalFacts?.latestFacts) ? data.governanceCapitalFacts.latestFacts : [];
  const financialSeries = Array.isArray(financials.quality?.series) ? financials.quality.series : []; const financialObservations = Array.isArray(financials.quality?.observations) ? financials.quality.observations : [];
  const identity = coverageModule("identity"); const financial = coverageModule("financials"); const operating = coverageModule("operating"); const competition = coverageModule("industry_competition"); const forecasts = coverageModule("forecasts"); const valuation = coverageModule("valuation"); const riskReview = coverageModule("risk_review"); const marketState = coverageModule("market_state");
  const coverageItems = [identity, financial, operating, forecasts, valuation, riskReview];
  const financialVerification = financialGate.status === "verified" ? `法定核验已通过 ${financialGate.verifiedMetrics?.length || 0} 项` : `法定核验${financialGate.status === "partial" ? "部分完成" : "未通过"}：${financialGate.verifiedMetrics?.length || 0}/${financialGate.requiredMetrics?.length || 0} 项`;
  const market = decision.metrics || {}; const marketGate = Array.isArray(decision.gates) ? decision.gates.find((item: RecordValue) => item.id === "trigger" || item.id === "market") : null;
  const marketCurrency = data.identity?.listedSecurity?.tradingCurrency || data.identity?.listedSecurity?.expectedTradingCurrency || "币种待补";
  const latestKlineDate = data.dataHealth?.kline?.latestDate || "待补";
  const priceText = Number.isFinite(Number(market.close)) ? `最新价 ${Number(market.close).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${marketCurrency}（K 线截至 ${latestKlineDate}）；90 日回撤 ${market.drawdown90d ?? "—"}%` : "行情观察待补";
  const exposureItems = Array.isArray(data.industry?.typedTrackExposures?.items) ? data.industry.typedTrackExposures.items : [];
  const competitionItems = Array.isArray(data.dossier?.competitiveMarkets?.items) ? data.dossier.competitiveMarkets.items : [];
  const forecastItems = Array.isArray(data.forecastWorkspace?.sourceForecasts?.items) ? data.forecastWorkspace.sourceForecasts.items : [];
  const valuationItems = (Array.isArray(data.valuationModels?.items) ? data.valuationModels.items.length : 0) + (Array.isArray(data.reverseValuationModels?.items) ? data.reverseValuationModels.items.length : 0) + (Array.isArray(data.relativeValuationLedgers?.items) ? data.relativeValuationLedgers.items.length : 0);
  const sourceCount = sourceLedgerEvidence(data).length;
  const requirements = Array.isArray(data.dataRequirementCoverage?.requirements) ? data.dataRequirementCoverage.requirements : [];
  const materials = materialStatus(requirements);
  const firstUnready = coverageItems.find((item) => item.status === "blocked") || coverageItems.find((item) => item.status === "partial") || coverageItems.find((item) => item.status === "unavailable");
  const nextTarget = (firstUnready?.moduleId && researchTargets[firstUnready.moduleId as ResearchTargetId]) ? firstUnready.moduleId as ResearchTargetId : "risk_review";
  type Result = { id: string; title: string; status: string; conclusion: string; basis: string; boundary: string; nextEvidence: string; target: ResearchTargetId };
  const results: Result[] = [
    { id: "data", title: "资料与研究范围", status: materials.status, conclusion: identity.status === "ready" ? "研究范围已确认，但资料仍按逐项事实要求待补；不能据此提升研究结论。" : (identity.conclusionImpact || "研究范围尚未确认，不能跨证券复用公司或估值结论。"), basis: `范围：${data.identity?.operatingCompany?.canonicalName || "经营公司待确认"} / ${data.code || "证券待确认"}；${sourceCount} 条可回链来源。${materials.summary}`, boundary: "范围确认和资料可得性分别判断；上方状态不是综合评分，也不以身份映射掩盖财务、预测、治理或风险缺口。", nextEvidence: materials.nextEvidence || identity.nextEvidence || "补经营公司、当前证券及权利关系的可追溯来源。", target: "evidence" },
    { id: "business", title: "业务与增长约束", status: operating.status || "unavailable", conclusion: operating.conclusionImpact || "尚不能形成业务质量或增长判断。", basis: `已接受经营来源事实 ${sourceFacts.length} 条；字段化模型 ${data.operating?.models?.items?.length || 0} 版、驱动计划 ${data.operating?.driverPlans?.items?.length || 0} 版。`, boundary: "项目状态、公告线索或来源观点不会自动变成收入、交付、利润或情景假设。", nextEvidence: operating.nextEvidence || "补充分部、合同、单位经济、驱动计划及其来源绑定。", target: "operating" },
    { id: "competition", title: "竞争与行业位置", status: competition.status || "unavailable", conclusion: competition.conclusionImpact || (competitionItems.length ? "竞争材料已记录，仍须按证据与反证条件复核。" : "尚不能形成竞争优势或行业位置判断。"), basis: `主营/次要行业暴露 ${exposureItems.length} 条；竞争市场记录 ${competitionItems.length} 条。`, boundary: "行业标签、市场热度和高利润不等于壁垒；公司、行业与证券结论分别成立。", nextEvidence: competition.nextEvidence || "补竞争市场边界、可比对象、侵蚀路径和财务传导。", target: "competition" },
    { id: "finance", title: "财务质量", status: financial.status || "unavailable", conclusion: financial.conclusionImpact || "财务质量和实际校准保持受阻。", basis: `${financials.sourcePolicy || "正式财报主源待确认"}；${financialVerification}；已载入 ${financialSeries.length} 组序列、${financialObservations.length} 项派生观察。`, boundary: "主结构化源与法定核验分层；缺失、冲突或不可比不会以聚合值或零值补齐。", nextEvidence: financial.nextEvidence || financialGate.reason || "补齐三表字段、报告期与法定核验。", target: "financials" },
    { id: "earnings", title: "盈利路径", status: forecasts.status || "unavailable", conclusion: forecasts.conclusionImpact || "尚无可用预测判断。", basis: `来源预测 ${forecastItems.length} 条；已接受正式实际 ${actuals.length} 条。来源预测、情景、实际与校准分别保存。`, boundary: "机会性样本只称“已纳入样本的预测汇总”，不是市场一致预期，也不会自动生成自建情景。", nextEvidence: forecasts.nextEvidence || "先审核来源、独立性、期间与会计口径，再决定是否纳入。", target: "forecasts" },
    { id: "valuation", title: "估值与隐含预期", status: valuation.status || "unavailable", conclusion: valuation.conclusionImpact || "无法形成当前证券估值结论。", basis: `已保存估值/反向估值/相对估值版本 ${valuationItems} 份；当前仅在门禁通过时读取可用输出。`, boundary: "价值、股本、币种、ADR 权利与市场价格均属于当前证券；历史模型不是当前结论。", nextEvidence: valuation.nextEvidence || "补正式财务、证券权利、股本和模型前置输入。", target: "valuation" },
    { id: "risk", title: "风险与证伪", status: riskReview.status || "unavailable", conclusion: riskReview.conclusionImpact || riskProfile.summary || "尚无完整风险与证伪判断。", basis: `已识别风险 ${riskProfile.findings?.length || 0} 项；输入缺口 ${riskProfile.gaps?.length || 0} 项；治理/资本来源事实 ${governanceFacts.length} 条。`, boundary: "价格波动、回购提议或单一事件不能替代风险传导、反证条件和复核期。", nextEvidence: riskReview.nextEvidence || "建立来源绑定的命题、风险传导、触发条件与复核期。", target: "risk_review" },
    { id: "market", title: "市场状态", status: marketState.status || "unavailable", conclusion: marketState.conclusionImpact || "市场数据仅作辅助观察，不构成基本面结论或交易动作。", basis: `${priceText}；K 线 ${data.dataHealth?.kline?.rows || 0} 条，最新 ${latestKlineDate}，读取 ${data.dataHealth?.kline?.source || "待补"}${data.dataHealth?.kline?.originSource ? `（原始来源 ${data.dataHealth.kline.originSource}）` : ""}。`, boundary: "价格、回撤和估值分位不证明价值、盈利质量或催化剂；股票 K 线仅使用 Xueqiu。波动率和流动性：当前读模型未接入，不能推断。", nextEvidence: marketState.nextEvidence || marketGate?.nextStep || "将市场变化逐项对照可访问的公告、业绩、供需和政策来源。", target: "market" },
    { id: "next-evidence", title: "下一条证据", status: firstUnready?.status || "ready", conclusion: firstUnready ? `${firstUnready.label || researchTargets[nextTarget].fallbackLabel} 当前${coverageStatusLabel(firstUnready.status)}，应先处理该门禁。` : "当前基础模块均可进入下一层，仍需按来源时效持续复核。", basis: firstUnready?.conclusionImpact || decision.summary || "当前没有更高优先级的受阻模块。", boundary: "录入、审核、草稿与模型计算只在明确标注的本地工作台；它们不会替代此处已形成或受阻的阅读结果。", nextEvidence: firstUnready?.nextEvidence || decision.nextSteps?.[0] || "查看来源健康、到期复核和新出现的冲突。", target: nextTarget },
  ];
  return h("section", { class: "research-card section-card", "data-research-core-results": "v1" }, [
    h("div", { class: "section-head" }, [h("div", [h("h2", "固定研究结果阅读面"), h("p", { class: "research-meta mb-0" }, "固定按资料、业务、竞争、财务、盈利、估值、风险、市场与下一条证据阅读；每项都保留结论边界、口径/来源和受阻原因。")]), h("span", { class: "research-state" }, decision.state || "资料待补")]),
    h("div", { class: "research-results-grid", "data-research-reading-surface": "fixed-results-v1" }, results.map((item) => h("button", { class: "research-result-card", type: "button", "data-research-result": item.id, "data-result-status": item.status, "aria-label": `${item.title}：${item.conclusion}；查看${researchTargets[item.target].fallbackLabel}`, onClick: () => void chooseTarget(item.target) }, [h("strong", item.title), h("span", { class: "research-state research-result-status" }, coverageStatusLabel(item.status)), h("p", { class: "research-result-conclusion" }, item.conclusion), h("p", { class: "research-result-detail" }, [h("b", "口径/来源："), item.basis]), h("p", { class: "research-result-detail" }, [h("b", "边界："), item.boundary]), h("em", { class: "research-result-next" }, `下一条证据：${item.nextEvidence} →`)]))),
    h("p", { class: "research-results-note" }, "点击任一项进入对应阅读区，查看原始来源、期间/币种/口径、逐项缺口及受阻原因；本地工作台保持在各分区末尾。"),
  ]);
}
function metric(label: string, value: string, hint: string) { return h("article", [h("div", { class: "research-meta" }, label), h("strong", value), h("div", { class: "research-meta mt-1" }, hint)]); }
function evidenceCard(data: RecordValue) {
  const rows = sourceLedgerEvidence(data);
  const content = rows.length ? h("div", { class: "table-responsive" }, h("table", { class: "table table-sm research-table mb-0" }, [
    h("thead", h("tr", [h("th", "证据"), h("th", "状态"), h("th", "时间")])),
    h("tbody", rows.map((item: RecordValue) => h("tr", [
      h("td", item.url ? h("a", { href: item.url, target: "_blank", rel: "noreferrer" }, item.title) : item.title),
      h("td", item.status), h("td", date(item.publishedAt)),
    ]))),
  ])) : h("div", { class: "research-note" }, "尚无精确关联证据。缺失是研究阻断项，不是负面结论。");
  return h("section", { class: "research-card section-card", "data-research-source-ledger": "evidence" }, [h("h2", "原始证据与来源健康"), h("p", { class: "research-meta" }, "事件线索、已接受经营/治理来源事实和法定实际分层并列；来源链接不等于系统判断或估值输入。"), content]);
}

/**
 * The summary must not hide accepted source-bound ledger records merely
 * because they are not market-event evidence.  This deliberately projects
 * only immutable references already returned by the API; it neither infers
 * evidence from a narrative nor upgrades a source record into a conclusion.
 */
function sourceLedgerEvidence(data: RecordValue): RecordValue[] {
  const rows: RecordValue[] = [];
  const add = (item: RecordValue | null | undefined) => {
    if (!item?.url || !item?.title) return;
    rows.push(item);
  };
  for (const item of Array.isArray(data.evidence) ? data.evidence : []) {
    add({
      id: item.evidenceId || item.url,
      title: item.title || "事件证据",
      url: item.url,
      publishedAt: item.publishedAt,
      status: `${item.grade || "来源"} / ${item.eventStatus || "事件"}`,
    });
  }
  for (const item of data.operating?.sourceFacts?.items || []) {
    add({
      id: item.operatingSourceFactId || item.sourceUrl,
      title: item.sourceTitle || item.subjectLabel || "已接受经营来源事实",
      url: item.sourceUrl,
      publishedAt: item.sourcePublishedAt || item.publishedAt,
      status: `已接受经营来源事实 / ${item.factKind || "待分类"}`,
    });
  }
  for (const item of data.governanceCapitalFacts?.latestFacts || []) {
    add({
      id: item.governanceCapitalFactVersionId || item.sourceUrl,
      title: item.sourceTitle || item.factKey || "已接受治理/资本来源事实",
      url: item.sourceUrl,
      publishedAt: item.publishedAt || item.asOf,
      status: `已接受治理/资本来源事实 / ${item.factKey || "待分类"}`,
    });
  }
  for (const item of Array.isArray(data.formalActuals) ? data.formalActuals : []) {
    for (const reference of Array.isArray(item.sourceReferences) ? item.sourceReferences : []) {
      add({
        id: `${item.actualId || item.forecastId || "formal-actual"}:${reference.url || ""}:${reference.locator || ""}`,
        title: `法定实际 · ${item.fiscalPeriod || "期间待补"} · ${item.metric || "指标待补"}`,
        url: reference.url,
        publishedAt: item.filedAt || item.forecastDate,
        status: `正式实际 / ${item.normalizationStatus || "待核验"}`,
      });
    }
  }
  const unique = new Map<string, RecordValue>();
  for (const item of rows) {
    const key = `${item.url}|${item.status}|${item.title}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || ""))).slice(0, 20);
}

function researchAnchor(targetId: ResearchTargetId, content: any) { const target = researchTargets[targetId]; return h("div", { id: target.anchor, tabindex: -1, "data-research-anchor": targetId }, [content]); }

function foundation(data: RecordValue, focus: ResearchTargetId | null, chooseTarget: (value: ResearchTargetId) => Promise<void>, canWrite: boolean, refreshStatutory: (page?: string) => Promise<void>, statutoryIndexPage: string, setStatutoryIndexPage: (value: string) => void, refreshSecVerification: () => Promise<void>) {
  const dossier = data.dossier || {}; const profile = data.focusProfile?.profile; const foundationTargets: ResearchTargetId[] = ["identity", "financials", "focus-profile", "operating", "competition"];
  const rail = h("nav", { class: "research-local-nav", "aria-label": "基础事实页定位", "data-research-local-nav": "foundation" }, [
    h("strong", "本页定位"),
    ...foundationTargets.map((id) => h("button", { type: "button", "data-research-target-link": id, onClick: () => void chooseTarget(id) }, id === "focus-profile" && profile ? `${researchTargets[id].fallbackLabel} · 公共 v${profile.version}` : researchTargets[id].fallbackLabel)),
  ]);
  const financial = financialCard(data.code, data.financials || {}, data.statutoryVerifications, data.usFinancialPeriodEquivalences || { availability: "unavailable" }, data.statutoryDocuments || {}, canWrite, focus === "financials", refreshStatutory, statutoryIndexPage, setStatutoryIndexPage, refreshSecVerification);
  const focusProfile = h(CompanyFocusProfilePanel, { securityCode: data.code, initial: data.focusProfile || { availability: "unavailable", profile: null }, data, canWrite, onSaved: () => location.reload() });
  const operatingRead = h("div", [
    operatingTypedCards(data.operating || {}),
    researchAnchor("competition", h("div", [
      industryCard(data.industry || {}),
      h("section", { class: "research-grid" }, [governanceCard(data.governance), sectionCard("行业、竞争与壁垒", dossier.competitiveMarkets, competitiveContent, "明确竞争市场边界、对手和侵蚀路径。")]),
    ])),
    h("section", { class: "research-grid" }, [sectionCard("业务与驱动（叙述档案）", dossier.businessModels, businessContent, "记录产品、客户、定价、成本与营运资本如何进入财务。字段化经营模型、驱动计划和市场空间应使用对应 API 写入，不能以此叙述替代。"), sectionCard("市场空间与份额（叙述档案）", dossier.marketSpaceModels, marketContent, "TAM/SAM/SOM 必须含口径、年份、来源与传导链。字段化市场空间应保留上下测算、份额桥与利润池。")]),
  ]);
  const operatingWorkbench = h("details", { class: "research-card research-workbench", open: focus === "operating" ? true : undefined, "data-research-workbench": "business-evidence" }, [
    h("summary", [h("strong", "本地研究工作台：证据、字段绑定与模型录入"), h("span", { class: "research-meta ms-2" }, "仅本地可编辑；不会自动写回情景、估值或结论")]),
    h("div", { class: "research-workbench-body" }, [
    h(InformationEvidenceCandidatesPanel, { securityCode: data.code, canWrite }),
    h(OperatingSourceFactsPanel, { securityCode: data.code, initial: data.operating?.sourceFacts || { availability: "unavailable" }, canWrite }),
    h(OperatingSourceFactBindingsPanel, { securityCode: data.code, initial: data.operating?.sourceFactBindings || { availability: "unavailable", items: [] }, canWrite }),
    h(IndustryComparabilityWorkbench, { securityCode: data.code, companyId: data.identity?.operatingCompany?.companyId || "", canWrite }),
    h(OperatingMarketWorkbench, { securityCode: data.code, canWrite }),
    h(IndustryKpiDriverBindingsPanel, { securityCode: data.code, canWrite }),
    ]),
  ]);
  return h("div", [
    rail,
    h("section", { class: "research-card research-reading-guide" }, [h("h2", "先读事实，再进入本地工作台"), h("p", { class: "research-meta mb-0" }, "默认流只呈现当前研究范围、正式财务、治理与业务/行业证据。录入、候选审核和字段绑定收在各区工作台中；它们不会自动生成经营假设、估值或交易动作。")]),
    h("section", { class: "research-grid" }, [researchAnchor("identity", identityCard(data.identity || {})), researchAnchor("financials", financial)]),
    h("section", { class: "research-card section-card" }, [h("h2", "证券结构、财务口径与治理资本"), h("p", { class: "research-meta" }, "这些事实分别影响每股价值、跨证券比较和资本配置判断；缺失不会由公司层信息补全。"), researchAnchor("focus-profile", focusProfile), h(FinancialEntityProfilePanel, { securityCode: data.code, initial: data.financials?.entityProfile || { availability: "unavailable", status: "unknown", records: [] }, canWrite }), h(FinancialSpecialtyMetricsPanel, { securityCode: data.code, initial: data.financials?.specialtyMetrics || { availability: "unavailable", status: "storage_unavailable", metrics: [], facts: [] }, financialProfile: data.financials?.entityProfile || { records: [] }, canWrite }), h(MarketStructureFactsPanel, { securityCode: data.code, initial: data.marketStructure || { availability: "unavailable" }, canWrite }), h(GovernanceCapitalFactsPanel, { securityCode: data.code, initial: data.governanceCapitalFacts || { availability: "unavailable", definitions: [], latestFacts: [] }, canWrite })]),
    researchAnchor("operating", h("section", { class: "research-reading-section" }, [h("div", { class: "section-head mt-3" }, [h("div", [h("h2", "业务、行业与竞争证据"), h("p", { class: "research-meta mb-0" }, "先读已冻结的模型、行业暴露、可比边界和来源；需要补证据或录入时再展开本地工作台。")])]), operatingRead, operatingWorkbench])),
  ]);
}

function operatingTypedCards(operating: RecordValue) {
  const models = operating.models || {}; const plans = operating.driverPlans || {}; const markets = operating.marketSpaceAssessments || {};
  const card = (title: string, section: RecordValue, renderItem: (item: RecordValue) => any, hint: string) => h("section", { class: `research-card section-card ${sectionState(section)}` }, [h("div", { class: "section-head" }, [h("h2", title), h("span", { class: "research-state" }, sectionLabel(sectionState(section)))]), sectionState(section) === "available" ? section.items.map((item: RecordValue) => h("article", { class: "record" }, renderItem(item))) : h("div", { class: "research-note mt-3" }, `${hint} 当前${sectionState(section) === "unavailable" ? `受阻：${section.reason}` : "待补"}。`)]);
  return h("section", { class: "research-grid" }, [
    card("字段化商业模式与增长约束", models, (item) => [h("strong", `${item.modelType} · ${item.primaryEarningDriver}`), h("p", item.summary), h("div", { class: "research-meta" }, `收入确认：${item.revenueRecognition}`), h("ul", { class: "research-list small" }, (item.segments || []).map((segment: RecordValue) => h("li", `${segment.name}：${segment.revenueFormula}；合同 ${segment.contracts?.length || 0} 项，单位经济 ${segment.unitEconomics?.length || 0} 项`))), refs(item.sourceReferences)], "分部、合同、单位经济与增长约束必须逐项绑定来源"),
    card("驱动树与市场空间校验", { availability: plans.availability === "available" || markets.availability === "available" ? "available" : plans.availability === "unavailable" || markets.availability === "unavailable" ? "unavailable" : "empty", reason: plans.reason || markets.reason, items: [...(plans.items || []).map((item: RecordValue) => ({ ...item, kind: "plan" })), ...(markets.items || []).map((item: RecordValue) => ({ ...item, kind: "market" }))] }, (item) => item.kind === "plan" ? [h("strong", `${item.scenarioName} 驱动计划 · v${item.version}`), h("p", { class: "research-meta" }, `起始收入 ${item.openingRevenue}；预测年度 ${(item.years || []).map((year: RecordValue) => year.fiscalYear).join("、")}`), refs(item.sourceReferences)] : [h("strong", item.marketDefinition), h("p", { class: "research-meta" }, `${item.productBoundary} · ${item.geographicBoundary} · ${item.customerBoundary}`), valueTable({ "市场估算": item.estimates, "份额桥": item.shareBridges, "利润池": item.profitPools }), refs(item.sourceReferences)], "驱动计划从分部单位×价格推导三表；TAM/SAM/SOM 上下测算、份额桥与利润池不能只写单点结论"),
  ]);
}
function identityCard(identity: RecordValue) {
  const profiles = identity.rightsProfiles || [];
  const links = identity.rightsLinks || [];
  const profileBlock = profiles.length
    ? h("div", { class: "mt-3" }, [
      h("h3", { class: "h6" }, "已记录持有人权利"),
      h("ul", { class: "research-list small" }, profiles.slice(0, 3).map((item: RecordValue) => h("li", [
        h("strong", `${item.holderStructure} · ${item.rightsStatus}`),
        `：${item.economicRightsNote || item.votingRightsNote || "权利摘要待补"} `,
        item.sourceUrl ? h("a", { href: item.sourceUrl, target: "_blank", rel: "noreferrer" }, "证据") : null,
      ]))),
    ])
    : h("p", { class: "research-meta mt-3 mb-0" }, "尚无证券权利档案；不假设 A/H/ADR 可互换。");
  const currentCode = identity.listedSecurity?.code || "";
  const listedSecurity = identity.listedSecurity || {};
  const operatingCompany = identity.operatingCompany || {};
  const tradingCurrency = listedSecurity.tradingCurrency || listedSecurity.expectedTradingCurrency || "待补";
  const tradingCurrencyBasis = listedSecurity.tradingCurrency ? "证券身份账本" : listedSecurity.expectedTradingCurrency ? "市场规则；尚待证券级来源登记" : "待补证券级来源";
  const linkBlock = links.length
    ? h("div", { class: "mt-3" }, [
      h("h3", { class: "h6" }, "多地上市 / ADR 关系"),
      h("ul", { class: "research-list small" }, links.slice(0, 5).map((item: RecordValue) => h("li", [
        h("strong", [
          item.securityCode === currentCode ? item.securityCode : h("a", { href: `company-research.html?code=${encodeURIComponent(item.securityCode)}`, title: "切换到关联证券研究页" }, item.securityCode),
          " ↔ ",
          item.relatedSecurityCode === currentCode ? item.relatedSecurityCode : h("a", { href: `company-research.html?code=${encodeURIComponent(item.relatedSecurityCode)}`, title: "切换到关联证券研究页" }, item.relatedSecurityCode),
        ]),
        ` · ${item.relationshipKind} · ${item.relationshipStatus}${item.relatedSharesPerSecurity ? ` · 1 证券对应 ${item.relatedSharesPerSecurity} 关联证券权益` : ""}；${item.conversionAvailability}`,
        item.sourceUrl ? h("a", { class: "ms-1", href: item.sourceUrl, target: "_blank", rel: "noreferrer" }, "证据") : null,
      ]))),
    ])
    : null;
  return h("section", { class: "research-card section-card" }, [
    h("div", { class: "section-head" }, [h("div", [h("h2", "经营公司与上市证券"), h("p", { class: "research-meta mb-0" }, "公司事实与具体证券的价格、股本、币种和权利分开保存；多地上市和 ADR 必须有官方来源，不按名称合并。")])]),
    h("div", { class: "metric-grid mt-3" }, [
      metric("经营公司", operatingCompany.canonicalName || "待确认", operatingCompany.identityStatus || ""),
      metric("证券映射", listedSecurity.mappingStatus || "待确认", listedSecurity.market || ""),
      metric("交易币种", tradingCurrency, tradingCurrencyBasis),
      metric("报告币种", operatingCompany.reportingCurrency || "待补", operatingCompany.reportingCurrency ? "经营公司报告口径；不等同交易币种" : "待补公司报告口径"),
      metric("财年截止日", operatingCompany.fiscalYearEnd || "待补", "用于报告期比较；不由交易市场推断"),
      metric("证券权利", listedSecurity.shareClass || "待补", listedSecurity.depositaryRatio ? `ADR 比例 ${listedSecurity.depositaryRatio}` : ""),
    ]),
    profileBlock,
    linkBlock,
    (identity.gaps || []).length ? h("ul", { class: "research-list research-meta mt-3" }, identity.gaps.map((item: string) => h("li", item))) : null,
  ]);
}
function financialCard(securityCode: string, financials: RecordValue, statutoryVerifications: RecordValue | undefined, usFinancialPeriodEquivalences: RecordValue, statutoryDocuments: RecordValue, canWrite: boolean, openAudit: boolean, refreshStatutory: (page?: string) => Promise<void>, statutoryIndexPage: string, setStatutoryIndexPage: (value: string) => void, refreshSecVerification: () => Promise<void>) {
  const quality = financials.quality || {};
  const dashboard = financialDashboard(quality, financials.availability);
  const sourceRows = financialSeriesRows(financials.quality?.series || []);
  const sourceTable = sourceRows.length ? h("div", { class: "table-responsive mt-3" }, [h("h3", { class: "h6" }, "报表序列与计算链"), h("table", { class: "table table-sm research-table mb-0" }, [
    h("thead", h("tr", [h("th", "项目"), h("th", "期间"), h("th", "数值"), h("th", "计算/来源"), h("th", "输入") ])),
    h("tbody", sourceRows.map((item: RecordValue) => h("tr", [h("td", `${item.metric} · ${item.frequency}`), h("td", item.period?.endDate), h("td", `${item.value?.toLocaleString?.("zh-CN", { maximumFractionDigits: 2 }) ?? "—"} ${item.unit}`), h("td", item.formula), h("td", `${item.inputs?.length || 0} 项`)]))),
  ])]) : null;
  const statementSourceSummary = Array.isArray(financials.statements) && financials.statements.length
    ? h("ul", { class: "research-list research-meta mt-2 mb-0", "data-financial-statement-sources": "origin-and-delivery" }, financials.statements.map((statement: RecordValue) => {
      const origin = Array.isArray(statement.originProviders) && statement.originProviders.length ? statement.originProviders.join(" / ") : "原始来源待确认";
      const currencies = Array.isArray(statement.reportingCurrencies) && statement.reportingCurrencies.length ? statement.reportingCurrencies.join(" / ") : "报告币种待确认";
      const delivery = statement.source === "r2" ? "R2 缓存交付" : statement.source || "读取路径待确认";
      return h("li", `${statementTypeLabel(statement.statementType)}：原始来源 ${origin}；${delivery}；报告币种 ${currencies}；最新报告期 ${statement.latestReportDate || "待补"}；${statement.rows || 0} 行。`);
    }))
    : null;
  return h("section", { class: "research-card section-card" }, [
    h("div", { class: "section-head" }, [h("h2", "财务质量与现金流"), h("span", { class: "research-state" }, financials.availability || "待补")]),
    h("p", { class: "research-meta" }, financials.sourcePolicy || "正式财报来源待补"),
    statementSourceSummary,
    financials.statutoryGate ? h("p", { class: "research-note mt-2 mb-0" }, `法定字段门禁：${financials.statutoryGate.status === "verified" ? "已通过" : "未通过"}；已核验 ${financials.statutoryGate.verifiedMetrics?.join("、") || "无"}。${financials.statutoryGate.reason || ""}`) : null,
    h("details", { class: "mt-3", open: openAudit, "data-financial-audit": "details" }, [
      h("summary", [h("strong", "查看财务趋势、计算链与逐期法定覆盖"), h("span", { class: "research-meta ms-2" }, "完整表格不会掩盖上方门禁")]),
      h("div", { class: "mt-3" }, [dashboard, sourceTable, formalDisclosureCoverageMatrix(financials.formalDisclosureCoverage || {}, openAudit), statutoryDocumentCard(statutoryDocuments, canWrite, refreshStatutory, statutoryIndexPage, setStatutoryIndexPage), h(StatutoryRevisionCandidatesPanel, { securityCode, canWrite }), statutoryVerificationCard(statutoryVerifications || {}, canWrite, financials.sourcePolicy || "", refreshSecVerification), String(financials.sourcePolicy || "").includes("Yahoo") ? h(UsFinancialPeriodEquivalencePanel, { securityCode, initial: usFinancialPeriodEquivalences, canWrite }) : null]),
    ]),
  ]);
}
function statementTypeLabel(value: unknown) { return ({ income: "利润表", balance: "资产负债表", cashflow: "现金流量表" } as Record<string, string>)[String(value)] || String(value || "报表"); }
const financialMetricLabels: Record<string, string> = { revenue: "收入", gross_profit: "毛利", operating_profit: "营业利润", net_profit: "归母/净利润", operating_cash_flow: "经营现金流", capital_expenditure: "资本开支", cash: "现金", total_debt: "总债务", total_equity: "权益", diluted_weighted_average_shares: "稀释加权股数", diluted_shares: "期末稀释股数" };
const financialObservationLabels: Record<string, string> = { yoy: "同比", qoq: "环比", cagr: "CAGR", gross_margin: "毛利率", operating_margin: "营业利润率", net_margin: "净利率", free_cash_flow: "自由现金流", free_cash_flow_margin: "FCF率", cash_conversion: "现金转换", days_sales_outstanding: "DSO", days_inventory_outstanding: "DIO", days_payables_outstanding: "DPO", cash_conversion_cycle: "现金转换周期", net_debt: "净债务", current_ratio: "流动比率", quick_ratio: "速动比率", debt_to_equity: "债务/权益", interest_coverage: "利息覆盖", return_on_equity: "ROE", return_on_assets: "ROA", return_on_invested_capital: "ROIC", incremental_roic: "增量ROIC", net_dilution_rate: "净稀释率", net_profit_per_share: "每股净利润", free_cash_flow_per_share: "每股FCF", book_value_per_share: "每股净资产", capital_expenditure_to_revenue: "资本开支/收入" };
function formattedFinancial(value: unknown, unit: unknown) { return `${typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : "—"}${unit ? ` ${unit}` : ""}`; }
function financialDashboard(quality: RecordValue, availability: unknown) {
  const series: RecordValue[] = Array.isArray(quality.series) ? quality.series : [];
  const observations: RecordValue[] = Array.isArray(quality.observations) ? quality.observations : [];
  const trends: RecordValue[] = Array.isArray(quality.trends) ? quality.trends : [];
  const selectedSeries = ["revenue", "gross_profit", "operating_profit", "net_profit", "operating_cash_flow", "capital_expenditure"];
  const seriesTable = (frequency: string, title: string, count: number) => {
    const rows = selectedSeries.map((metric) => {
      const item = series.find((candidate) => candidate.metric === metric && candidate.frequency === frequency);
      const points = (item?.points || []).filter((point: RecordValue) => point.status === "available").slice(-count);
      return points.length ? h("tr", [h("th", financialMetricLabels[metric] || metric), ...points.map((point: RecordValue) => h("td", [h("div", point.period?.endDate || "—"), h("div", { class: "research-meta" }, formattedFinancial(point.value, item?.unit))]))]) : null;
    }).filter(Boolean);
    return rows.length ? h("div", { class: "table-responsive mt-3" }, [h("h3", { class: "h6" }, title), h("table", { class: "table table-sm research-table mb-0" }, h("tbody", rows))]) : null;
  };
  const latest = (kind: string) => [...observations, ...trends].filter((item) => item.kind === kind).sort((a, b) => String(b.period?.endDate || "").localeCompare(String(a.period?.endDate || "")))[0];
  const metricGroups: Array<[string, string[]]> = [["增长与利润", ["yoy", "qoq", "cagr", "gross_margin", "operating_margin", "net_margin", "free_cash_flow", "free_cash_flow_margin", "cash_conversion"]], ["营运资本与偿债", ["days_sales_outstanding", "days_inventory_outstanding", "days_payables_outstanding", "cash_conversion_cycle", "net_debt", "current_ratio", "quick_ratio", "debt_to_equity", "interest_coverage"]], ["资本效率与每股", ["return_on_equity", "return_on_assets", "return_on_invested_capital", "incremental_roic", "net_dilution_rate", "net_profit_per_share", "free_cash_flow_per_share", "book_value_per_share", "capital_expenditure_to_revenue"]]];
  const observationCards = metricGroups.map(([title, kinds]) => {
    const items = kinds.map(latest).filter(Boolean) as RecordValue[];
    return h("article", [h("h3", { class: "h6" }, title), items.length ? h("div", { class: "metric-grid" }, items.map((item) => h("article", [h("strong", financialObservationLabels[item.kind] || item.kind), h("div", formattedFinancial(item.value, item.unit)), h("div", { class: "research-meta" }, `${item.period?.endDate || "—"} · ${item.formula || ""}`)]))) : h("p", { class: "research-meta mb-0" }, "同口径输入待补，不以零或估算替代。")]);
  });
  const ttmBridge = ["revenue", "gross_profit", "operating_profit", "net_profit", "operating_cash_flow"].map((metric) => {
    const item = series.find((candidate) => candidate.metric === metric && candidate.frequency === "ttm"); const point = (item?.points || []).filter((candidate: RecordValue) => candidate.status === "available").at(-1);
    return point ? h("article", [h("strong", financialMetricLabels[metric] || metric), h("div", formattedFinancial(point.value, item?.unit)), h("div", { class: "research-meta" }, `TTM 截至 ${point.period?.endDate || "—"}`)]) : null;
  }).filter(Boolean);
  if (!series.length) return h("div", { class: "research-note mt-3" }, availability === "source_error" ? "正式财务来源发生错误；未以缓存、估值字段或其他财报源替代。" : "未取得同口径正式三表；不会用零值、估值分位或跨来源数据替代。");
  return h("div", { class: "mt-3" }, [h("h3", { class: "h6" }, "财务趋势、质量与计算链"), h("p", { class: "research-meta" }, "默认显示最近五个年报、十二个季度和最新 TTM；所有指标由同口径事实计算，缺失、不适用或不可比不隐藏为中性。"), ttmBridge.length ? h("div", { class: "metric-grid" }, ttmBridge) : null, seriesTable("annual", "最近年度（最多五年）", 5), seriesTable("quarterly", "最近季度（最多十二季）", 12), h("section", { class: "research-grid mt-3" }, observationCards)]);
}
function statutoryDocumentCard(section: RecordValue, canWrite: boolean, refresh: (page?: string) => Promise<void>, historicalPage: string, setHistoricalPage: (value: string) => void) { const items = Array.isArray(section.items) ? section.items : []; return h("div", { class: "mt-3", "data-statutory-disclosure-index": "official" }, [h("div", { class: "section-head" }, [h("div", [h("h3", { class: "h6 mb-1" }, "法定披露文件索引"), h("p", { class: "research-meta mb-0" }, "已索引官方原文保持可见；本地按页追加索引仅在下方工作台执行，不扫描候选、不确认重述或修改财务事实。")])]), items.length ? h("ul", { class: "research-list small" }, items.slice(0, 8).map((item: RecordValue) => h("li", [h("a", { href: item.documentUrl, target: "_blank", rel: "noreferrer" }, item.title), ` · ${item.registry} · ${item.publishedAt} · ${item.sourceLocator}`]))) : h("p", { class: "research-meta mb-0" }, section.availability === "unavailable" ? `当前受阻：${section.reason || "存储待初始化"}` : "尚未索引官方披露。索引只绑定原始文件，不会替代字段抽取或法定核验。"), canWrite ? h("details", { class: "mt-3", "data-research-workbench": "statutory-disclosure-index" }, [h("summary", "本地工作台：追加官方披露索引页"), h("div", { class: "d-flex gap-2 align-items-center mt-2" }, [h("label", { class: "research-meta mb-0" }, ["页码", h("input", { class: "form-control form-control-sm", type: "number", min: "1", max: "100", step: "1", value: historicalPage, "aria-label": "法定披露历史索引页码", onInput: (event: Event) => setHistoricalPage((event.target as HTMLInputElement).value) })]), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => void refresh(historicalPage) }, `索引第 ${historicalPage || "—"} 页`)])]) : null]); }
function formalDisclosureCoverageMatrix(section: RecordValue, open = false) {
  const rows: RecordValue[] = Array.isArray(section.rows) ? section.rows : [];
  const summary = section.summary || {}; const policy = section.policy || {};
  const title = h("div", { class: "section-head" }, [h("div", [h("h3", { class: "h6 mb-1" }, "正式披露覆盖矩阵"), h("p", { class: "research-meta mb-0" }, "按要求字段 × 报告期 × 主结构化来源 × 法定核验结果展开；缺失、冲突和修订差异都是阻断项。")]), h("span", { class: "research-state" }, section.availability === "available" ? "逐期审计" : "待主源事实")]);
  if (!rows.length) return h("div", { class: "research-note mt-3" }, [title, h("p", { class: "mb-0 mt-2" }, section.reason || "主结构化来源尚未返回覆盖合同的报告期；不会改用法定文件或其他来源。")]);
  const source = (row: RecordValue) => {
    const facts: RecordValue[] = Array.isArray(row.primary?.facts) ? row.primary.facts : [];
    if (!facts.length) return `${row.primary?.provider || "主源"} · 缺失`;
    const fact = facts[0]; const provenance = fact.provenance || {}; const basis = fact.basis || {};
    const detail = `${row.primary?.provider || provenance.sourceType || "主源"} · ${provenance.locator || fact.id} · ${basis.currency || "币种待补"}/${basis.accountingStandard || "准则待补"}/${basis.revision || "修订待补"}`;
    return provenance.url ? h("a", { href: provenance.url, target: "_blank", rel: "noreferrer" }, detail) : detail;
  };
  const verification = (row: RecordValue) => row.statutory?.documentUrl
    ? h("a", { href: row.statutory.documentUrl, target: "_blank", rel: "noreferrer" }, `${row.statutory.provider || "法定披露"} · ${row.statutory.locator || "字段定位"}`)
    : `${row.statutory?.provider || "法定披露"} · 尚无可复现定位`;
  const revision = (row: RecordValue) => {
    const primaryFacts: RecordValue[] = Array.isArray(row.primary?.facts) ? row.primary.facts : [];
    const primaryRevisions = [...new Set(primaryFacts.map((fact) => String(fact.basis?.revision || "")).filter(Boolean))];
    const primary = primaryRevisions.length ? primaryRevisions.map(financialRevisionLabel).join("、") : "主源修订版本待补";
    const statutory = row.statutory?.revision ? financialRevisionLabel(String(row.statutory.revision)) : "法定修订版本未记录";
    return [
      h("div", financialRevisionStateLabel(String(row.revisionState || "not_checked"))),
      h("div", { class: "research-meta" }, `主源：${primary}；法定：${statutory}；观察 ${row.statutory?.observationCount || 0} 次`),
    ];
  };
  return h("details", { class: "research-card section-card mt-3", open }, [
    h("summary", [h("strong", "正式披露覆盖矩阵"), h("span", { class: "research-meta ms-2" }, `匹配 ${summary.match || 0} · 冲突 ${summary.conflict || 0} · 未核验 ${summary.unverified || 0} · 尚未记录 ${summary.notRecorded || 0} · 修订不一致 ${summary.revisionMismatch || 0} · 主源版本冲突 ${summary.primaryConflict || 0}`)]),
    h("div", { class: "mt-3" }, [title, h("p", { class: "research-meta mt-2" }, `${section.reason || ""} 主源：${policy.primaryProvider || "—"}；法定核验：${policy.statutoryProvider || "—"}；${policy.noAutomaticFallback ? "无自动回退。" : ""}`),
      h("div", { class: "table-responsive" }, h("table", { class: "table table-sm research-table mb-0" }, [
        h("thead", h("tr", [h("th", "要求字段 / 报告期"), h("th", "主结构化来源"), h("th", "法定核验"), h("th", "结果 / 修订"), h("th", "受影响阻断项")])),
        h("tbody", rows.map((row) => h("tr", [
          h("td", [h("strong", row.requirement?.label || row.requirement?.metric || "—"), h("div", { class: "research-meta" }, row.period ? `${row.period.kind === "annual" ? "年度" : `Q${row.period.fiscalQuarter || "?"}`} · ${row.period.endDate}` : "报告期待主源返回")]),
          h("td", source(row)), h("td", verification(row)),
          h("td", [h("div", financialCoverageOutcomeLabel(String(row.statutory?.outcome || "not_recorded"))), ...revision(row)]),
          h("td", financialCoverageReasons(Array.isArray(row.blockers) ? row.blockers : [])),
        ]))),
      ])),
    ]),
  ]);
}
const financialCoverageReasonLabels: Record<string, string> = {
  primary_fact_missing_for_report_period: "主源该报告期字段缺失",
  primary_fact_not_collected: "主源尚未采集该字段",
  primary_fact_value_missing: "主源字段没有可用数值",
  primary_revision_conflict: "主源同时存在多个修订版本",
  statutory_verification_not_recorded: "尚未记录同口径法定核验",
  statutory_unverified: "法定核验未通过或无法核验",
  statutory_conflict: "法定披露与主源字段冲突",
  statutory_field_value_missing: "法定披露字段没有可用数值",
  statutory_disclosure_not_collected: "尚未采集或定位法定披露字段",
  normalized_fact_value_missing: "核验所用标准化字段没有可用数值",
  accounting_revision_mismatch: "主源与法定披露修订版本不一致",
  accounting_basis_or_revision_mismatch: "会计基础或修订版本不一致",
};
function financialCoverageReasons(codes: unknown[]) {
  if (!codes.length) return "—";
  return h("ul", { class: "research-list small mb-0" }, codes.map((code) => {
    const value = String(code);
    return h("li", `${financialCoverageReasonLabels[value] || "未分类审计阻断"}（${value}）`);
  }));
}
function financialCoverageOutcomeLabel(outcome: string) {
  return ({ match: "匹配", conflict: "冲突", unverified: "未核验", not_recorded: "尚未记录" } as Record<string, string>)[outcome] || `未知结果（${outcome}）`;
}
function financialRevisionLabel(revision: string) {
  return ({ reported: "原始披露（reported）", restated: "更正/重述（restated）" } as Record<string, string>)[revision] || `未识别版本（${revision}）`;
}
function financialRevisionStateLabel(state: string) {
  return ({ matched: "主源与法定修订版本一致", mismatch: "主源与法定修订版本不一致", not_checked: "尚未取得可比法定修订版本", primary_conflict: "主源存在多个修订版本冲突" } as Record<string, string>)[state] || `未知修订状态（${state}）`;
}
function statutoryVerificationCard(section: RecordValue, canWrite: boolean, sourcePolicy: string, refreshSecVerification: () => Promise<void>) {
  const items: RecordValue[] = Array.isArray(section.items) ? section.items : [];
  const counts = items.reduce((result: RecordValue, item) => { result[item.outcome || "unverified"] = (result[item.outcome || "unverified"] || 0) + 1; return result; }, {});
  const refresh = canWrite && sourcePolicy.includes("Yahoo") ? h("details", { class: "ms-auto", "data-research-workbench": "sec-statutory-verification" }, [h("summary", { class: "btn btn-outline-secondary btn-sm" }, "本地工作台：以 SEC 核验 Yahoo 字段"), h("div", { class: "mt-2" }, [h("p", { class: "research-meta mb-2" }, "仅追加独立核验记录；不会用 SEC 数值替换 Yahoo 主结构化事实。"), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => void refreshSecVerification() }, "运行 SEC 字段核验")])]) : null;
  if (!items.length) return h("div", { class: "research-note mt-3" }, [h("div", { class: "section-head" }, [h("strong", "法定披露字段核验"), refresh]), `法定披露字段核验：${section.availability === "unavailable" ? `受阻（${section.reason || "存储或来源待补"}）` : "未核验"}。当前结构化来源不能被表述为最终法定事实；需按市场使用 CNINFO / HKEX / SEC 的正式披露定位。`]);
  const table = h("div", { class: "table-responsive" }, h("table", { class: "table table-sm research-table mb-0" }, [
    h("thead", h("tr", [h("th", "字段 / 期间"), h("th", "法定来源"), h("th", "结果"), h("th", "差异 / 原因")])),
    h("tbody", items.slice(0, 12).map((item) => h("tr", [
      h("td", `${item.normalizedFact?.metric || "—"} · ${item.normalizedFact?.period?.endDate || "—"}`),
      h("td", item.statutoryDisclosure?.disclosureUrl ? h("a", { href: item.statutoryDisclosure.disclosureUrl, target: "_blank", rel: "noreferrer" }, `${item.provider || "法定披露"} · ${item.statutoryDisclosure.locator || "原始文件"}`) : `${item.provider || "法定披露"} · 定位待补`),
      h("td", item.outcome || "unverified"),
      h("td", `${item.absoluteDelta ?? "—"}；${(item.reasonCodes || []).join("、") || "—"}`),
    ]))),
  ]));
  return h("div", { class: "mt-3" }, [
    h("div", { class: "section-head" }, [h("h3", { class: "h6" }, "法定披露字段核验（独立于结构化来源）"), refresh]),
    h("p", { class: "research-meta" }, `匹配 ${counts.match || 0} · 冲突 ${counts.conflict || 0} · 未核验 ${counts.unverified || 0}。冲突不平均，未核验不提升为已证实事实。`),
    table,
  ]);
}
function industryCard(industry: RecordValue) {
  const exposures = industry.exposures || {}; const universes = industry.peerUniverses || {};
  const typedExposures = industry.typedTrackExposures || {}; const typedPeers = industry.typedPeerComparisonSets || {};
  const exposureContent = sectionState(exposures) === "available"
    ? exposures.items.map((item: RecordValue) => h("article", { class: "record" }, [h("strong", `主营暴露 · ${item.selectionBasis}`), h("p", item.primaryBusinessDescription), valueTable({ 范围: item.exposureScope, 收入或利润暴露: item.exposureShare, 版本: item.version }), refs(item.sourceReferences)]))
    : h("div", { class: "research-note mt-3" }, `行业暴露${sectionState(exposures) === "unavailable" ? `受阻：${exposures.reason}` : "待补"}。必须以主营业务和来源证据确定，不能用页面标签替代。`);
  const peerContent = sectionState(universes) === "available"
    ? universes.items.map((universe: RecordValue) => h("article", { class: "record" }, [h("strong", `${universe.comparisonPurpose} · v${universe.version}`), h("p", universe.selectionCriteria), valueTable({ 跨市场比较政策: universe.crossMarketPolicy }), h("ul", { class: "research-list small" }, (universe.members || []).map((member: RecordValue) => h("li", `${member.peerName}：${member.membershipStatus} / ${member.comparabilityStatus}${member.exclusionReason ? `；排除原因：${member.exclusionReason}` : ""}`))), refs(universe.sourceReferences)]))
    : h("div", { class: "research-note mt-3" }, `同行可比池${sectionState(universes) === "unavailable" ? `受阻：${universes.reason}` : "待补"}。未定义可比性、财年/币种/会计差异前，不展示排名或投资结论。`);
  const typedExposureContent = sectionState(typedExposures) === "available"
    ? typedExposures.items.map((item: RecordValue) => h("article", { class: "record" }, [h("strong", `${item.selectionBasis === "primary_business" ? "主营" : "次要"}业务暴露 · v${item.version}`), h("p", item.exposureDescription), valueTable({ 分部: item.businessSegment, 产品: item.productScope, 地区: item.geographicScope, 客户: item.customerScope, 归属占比: (item.shares || []).map((share: RecordValue) => `${share.measure} ${share.value} ${share.unit}（${share.basisPeriod}）`).join("；") || "待补" }), refs(item.sourceReferences)]))
    : h("div", { class: "research-note mt-3" }, `字段化行业暴露${sectionState(typedExposures) === "unavailable" ? `受阻：${typedExposures.reason}` : "待补"}。须由主营/次要业务选择依据与逐字段来源支撑。`);
  const typedPeerContent = sectionState(typedPeers) === "available"
    ? typedPeers.items.map((set: RecordValue) => h("article", { class: "record" }, [h("strong", `${set.comparisonPurpose} · v${set.version}`), h("p", set.selectionCriteria), h("ul", { class: "research-list small" }, (set.members || []).map((member: RecordValue) => h("li", `${member.peerName}：${member.membershipStatus} / ${member.comparabilityStatus}${member.exclusionReason ? `；${member.exclusionReason}` : ""}${(member.dimensions || []).filter((dimension: RecordValue) => dimension.status === "adjustment_required").length ? "；存在跨市场调整" : ""}`))), refs(set.sourceReferences)]))
    : h("div", { class: "research-note mt-3" }, `字段化同行集${sectionState(typedPeers) === "unavailable" ? `受阻：${typedPeers.reason}` : "待补"}。未记录财年、币种、会计和证券权利差异时，不能把同行数据直接并列。`);
  return h("section", { class: "research-grid" }, [h("section", { class: "research-card section-card" }, [h("h2", "行业 profile 与公司主营暴露"), typedExposureContent, exposureContent]), h("section", { class: "research-card section-card" }, [h("h2", "同行可比池与跨市场边界"), typedPeerContent, peerContent])]);
}
function financialSeriesRows(series: RecordValue[]) {
  const preferred = new Set(["revenue", "net_profit", "operating_cash_flow"]);
  return series.filter((item) => preferred.has(item.metric) && ["annual", "quarterly"].includes(item.frequency)).flatMap((item) =>
    (item.points || []).filter((point: RecordValue) => point.status === "available").slice(-2).map((point: RecordValue) => ({ ...point, metric: item.metric, frequency: item.frequency, unit: item.unit })),
  ).sort((left: RecordValue, right: RecordValue) => String(right.period?.endDate || "").localeCompare(String(left.period?.endDate || ""))).slice(0, 9);
}
function governanceCard(section: RecordValue) { return sectionCard("管理层、治理与资本配置", section, (item) => [h("strong", `${item.dimension} · ${item.title}`), h("p", item.statement), refs(item.sourceReferences)], "管理层能力、指引可信度、治理、利益一致性与资本配置各自留证。") }

function model(data: RecordValue, _canWrite: boolean) { const dossier = data.dossier || {}; return h("div", { id: researchTargets.valuation.anchor, tabindex: -1, "data-research-anchor": "valuation" }, [h("section", { class: "research-card research-reading-guide" }, [h("h2", "预测、情景与估值：自动研究阅读层"), h("p", { class: "research-meta mb-0" }, "来源预测、来源情景、确定性汇总、校准和估值版本均由已保存输入自动生成或自动阻断；页面不提供人工审核、手填情景或估值录入入口。")]), researchAnchor("forecasts", forecastSummaryCard(data.forecastWorkspace || {})), valuationModelsCard(data.valuationModels || {}, data.reverseValuationModels || {}, data.coverage || {}), relativeValuationLedgerCard(data.relativeValuationLedgers || {}), h("section", { class: "research-grid" }, [sectionCard("证券估值与预期", dossier.valuationCases, valuationContent, "从来源绑定经营假设到企业价值、股权价值和每股价值；未接证券权利/股本时保持不可得。"), valuationGate(data)])]); }

function forecastSummaryCard(workspace: RecordValue) {
  const forecasts = Array.isArray(workspace.sourceForecasts) ? workspace.sourceForecasts : Array.isArray(workspace.sourceForecasts?.items) ? workspace.sourceForecasts.items : [];
  const candidates = Array.isArray(workspace.sourceCandidates) ? workspace.sourceCandidates : Array.isArray(workspace.sourceCandidates?.items) ? workspace.sourceCandidates.items : [];
  const consolidation = workspace.consolidation || null;
  const members = Array.isArray(consolidation?.members) ? consolidation.members : [];
  const status = workspace.layerStatus?.status || workspace.consolidationStatus?.status || (forecasts.length ? "partial" : "unavailable");
  const reason = workspace.layerStatus?.reason || workspace.consolidationStatus?.reason || "尚无经 document + version 身份断言审核的来源预测。";
  return h("section", { class: `research-card section-card ${status}`, "data-research-forecast-summary": "v4" }, [
    h("div", { class: "section-head" }, [h("div", [h("h2", "来源预测与样本汇总"), h("p", { class: "research-meta mb-0" }, "只读取已冻结来源身份、承载关系和独立来源组；机会样本不称市场一致预期。")]), h("span", { class: "research-state" }, coverageStatusLabel(status))]),
    h("p", { class: "research-meta mt-3" }, `已审核来源预测 ${forecasts.length} 条；待审核候选 ${candidates.length} 条；当前汇总成员 ${members.length} 条。`),
    consolidation ? h("p", { class: "research-meta" }, `汇总状态：${consolidation.status || "待补"}；${consolidation.label || consolidation.reason || "按独立来源组去重后才允许纳入。"}`) : h("div", { class: "research-note mt-2" }, `当前受阻：${reason}`),
    forecasts.length ? h("ul", { class: "research-list small" }, forecasts.slice(0, 5).map((forecast: RecordValue) => h("li", `${forecast.institution || "机构待确认"} · ${forecast.metric || "指标待确认"} · ${forecast.fiscalPeriod || forecast.fiscalYear || "期间待确认"} · ${forecast.inclusionStatus || forecast.status || "待审核"}`))) : null,
  ]);
}
function valuationModelsCard(section: RecordValue, reverseSection: RecordValue, coverage: RecordValue) { const items = Array.isArray(section.items) ? section.items : []; const reverseItems = Array.isArray(reverseSection.items) ? reverseSection.items : []; const valuationCoverage = Array.isArray(coverage.modules) ? coverage.modules.find((item: RecordValue) => item.moduleId === "valuation") : null; const currentConclusionAllowed = valuationCoverage?.status === "ready"; const availability = currentConclusionAllowed && (section.availability === "available" || reverseSection.availability === "available") ? "available" : items.length || reverseItems.length ? "unavailable" : section.availability || reverseSection.availability || "unavailable"; const blockedNotice = !currentConclusionAllowed && (items.length || reverseItems.length) ? h("div", { class: "research-note mt-3" }, `历史模型已保留供审计，但不是当前估值结论：${valuationCoverage?.conclusionImpact || "前置事实未通过"}`) : null; const dcfContent = (item: RecordValue) => currentConclusionAllowed ? [valueTable({ 截止日: date(item.asOf), 估值币种: item.valuationCurrency, 证券币种: item.securityCurrency, 每份证券价值: item.perSecurityValue, 企业价值: item.result?.enterpriseValue, 股权价值: item.result?.equityValue, 每基础股价值: item.result?.valuePerShare, "ADR/基础股比例": item.underlyingSharesPerSecurity, FX: item.fxRateToSecurity ?? "同币种" }), valuationInputTable(item.inputs), refs(item.sourceReferences)] : [h("p", { class: "research-meta mt-2 mb-0" }, `冻结于 ${date(item.asOf)}；当前门禁未通过，精确每股价值、股权价值、企业价值和敏感性不展示。`), valuationInputTable(item.inputs), refs(item.sourceReferences)]; const reverseContent = (item: RecordValue) => currentConclusionAllowed ? [valueTable({ 截止日: date(item.asOf), 价格日期: date(item.priceAsOf), 估值币种: item.valuationCurrency, 证券币种: item.securityCurrency, 每份证券价格: item.pricePerSecurity, 股数倍率: item.dilutedSharesScale, 市场资本化: item.result?.marketCapitalizationInSecurityCurrency, 转换后股权价值: item.result?.equityValue, 隐含企业价值: item.result?.enterpriseValue, 隐含终值UFCF: item.result?.impliedTerminalUnleveredFreeCashFlow, 隐含终值收入: item.result?.impliedTerminalRevenue ?? "未给终值UFCF利润率", "ADR/基础股比例": item.underlyingSharesPerSecurity, FX: item.fxRateToValuation ?? "同币种" }), refs(item.sourceReferences)] : [h("p", { class: "research-meta mt-2 mb-0" }, `冻结于 ${date(item.asOf)}；当前门禁未通过，市场资本化、隐含企业价值和终值条件不展示。`), refs(item.sourceReferences)]; return h("section", { class: `research-card section-card ${availability}` }, [h("h2", "已保存的版本化估值模型"), h("p", { class: "research-meta" }, "先阅读冻结版本、输入、币种/证券权利和来源，再展开或新建工作台；任何新事实只会产生待复核，不会回写这些版本。"), blockedNotice, items.length ? items.map((item: RecordValue) => h("article", { class: "record" }, [h("strong", `正向 DCF · ${item.modelVersionId} · ${item.status}`), ...dcfContent(item)])) : null, reverseItems.length ? reverseItems.map((item: RecordValue) => h("article", { class: "record" }, [h("strong", `反向 DCF · ${item.modelVersionId} · ${item.status}`), ...reverseContent(item)])) : null, !items.length && !reverseItems.length ? h("div", { class: "research-note mt-3" }, availability === "unavailable" ? `当前受阻：${section.reason || reverseSection.reason || "模型存储待初始化"}` : "尚无已保存模型。预览不会成为结论；保存后才会固定输入、认识类型、来源、FX、证券权利、输出和敏感性。") : null]); }
function relativeValuationLedgerCard(section: RecordValue) {
  const items: RecordValue[] = Array.isArray(section.items) ? section.items : [];
  if (!items.length) return h("section", { class: `research-card section-card ${section.availability || "empty"}` }, [h("h2", "主估值原型与辅助相对估值工作台"), h("p", { class: "research-meta" }, "相对估值必须冻结同行范围、逐年输入和六项可比性门禁（全部必填）；不会计算同行平均、市场一致预期、目标价或交易建议。"), h("div", { class: "research-note" }, section.availability === "unavailable" ? `当前受阻：${section.reason || "账本待初始化"}` : "尚无已保存相对估值账本。必须先完成有来源的同行范围与可比性审查。")]);
  return h("section", { class: "research-card section-card available" }, [
    h("h2", "主估值原型与辅助相对估值工作台"),
    h("p", { class: "research-meta" }, "每条记录只重放冻结输入；门禁未通过时比较保持阻断或待调整，绝不以同行平均伪造精确度。"),
    ...items.map((item) => h("article", { class: "record" }, [
      h("div", { class: "section-head" }, [h("strong", `${item.role === "primary" ? "主" : "辅助"} · ${item.archetype} / ${item.method}`), h("span", { class: "research-state" }, item.readiness?.status || "blocked")]),
      h("p", { class: "research-meta" }, `${date(item.asOf)} · 同行范围 ${item.peerUniverseId} · ${item.valuationCurrency}/${item.securityCurrency}`),
      h("p", item.applicabilityRationale), refs(item.rationaleSourceReferences || []),
      h("div", { class: "table-responsive mt-2" }, h("table", { class: "table table-sm research-table mb-0" }, [
        h("thead", h("tr", [h("th", "对象"), h("th", "指标"), h("th", "期间"), h("th", "可重放结果")])),
        h("tbody", (item.metrics || []).map((metric: RecordValue) => h("tr", [h("td", metric.subjectKind === "target" ? "目标证券" : `同行 · ${metric.peerMemberId}`), h("td", metric.metricType), h("td", metric.fiscalYear || metric.periodBasis), h("td", `${metric.value ?? "—"} ${metric.displayUnit || ""}`)]))),
      ])),
      h("ul", { class: "research-list research-meta mt-2" }, (item.comparabilityGates || []).map((gate: RecordValue) => h("li", `${gate.gateKind}：${gate.status}；${gate.rationale}`))),
      item.readiness?.blockedReasons?.length ? h("div", { class: "research-note mt-2" }, `比较限制：${item.readiness.blockedReasons.map((reason: RecordValue) => reason.message).join("；")}`) : null,
      h("details", { class: "mt-2" }, [h("summary", "冻结输入与来源"), ...(item.inputs || []).map((input: RecordValue) => h("div", { class: "record" }, [h("strong", `${input.subjectKind === "target" ? "目标" : `同行 ${input.peerMemberId}`} · ${input.label}`), `：${input.value} ${input.unit} · ${input.inputKind} / ${input.epistemicType}`, refs(input.sourceReferences || [])]))]),
    ])),
  ]);
}
function valuationInputTable(inputs: unknown) { const rows = Array.isArray(inputs) ? inputs : []; return rows.length ? h("div", { class: "table-responsive mt-3" }, [h("h3", { class: "h6" }, "冻结输入与证据"), h("table", { class: "table table-sm research-table mb-0" }, [h("thead", h("tr", [h("th", "输入"), h("th", "数值/单位"), h("th", "认识类型"), h("th", "来源") ])), h("tbody", rows.map((input: RecordValue) => h("tr", [h("td", input.label || input.key || "—"), h("td", `${input.value ?? "—"}${input.unit ? ` ${input.unit}` : ""}`), h("td", input.epistemicType || "—"), h("td", refs(input.sourceReferences || []))])))])]) : h("p", { class: "research-meta mt-2" }, "该版本未存入可展示的字段化输入。") }
function valuationGate(data: RecordValue) { const identity = data.identity || {}; const finance = data.financials || {}; return h("section", { class: "research-card section-card unavailable" }, [h("h2", "估值前置条件"), h("ul", { class: "research-list research-meta" }, [h("li", `公司与证券映射：${identity.listedSecurity?.mappingStatus || "待确认"}`), h("li", `正式财务覆盖：${finance.availability || "待补"}`), h("li", "当前估值案例只能作为带版本的研究假设；反向估值、敏感性和每股价值须由完整经营模型与证券股本驱动。")])]); }

function review(data: RecordValue, canWrite: boolean, chooseTarget: (value: ResearchTargetId) => Promise<void>) { const dossier = data.dossier || {}; return h("div", { id: researchTargets.risk_review.anchor, tabindex: -1, "data-research-anchor": "risk_review" }, [h("section", { class: "research-card research-reading-guide" }, [h("h2", "风险、事件与变化：先看当前待复核项"), h("p", { class: "research-meta mb-0" }, "全研究快照是主历史；风险快照是专项记录，旧 dossier 快照只是兼容历史。它们不会彼此替代或回填。")]), h("section", { class: "research-grid" }, [sectionCard("研究命题与证据", dossier.theses, thesisContent, "每项命题需要支持、反对或冲突证据及复核日期。"), risksCard(dossier.risks)]), h(ResearchReviewQueuePanel, { queue: data.researchReviewQueue || {}, onNavigate: (target: ResearchTargetId) => void chooseTarget(target) }), h(ResearchSnapshotHistoryWorkbench, { securityCode: data.code, canWrite }), riskReviewCard(data.riskReview || {}), h("section", { class: "research-grid" }, [sectionCard("催化剂与事件日历", dossier.catalysts, catalystContent, "区分已发生、管理层指引和外部预期，并标明影响的假设。"), sectionCard("变化与复盘（旧记录）", dossier.snapshots, snapshotContent, "记录当时可见的信息，不用新事实覆盖历史判断。")]), h("details", { class: "research-card research-workbench", "data-research-workbench": "risk-event-review" }, [h("summary", [h("strong", "本地研究工作台：压力测试、事件复盘与人工处置"), h("span", { class: "research-meta ms-2" }, "风险专项快照位于此处，不替代公共全研究快照")]), h("div", { class: "research-workbench-body" }, [h(RiskReviewWorkbench, { securityCode: data.code, canWrite, risks: dossier.risks?.items || [], theses: dossier.theses?.items || [] }), h(CatalystReviewWorkbench, { securityCode: data.code, canWrite, catalysts: dossier.catalysts?.items || [], onSaved: () => location.reload() }), h(GuidanceEventImpactReviewWorkbench, { securityCode: data.code, canWrite, guidance: data.managementGuidance || [], formalActuals: data.formalActuals || [], catalysts: dossier.catalysts?.items || [], scenarios: data.forecastWorkspace?.scenarios || [], valuationModels: data.valuationModels?.items || [], reverseValuationModels: data.reverseValuationModels?.items || [], theses: dossier.theses?.items || [], risks: dossier.risks?.items || [], reviews: data.guidanceEventImpactReviews?.items || [], onSaved: () => location.reload() }), h(SnapshotHistoryWorkbench, { securityCode: data.code })])])]); }
function riskReviewCard(review: RecordValue) {
  if (review.availability !== "available") return h("section", { class: "research-card section-card unavailable" }, [h("h2", "压力、集中度与快照差分"), h("div", { class: "research-note" }, review.availability === "unavailable" ? `当前受阻：${review.reason}` : "尚未建立压力情景、关系/集中度或模块快照差分。风险台账不等同于压力测试；个人持仓和交易计划不会进入公共快照。")]);
  const scenarios = (review.pressureScenarios || []).map((item: RecordValue) => h("article", { class: "record" }, [h("strong", `${item.title} · ${item.status} / v${item.version}`), h("p", { class: "research-meta" }, `传导：${item.transmission}；模型：${item.modelVersion}`), valueTable({ 输入: item.inputs, 结果: item.results }), refs(item.sourceReferences)]));
  const relationships = (review.relationships || []).map((item: RecordValue) => h("li", `${item.relationshipType} · ${item.counterpartyName}：${item.description}；集中度 ${item.concentrationValue ?? "待补"}${item.concentrationBasis ? `（${item.concentrationBasis}）` : ""}`));
  const differences = (review.snapshotDifferences || []).map((item: RecordValue) => h("li", `${item.moduleId}：${item.changeType}；${(item.fields || []).map((field: RecordValue) => field.path).join("、") || "模块变更"}`));
  return h("section", { class: "research-card section-card" }, [h("h2", "压力、集中度与快照差分"), scenarios.length ? scenarios : h("p", { class: "research-meta" }, "尚无压力情景。"), relationships.length ? h("div", [h("h3", { class: "h6 mt-3" }, "风险关系与集中度"), h("ul", { class: "research-list small" }, relationships)]) : null, differences.length ? h("div", [h("h3", { class: "h6 mt-3" }, "研究快照差分"), h("ul", { class: "research-list small" }, differences)]) : null]);
}
function personal(data: RecordValue) { return h("div", [h("section", { class: "research-card private-boundary" }, [h("div", { class: "section-head" }, [h("div", [h("h2", "个人研究区"), h("p", { class: "research-meta mb-0" }, "关注原因、个人判断和待验证问题只属于当前用户；不会改写公共事实、来源观点或系统模型。")])]), sectionState(data.dossier?.userNotes) === "available" ? data.dossier.userNotes.items.map((item: RecordValue) => h("article", { class: "record" }, [h("strong", item.noteType), h("p", item.content), refs(item.sourceReferences)])) : h("div", { class: "research-note mt-3" }, "尚无个人记录。个人仓位和交易计划只能引用此处研究，不能反向改变公共事实。")]), h(OwnerHoldingSnapshotReferencesPanel, { securityCode: data.code, canWrite: Boolean(data.capabilities?.canWriteLocally) })]); }

function sectionCard(title: string, section: RecordValue, renderItem: (item: RecordValue) => any[], emptyHint: string) { const state = sectionState(section); return h("section", { class: `research-card section-card ${state}` }, [h("div", { class: "section-head" }, [h("h2", title), h("span", { class: "research-state" }, sectionLabel(state))]), state === "available" ? section.items.map((item: RecordValue) => h("article", { class: "record" }, renderItem(item))) : h("div", { class: "research-note mt-3" }, state === "unavailable" ? `当前受阻：${section?.reason || "身份或存储待补"}` : emptyHint)]); }
function businessContent(item: RecordValue) { return [h("strong", item.primaryEarningDriver || item.summary), h("p", item.summary), h("div", { class: "research-meta" }, `收入确认：${item.revenueRecognition || "待补"}`), item.segments?.length ? h("ul", { class: "research-list small" }, item.segments.map((segment: RecordValue) => h("li", `${segment.name}：${segment.revenueDriver || "驱动待补"}；${segment.pricingModel || "定价待补"}`))) : null, refs(item.sourceReferences)]; }
function marketContent(item: RecordValue) { return [h("strong", item.marketDefinition), valueTable({ TAM: item.tam, SAM: item.sam, SOM: item.som, "行业利润池": item.profitPool, "传导到财务": item.transmission }), refs(item.sourceReferences)]; }
function competitiveContent(item: RecordValue) { return [h("strong", item.definition), h("p", { class: "research-meta" }, `${item.productScope || "产品待补"} · ${item.customerScope || "客户待补"} · ${item.geographyScope || "地区待补"}`), valueTable({ 市场结构: item.structure, 壁垒机制: item.advantages, 侵蚀路径: item.erosionPaths }), item.competitors?.length ? h("ul", { class: "research-list small" }, item.competitors.map((x: RecordValue) => h("li", `${x.name}（${x.competitorType}）：${x.comparabilityNote}`))) : null, refs(item.sourceReferences)]; }
function thesisContent(item: RecordValue) { return [h("strong", item.title), h("p", item.statement), h("div", { class: "research-meta" }, `状态：${item.status}；证伪：${item.invalidationCondition}；复核：${date(item.reviewBy)}`), ...(item.evidence || []).map((e: RecordValue) => h("p", { class: "small" }, `[${e.stance}] ${e.statement}`))]; }
function valuationContent(item: RecordValue) { return [h("strong", `${item.valuationType} · ${item.methodRationale}`), valueTable({ 假设: item.assumptions, 结果: item.result, 敏感性: item.sensitivity }), refs(item.sourceReferences)]; }
function risksCard(section: RecordValue) { const state = sectionState(section); return h("section", { class: `research-card section-card ${state}` }, [h("div", { class: "section-head" }, [h("h2", "风险与证伪"), h("span", { class: "research-state" }, sectionLabel(state))]), state === "available" ? section.items.map((item: RecordValue) => h("article", { class: `record risk ${item.status}` }, [h("strong", `${item.category} · ${item.title}`), h("p", item.exposure), h("div", { class: "research-meta" }, `传导：${item.transmission}；触发：${item.triggerCondition}`), h("div", { class: "research-meta" }, `毛风险：${text(item.grossRisk)}；缓释：${text(item.verifiedMitigation)}；剩余风险：${text(item.residualRisk)}`), refs(item.sourceReferences)])) : h("div", { class: "research-note mt-3" }, "尚无结构化风险台账；市场波动提示不能替代风险、压力测试与证伪记录。")]); }
function catalystContent(item: RecordValue) { const reviews = item.reviews || []; return [h("strong", item.title), h("p", { class: "small" }, `${date(item.eventAt)} · ${item.status} · 影响：${item.impactedAssumption}`), item.expectedEffect ? h("p", { class: "research-meta" }, item.expectedEffect) : null, reviews.length ? h("div", { class: "research-note small mt-2" }, `已有 ${reviews.length} 次事后复盘；最近：${reviews[0].reviewStatus} / 假设${reviews[0].impactedAssumptionStatus}`) : h("div", { class: "research-meta small mt-2" }, "尚无事后复盘；不能用当前结论替代事件实际结果。"), refs(item.sourceReferences)]; }
function snapshotContent(item: RecordValue) { return [h("strong", `${date(item.asOf)} · ${item.completionLevel} · ${item.state}`), valueTable({ 摘要: item.summary, 模块状态: item.moduleStatus })]; }
function valueTable(values: RecordValue) { return h("div", { class: "table-responsive mt-2" }, h("table", { class: "table table-sm research-table mb-0" }, [h("tbody", Object.entries(values).map(([key, value]) => h("tr", [h("th", key), h("td", compact(value))])))])); }

function emptyForm(kind?: ComposerKind): RecordValue { return { status: "draft", epistemicType: kind === "thesis" || kind === "risk" || kind === "snapshot" ? "system_judgment" : "observed_fact", sourceUrl: "", sourceTitle: "", companyId: "", canonicalName: "", reportingCurrency: "", fiscalYearEnd: "", relationshipType: "primary_listing", relationshipStatus: "confirmed", relationshipNote: "", shareClass: "", depositaryRatio: "", securityInstrumentType: "stock", recordRights: "no", rightsStatus: "confirmed", holderStructure: "direct_registered_holder", legalIssuerName: "", votingRightsNote: "", economicRightsNote: "", transferabilityNote: "", structuralRiskNote: "", depositaryName: "", depositaryFeeNote: "", evidenceKind: "official_exchange_disclosure", rightsSourceTitle: "", rightsSourceNote: "", linkedCode: "", linkedName: "", linkedMarket: "", linkedCurrency: "", linkedInstrumentType: "stock", linkedShareClass: "", linkedDepositaryRatio: "", linkedRelationshipType: "secondary_listing", linkedRelationshipStatus: "confirmed", linkedRelationshipNote: "", linkKind: "same_operating_company_different_security", relatedSharesPerSecurity: "", conversionAvailability: "restricted", linkNote: "", summary: "", title: "", statement: "", primaryDriver: "", revenueRecognition: "", segment: "", pricing: "", marketDefinition: "", tam: "", sam: "", som: "", profitPool: "", transmission: "", topDown: "", bottomUp: "", dimension: "management_capability", definition: "", productScope: "", customerScope: "", geographyScope: "", structure: "", advantages: "", erosionPaths: "", competitor: "", competitorType: "direct", method: "dcf", rationale: "", assumption: "", result: "", sensitivity: "", category: "", scope: "operating_company", exposure: "", lossRange: "", likelihood: "", impact: "", speed: "", reversibility: "", mitigation: "", residualRisk: "", trigger: "", reviewFrequency: "quarterly", catalystStatus: "guided", eventType: "earnings", impactedAssumption: "", expectedEffect: "", noteType: "question", content: "", completionLevel: "basic", state: "资料待补" }; }
function buildPayload(kind: ComposerKind, form: RecordValue) { const now = Date.now(); const refs = form.sourceUrl.trim() ? [{ sourceKind: "external_url", url: form.sourceUrl.trim(), title: form.sourceTitle.trim() || form.sourceUrl.trim(), publishedAt: now }] : []; const base = { asOf: now, status: form.status, epistemicType: form.epistemicType, sourceReferences: refs }; const typed = (label: string, value: string) => ({ label, value, epistemicType: form.epistemicType, sourceReferences: refs }); const metric = (label: string, value: string) => ({ label, value, period: new Date(now).getFullYear(), epistemicType: form.epistemicType, sourceReferences: refs });
  if (kind === "identity") { const evidence = { evidenceKind: form.evidenceKind, sourceUrl: required(form.sourceUrl, "关系来源链接"), sourceTitle: required(form.rightsSourceTitle || form.sourceTitle, "官方来源标题"), sourceNote: required(form.rightsSourceNote || form.relationshipNote, "官方证据说明") }; const payload: RecordValue = { securityInstrumentType: form.securityInstrumentType, shareClass: form.shareClass || null, depositaryRatio: form.depositaryRatio || null, operatingCompany: { companyId: required(form.companyId, "经营公司ID"), canonicalName: required(form.canonicalName, "经营公司名称"), reportingCurrency: form.reportingCurrency || null, fiscalYearEnd: form.fiscalYearEnd || null, identityStatus: form.relationshipStatus === "conflicting" ? "needs_review" : form.relationshipStatus }, relationship: { relationshipType: form.relationshipType, relationshipStatus: form.relationshipStatus, sourceUrl: evidence.sourceUrl, sourceNote: required(form.relationshipNote, "关系说明") } }; if (form.recordRights === "yes") payload.rightsProfile = { rightsStatus: form.rightsStatus, holderStructure: form.holderStructure, legalIssuerName: form.legalIssuerName || null, votingRightsNote: form.votingRightsNote || null, economicRightsNote: form.economicRightsNote || null, transferabilityNote: form.transferabilityNote || null, structuralRiskNote: form.structuralRiskNote || null, depositaryName: form.depositaryName || null, depositaryFeeNote: form.depositaryFeeNote || null, ...evidence }; if (form.linkedCode.trim()) payload.linkedSecurity = { code: form.linkedCode.trim(), name: required(form.linkedName, "关联证券名称"), market: required(form.linkedMarket, "关联证券市场"), currency: form.linkedCurrency || null, instrumentType: form.linkedInstrumentType, shareClass: form.linkedShareClass || null, depositaryRatio: form.linkedDepositaryRatio || null, relationship: { relationshipType: form.linkedRelationshipType, relationshipStatus: form.linkedRelationshipStatus, sourceUrl: evidence.sourceUrl, sourceNote: required(form.linkedRelationshipNote || form.relationshipNote, "关联证券关系说明") }, rightsLink: { relationshipKind: form.linkKind, relationshipStatus: form.linkedRelationshipStatus, relatedSharesPerSecurity: form.relatedSharesPerSecurity || null, conversionAvailability: form.conversionAvailability, relationshipNote: required(form.linkNote, "证券权利关系说明"), ...evidence } }; return payload; }
  if (kind === "business-model") return { ...base, primaryEarningDriver: form.primaryDriver || null, revenueRecognition: form.revenueRecognition || null, summary: required(form.summary, "业务摘要"), segments: form.segment.trim() ? [{ segmentId: `segment:${crypto.randomUUID()}`, name: form.segment.trim(), revenueDriver: form.primaryDriver || null, customerScope: null, geographicScope: null, pricingModel: form.pricing || null, costDriver: null, workingCapitalDriver: null, capitalIntensityDriver: null, sourceReferences: refs, sortOrder: 0 }] : [] };
  if (kind === "market-space") return { ...base, marketDefinition: required(form.marketDefinition, "市场定义"), tam: metric("TAM", form.tam), sam: metric("SAM", form.sam), som: metric("SOM", form.som), profitPool: metric("行业利润池", form.profitPool), topDown: metric("自上而下", form.topDown), bottomUp: metric("自下而上", form.bottomUp), transmission: metric("传导到财务", form.transmission) };
  if (kind === "governance") return { ...base, dimension: form.dimension, title: required(form.title, "标题"), statement: required(form.statement, "记录内容") };
  if (kind === "competitive-market") return { ...base, definition: required(form.definition, "竞争市场定义"), productScope: form.productScope || null, customerScope: form.customerScope || null, geographyScope: form.geographyScope || null, periodScope: null, structure: { concentration: form.structure, epistemicType: form.epistemicType, sourceReferences: refs }, advantages: asList(form.advantages).map((value) => typed("壁垒机制", value)), erosionPaths: asList(form.erosionPaths).map((value) => typed("侵蚀路径", value)), competitors: form.competitor.trim() ? [{ competitorId: `competitor:${crypto.randomUUID()}`, name: form.competitor.trim(), securityCode: null, competitorType: form.competitorType, comparabilityNote: form.structure || "可比性待补", metrics: {}, sourceReferences: refs }] : [] };
  if (kind === "thesis") return { ...base, title: required(form.title, "命题标题"), statement: required(form.statement, "命题内容"), status: "active", epistemicType: "system_judgment", invalidationCondition: required(form.trigger, "证伪条件"), reviewBy: now + 90 * 86400000, evidence: refs.length ? [{ thesisEvidenceId: `thesis-evidence:${crypto.randomUUID()}`, stance: "support", knowledgeInformationId: null, sourceUrl: form.sourceUrl, sourceTitle: form.sourceTitle || form.sourceUrl, epistemicType: form.epistemicType, statement: form.statement, applicablePeriod: null, observedAt: now, sourceReferences: refs, createdAt: now }] : [] };
  if (kind === "valuation") return { ...base, valuationType: form.method, methodRationale: required(form.rationale, "估值原型理由"), assumptions: [typed("经营假设", required(form.assumption, "经营假设"))], result: typed("估值结果", required(form.result, "估值结果")), sensitivity: [typed("敏感性", required(form.sensitivity, "敏感性"))] };
  if (kind === "risk") return { ...base, category: required(form.category, "风险分类"), scope: form.scope, title: required(form.title, "风险标题"), exposure: required(form.exposure, "风险暴露"), transmission: required(form.statement, "传导路径"), lossRange: form.lossRange || null, likelihood: form.likelihood || null, impact: form.impact || null, speed: form.speed || null, reversibility: form.reversibility || null, grossRisk: form.statement || null, verifiedMitigation: form.mitigation || null, residualRisk: form.residualRisk || null, triggerCondition: required(form.trigger, "触发条件"), reviewFrequency: form.reviewFrequency || null, status: "active" };
  if (kind === "catalyst") { const map: RecordValue = { occurred: "observed_fact", guided: "management_guidance", external_expectation: "third_party_forecast", tentative: "analysis_assumption", cancelled: "observed_fact" }; return { ...base, eventAt: now, eventType: form.eventType, title: required(form.title, "事件标题"), status: form.catalystStatus, impactedAssumption: required(form.impactedAssumption, "影响假设"), expectedEffect: form.expectedEffect || null, outcomeNote: null, epistemicType: map[form.catalystStatus] }; }
  if (kind === "snapshot") return { ...base, completionLevel: form.completionLevel, state: form.state, summary: { note: form.summary, epistemicType: "system_judgment" }, moduleStatus: {} };
  return { ...base, ownerKey: "local-user", noteType: form.noteType, content: required(form.content, "笔记内容") };
}
function required(value: string, label: string) { const result = String(value || "").trim(); if (!result) throw new Error(`${label}不能为空`); return result; }

function composerCard(kind: ComposerKind, form: RecordValue, update: (key: string, value: string) => void, saving: boolean, error: string, save: () => Promise<void>, close: () => void) { const title = kinds.find(([key]) => key === kind)?.[1] || kind; const input = (label: string, key: string, type = "text", wide = false) => h("label", { class: wide ? "wide" : "" }, [label, type === "textarea" ? h("textarea", { value: form[key], onInput: (e: Event) => update(key, (e.target as HTMLTextAreaElement).value) }) : h("input", { type, value: form[key], onInput: (e: Event) => update(key, (e.target as HTMLInputElement).value) })]); const select = (label: string, key: string, choices: Array<[string, string]>, wide = false) => h("label", { class: wide ? "wide" : "" }, [label, h("select", { value: form[key], onChange: (e: Event) => update(key, (e.target as HTMLSelectElement).value) }, choices.map(([value, name]) => h("option", { value }, name)))]);
  const source = () => [input("来源链接（来源型事实/观点/假设必须填写）", "sourceUrl", "url", true), input("来源标题 / 文档名", "sourceTitle", "text", true)]; const epistemic = () => select("认识类型", "epistemicType", [["observed_fact", "来源事实"], ["management_guidance", "管理层指引"], ["source_viewpoint", "来源观点"], ["third_party_forecast", "第三方预测"], ["analysis_assumption", "自建假设"], ["system_judgment", "系统判断"]]);
  let fields: any[] = [];
  if (kind === "identity") fields = [input("经营公司ID（稳定内部标识）", "companyId"), input("经营公司法定名称", "canonicalName"), input("报告币种", "reportingCurrency"), input("财年截止日（MM-DD）", "fiscalYearEnd"), select("当前证券类型", "securityInstrumentType", [["stock", "普通/上市股票"], ["adr", "ADR / ADS"], ["depositary_receipt", "其他存托凭证"]]), input("当前股份类别", "shareClass"), input("每本证券对应基础证券数（仅 ADR）", "depositaryRatio", "number"), select("证券关系", "relationshipType", [["primary_listing", "主要上市"], ["secondary_listing", "第二上市"], ["depositary_receipt", "存托凭证"], ["other_equity_claim", "其他权益" ]]), select("映射状态", "relationshipStatus", [["confirmed", "已确认"], ["provisional", "暂定"], ["needs_review", "待复核"], ["conflicting", "冲突"]]), input("关系说明", "relationshipNote", "textarea", true), input("法定/交易所来源链接", "sourceUrl", "url", true), input("来源标题 / 文件名", "sourceTitle", "text", true), select("记录当前证券权利", "recordRights", [["no", "仅映射"], ["yes", "记录权利档案"]]), select("权利状态", "rightsStatus", [["confirmed", "已确认"], ["provisional", "暂定"], ["needs_review", "待复核"], ["conflicting", "冲突"]]), select("持有人结构", "holderStructure", [["direct_registered_holder", "直接登记持有人"], ["beneficial_holder", "受益持有人"], ["depositary_receipt_holder", "存托凭证持有人"], ["other", "其他"]]), input("法定发行人名称", "legalIssuerName"), input("投票权说明", "votingRightsNote", "textarea", true), input("经济权益说明", "economicRightsNote", "textarea", true), input("可转换/转让限制", "transferabilityNote", "textarea", true), input("结构性风险（VIE/存托等）", "structuralRiskNote", "textarea", true), input("存托机构（如适用）", "depositaryName"), input("存托费用说明（如适用）", "depositaryFeeNote", "textarea", true), select("权利证据类型", "evidenceKind", [["official_exchange_disclosure", "交易所正式披露"], ["securities_regulator_filing", "监管备案"], ["depositary_agreement", "存托协议"], ["issuer_official_disclosure", "发行人正式披露"]]), input("权利证据标题（权利或关联证券时必填）", "rightsSourceTitle", "text", true), input("权利证据摘要（权利或关联证券时必填）", "rightsSourceNote", "textarea", true), input("关联证券代码（留空则不建立关系）", "linkedCode"), input("关联证券名称", "linkedName"), input("关联证券市场（如 hk / cn-sh / us）", "linkedMarket"), input("关联证券交易币种", "linkedCurrency"), select("关联证券类型", "linkedInstrumentType", [["stock", "普通/上市股票"], ["adr", "ADR / ADS"], ["depositary_receipt", "其他存托凭证"]]), input("关联证券股份类别", "linkedShareClass"), input("关联证券 ADR 比例（如适用）", "linkedDepositaryRatio", "number"), select("关联证券与经营公司关系", "linkedRelationshipType", [["primary_listing", "主要上市"], ["secondary_listing", "第二上市"], ["depositary_receipt", "存托凭证"], ["other_equity_claim", "其他权益"]]), select("关联证券映射状态", "linkedRelationshipStatus", [["confirmed", "已确认"], ["provisional", "暂定"], ["needs_review", "待复核"], ["conflicting", "冲突"]]), input("关联证券关系说明", "linkedRelationshipNote", "textarea", true), select("证券权利关系", "linkKind", [["same_operating_company_different_security", "同经营公司不同证券"], ["adr_underlying_security", "ADR 对基础证券"], ["other_security_right", "其他证券权利"]]), input("1 当前证券对应的关联证券权益数（ADR 必填）", "relatedSharesPerSecurity", "number"), select("可转换性", "conversionAvailability", [["available", "可转换"], ["restricted", "受限"], ["not_available", "不可转换"], ["unknown", "未知"], ["not_applicable", "不适用"]]), input("证券权利关系说明", "linkNote", "textarea", true)];
  if (kind === "business-model") fields = [input("业务摘要", "summary", "textarea", true), input("主要盈利驱动", "primaryDriver"), input("收入确认方式", "revenueRecognition"), input("重要分部（可选）", "segment"), input("分部定价方式（可选）", "pricing"), epistemic(), ...source()];
  if (kind === "market-space") fields = [input("市场定义", "marketDefinition", "textarea", true), input("TAM（数值、单位、年份、计算链）", "tam"), input("SAM（数值、单位、年份、计算链）", "sam"), input("SOM（数值、单位、年份、计算链）", "som"), input("行业利润池", "profitPool"), input("自上而下测算", "topDown"), input("自下而上测算", "bottomUp"), input("传导到收入/利润/现金流", "transmission", "textarea", true), epistemic(), ...source()];
  if (kind === "governance") fields = [select("维度", "dimension", [["management_capability", "管理层能力"], ["guidance_credibility", "指引可信度"], ["governance", "治理结构"], ["alignment", "利益一致性"], ["capital_allocation", "资本配置"]]), input("标题", "title"), input("记录内容", "statement", "textarea", true), epistemic(), ...source()];
  if (kind === "competitive-market") fields = [input("竞争市场定义", "definition", "textarea", true), input("产品边界", "productScope"), input("客户边界", "customerScope"), input("地区边界", "geographyScope"), input("市场结构 / CR3/CR5", "structure"), input("壁垒机制（每行一项）", "advantages", "textarea", true), input("侵蚀路径（每行一项）", "erosionPaths", "textarea", true), input("主要竞争者（可选）", "competitor"), select("竞争者类型", "competitorType", [["direct", "直接竞争"], ["adjacent", "相邻"], ["substitute", "替代"], ["new_entrant", "潜在进入"], ["customer_inhouse", "客户自研"], ["supplier_forward", "供应商前向整合"]]), epistemic(), ...source()];
  if (kind === "thesis") fields = [input("命题标题", "title"), input("命题陈述", "statement", "textarea", true), input("证伪条件", "trigger", "textarea", true), select("证据认识类型", "epistemicType", [["observed_fact", "来源事实"], ["management_guidance", "管理层指引"], ["source_viewpoint", "来源观点"], ["third_party_forecast", "第三方预测"]]), ...source()];
  if (kind === "valuation") fields = [select("估值原型", "method", [["dcf", "DCF"], ["relative", "相对估值"], ["asset", "资产价值"], ["dividend", "股利折现"], ["sum_of_parts", "分部加总"], ["reverse", "反向估值"], ["other", "其他"]]), input("选择理由", "rationale", "textarea", true), input("经营假设", "assumption", "textarea", true), input("估值结果（含企业价值/股权价值/每股价值口径）", "result", "textarea", true), input("敏感性", "sensitivity", "textarea", true), select("假设认识类型", "epistemicType", [["analysis_assumption", "自建假设"], ["observed_fact", "来源事实"], ["third_party_forecast", "第三方预测"]]), ...source()];
  if (kind === "risk") fields = [input("风险分类", "category"), select("作用域", "scope", [["operating_company", "经营公司"], ["listed_security", "具体证券"]]), input("风险标题", "title"), input("风险暴露", "exposure", "textarea", true), input("传导路径 / 毛风险", "statement", "textarea", true), input("损失范围", "lossRange"), input("可能性", "likelihood"), input("影响", "impact"), input("速度", "speed"), input("可逆性", "reversibility"), input("已验证缓释", "mitigation"), input("剩余风险", "residualRisk"), input("预警 / 证伪触发条件", "trigger", "textarea", true), input("复核频率", "reviewFrequency"), ...source()];
  if (kind === "catalyst") fields = [select("事件状态", "catalystStatus", [["occurred", "已发生"], ["guided", "公司指引"], ["external_expectation", "外部预期"], ["tentative", "研究假设"], ["cancelled", "取消"]]), input("事件类型", "eventType"), input("事件标题", "title"), input("影响的经营假设", "impactedAssumption", "textarea", true), input("预期影响 / 结果", "expectedEffect", "textarea", true), ...source()];
  if (kind === "snapshot") fields = [select("研究层级", "completionLevel", [["basic", "基础"], ["standard", "标准"], ["deep", "深度"]]), input("工作流状态", "state"), input("当时摘要", "summary", "textarea", true)];
  if (kind === "user-note") fields = [select("个人记录类型", "noteType", [["watch_reason", "关注原因"], ["personal_view", "个人判断"], ["question", "待验证问题"], ["decision_reference", "交易计划引用"]]), input("个人内容", "content", "textarea", true), input("可选引用链接", "sourceUrl", "url", true), input("引用标题", "sourceTitle", "text", true)];
  return h("section", { class: "research-card composer mt-3" }, [h("div", { class: "section-head" }, [h("div", [h("h2", `新增：${title}`), h("p", { class: "research-meta mb-0" }, "保存为新的带日期记录，不覆盖历史版本。来源型记录必须给出可追溯证据。")]), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: close }, "取消")]), h("div", { class: "composer-grid mt-3" }, fields), error ? h("div", { class: "alert alert-danger py-2 mt-3 mb-0" }, error) : null, h("div", { class: "mt-3" }, h("button", { class: "btn btn-success", disabled: saving, onClick: () => void save() }, saving ? "保存中…" : "保存版本化研究记录"))]);
}

const root = document.getElementById("company-research-vue-root"); if (root) createApp(App).mount(root);
