import { defineComponent, h, onMounted, ref } from "vue";

type ForecastCandidate = {
  informationId: string;
  resultId: string;
  processingRunId: string;
  processingModel: string;
  processingPromptVersion: string;
  processingSchemaVersion: string;
  processingOntologyVersion: string;
  processingInputHash: string;
  entity: string;
  category: string;
  period: string | null;
  statement: string;
  resultOutcome: string;
  versionId: string;
  contentHash: string;
  docId: string;
  title: string;
  sourceName: string | null;
  publishedAt: string | null;
  sourceUrl: string | null;
  reviewStatus: string | null;
  reviewReason: string | null;
};

type SourceForecast = {
  forecastId: string;
  informationId: string;
  institution: string | null;
  sourceIdentityId: string | null;
  sourceIdentityType: "research_provider" | "republisher" | "joint_authorship" | "database_aggregation" | null;
  independenceGroupId: string | null;
  independenceGroupName: string | null;
  sourceIdentityEvidenceUrl: string | null;
  sourceIdentityEvidenceTitle: string | null;
  forecastDate: string;
  metric: string;
  fiscalYear: number;
  fiscalPeriod: string;
  rawValue: number;
  rawUnit: string;
  currency: string | null;
  accountingBasis: string;
  ownershipBasis: string;
  shareBasis: string;
  normalizedValue: number | null;
  normalizedUnit: string | null;
  normalizationStatus: string;
  normalizationNotes: string | null;
  sourceStatement: string;
  supersedesForecastId: string | null;
  title: string;
  sourceName: string | null;
  sourceUrl: string | null;
  isCurrent?: number;
};

type CalibrationForecast = {
  forecastKind: "third_party_forecast" | "management_guidance";
  forecastId: string;
  metric: string;
  fiscalPeriod: string;
  label: string;
};

type ForecastPayload = {
  code: string;
  generatedAt: number;
  subject: {
    operatingCompany: { companyId: string; canonicalName: string; identityStatus: string } | null;
    listedSecurity: { code: string; name: string; venue: string; tradingCurrency: string | null; expectedTradingCurrency?: string | null; shareClass: string | null; depositaryRatio: number | null; mappingStatus: string };
    analysisScopeStatus: string;
    blockingGaps: string[];
  };
  sourceCandidates: ForecastCandidate[];
  sourceForecasts: SourceForecast[];
  consolidation: null | {
    consolidationId: string;
    asOf: number;
    label: string;
    sourceUniverse: string;
    marketConsensus: boolean;
    ruleVersion: string;
    groups: Array<{ comparisonKey: string; metric: string; fiscalYear: number; currency: string | null; normalizedUnit: string; accountingBasis: string; ownershipBasis: string; shareBasis: string; sampleCount: number; medianValue: number; meanValue: number; minValue: number; maxValue: number; standardDeviation: number }>;
    members: Array<{ forecastId: string; membershipStatus: string; reasonCode: string; sourceIdentityId: string | null; independenceGroupId: string | null }>;
  };
  consolidationStatus: { availability: "available" | "empty" | "unavailable"; reason: string | null; priorRuleVersion: string | null };
  sourceIdentityRegistry: {
    groups: Array<{ independenceGroupId: string; canonicalName: string; status: "confirmed" | "needs_review"; createdAt: number }>;
    identities: Array<{ sourceIdentityId: string; displayName: string; identityType: "research_provider" | "republisher" | "joint_authorship" | "database_aggregation"; independenceGroupId: string; evidenceUrl: string; evidenceTitle: string; evidenceDocId: string | null; identityStatus: "confirmed" | "needs_review"; createdAt: number }>;
  };
  forecastRevisions: {
    label: "来源预测修订链";
    ruleVersion: string;
    linkedForecastCount: number;
    unlinkedForecastCount: number;
    directions: Array<{ forecastId: string; supersedesForecastId: string; institution: string | null; forecastDate: string; metric: string; fiscalYear: number; fiscalPeriod: string; currentValue: number | null; previousValue: number | null; normalizedUnit: string | null; currency: string | null; direction: string; reasonCode: string; absoluteChange: number | null; percentageChange: number | null; isCurrent: boolean }>;
    chains: Array<{ chainId: string; rootForecastId: string; leafForecastId: string; forecastIds: string[]; isCurrentLeaf: boolean; branchStatus: string }>;
    catalog: SourceForecast[];
  };
  synthesisDrafts: Array<{ draftId: string; model: string; promptVersion: string; contentMarkdown: string; sourceForecastIds: string[]; createdAt: number }>;
  scenarios: unknown[];
  calibrations: unknown[];
  managementGuidance: Array<{ forecastId: string; forecastDate: string; metric: string; fiscalYear: number; fiscalPeriod: string; sourceStatement: string; normalizedValue: number | null; normalizedUnit: string | null; currency: string | null; accountingBasis: string; ownershipBasis: string; shareBasis: string }>;
  managementGuidanceRevisions: {
    label: "管理层指引修订链";
    ruleVersion: string;
    linkedGuidanceCount: number;
    unlinkedGuidanceCount: number;
    directions: Array<{ forecastId: string; supersedesGuidanceForecastId: string; forecastDate: string; metric: string; fiscalYear: number; fiscalPeriod: string; currentValue: number | null; previousValue: number | null; normalizedUnit: string | null; currency: string | null; direction: string; reasonCode: string; absoluteChange: number | null; percentageChange: number | null }>;
    chains: Array<{ chainId: string; rootForecastId: string; leafForecastId: string; forecastIds: string[]; branchStatus: string }>;
  };
  formalActuals: Array<{
    actualId: string;
    metric: string;
    fiscalYear: number;
    fiscalPeriod: string;
    rawValue: number;
    rawUnit: string;
    currency: string | null;
    accountingBasis: string;
    ownershipBasis: string;
    shareBasis: string;
    actualStatus: string;
    revisionNumber: number;
    restatementNote: string | null;
    filedAt: string;
    sourceStatement: string;
    sourceReferences: Array<{ url: string; locator?: string | null }>;
  }>;
  formalActualCalibrations: Array<{ calibrationId: string; forecastKind: "third_party_forecast" | "management_guidance"; forecastId: string; actualId: string; metric: string; fiscalPeriod: string; comparabilityStatus: string; comparabilityReason: string | null; absoluteError: number | null; percentageError: number | null }>;
  formalActualHealth: {
    ruleVersion: string;
    calibrationAvailability: "available" | "partial" | "unavailable";
    actualCount: number;
    currentActualCount: number;
    restatedActualCount: number;
    supersededActualCount: number;
    calibrationCount: number;
    currentComparableCalibrationCount: number;
    historicalCalibrationAffectedByRestatementCount: number;
    candidateWorkflow: { pendingAutomaticEvidenceCount: number; blockedByStatutoryVerificationCount: number; needsEvidenceCount: number; rejectedCount: number; acceptedCount: number; acceptedActualMissingCount: number; newerStatutoryDocumentAvailableCount: number; sameDayStatutoryDocumentAmbiguityCount: number };
    lineageIssues: Array<{ actualId: string; relatedActualId: string | null; reason: string }>;
  };
  formalActualCandidates: Array<{ candidateId: string; verificationId: string; metric: string; forecastMetric: string | null; fiscalYear: number; fiscalPeriod: string; reportedValue: number | null; reportedUnit: string | null; currency: string | null; statutoryProvider: string; statutoryDisclosureUrl: string | null; statutoryLocator: string | null; statutoryPublishedAt: string | null; eligibility: "ready_for_review"; blockingReason: null; sourceBinding: Record<string, unknown> }>;
  formalActualCandidateReviews: Array<{ reviewId: string; candidateId: string; decision: string; reviewer: string; reason: string; actualId: string | null }>;
  modelReviewItems: Array<{ reviewItemId: string; triggerKind: string; targetKind: string; targetVersionId: string; state: string; reason: string; createdAt: number; resolutionNote: string | null }>;
  layerStatus: Record<string, string>;
  capabilities: { canReviewLocally: boolean; canGenerateSynthesisLocally: boolean; productionLlmEnabled: false };
  limitations: string[];
};

type ReviewForm = {
  reviewStatus: "included" | "excluded" | "needs_review";
  reviewReason: string;
  sourceIdentityId: string;
  forecastDate: string;
  metric: string;
  fiscalYear: string;
  rawValue: string;
  rawUnit: string;
  currency: string;
  accountingBasis: string;
  ownershipBasis: string;
  shareBasis: string;
  supersedesForecastId: string;
};
type SourceIdentityGroupForm = { canonicalName: string };
type SourceIdentityForm = { displayName: string; identityType: "research_provider" | "republisher" | "joint_authorship" | "database_aggregation"; independenceGroupId: string; evidenceUrl: string; evidenceTitle: string; evidenceDocId: string };

type ScenarioForm = { scenarioName: "downside" | "base" | "upside"; assumptions: string; outputs: string; status: "draft" | "reviewed" };
type CalibrationForm = { forecastId: string; actualId: string };
type FormalActualReviewForm = { candidateId: string; decision: "accepted" | "rejected" | "needs_evidence"; reason: string; accountingBasis: string; ownershipBasis: string; shareBasis: string };
type ManagementGuidanceForm = { guidanceDate: string; metric: string; fiscalYear: string; fiscalPeriod: string; rawValue: string; rawUnit: string; currency: string; accountingBasis: string; ownershipBasis: string; shareBasis: string; conditions: string; sourceUrl: string; sourceStatement: string; supersedesGuidanceForecastId: string };

const styles = `.forecast-workbench{margin-top:1.5rem}.forecast-hero{display:flex;align-items:start;justify-content:space-between;gap:1rem}.forecast-layer-grid,.forecast-placeholder-grid{display:grid;gap:.8rem;grid-template-columns:repeat(4,minmax(0,1fr))}.forecast-layer,.forecast-placeholder{border:1px solid #dbe7e5;border-radius:.75rem;padding:.8rem;background:#f8fafc}.forecast-layer.available{border-color:#6aa99d;background:#f0fdfa}.forecast-badge{display:inline-block;border-radius:999px;background:#e2e8f0;color:#334155;font-size:.72rem;font-weight:700;padding:.2rem .55rem}.forecast-warning{border-left:4px solid #d97706;background:#fff7ed;padding:.75rem}.forecast-form{background:#f8fafc;border:1px solid #cbd5e1;border-radius:.8rem;padding:1rem}.forecast-form-grid{display:grid;gap:.7rem;grid-template-columns:repeat(4,minmax(0,1fr))}.forecast-form label{display:block;font-size:.75rem;color:#475569}.forecast-form input,.forecast-form select{width:100%;border:1px solid #cbd5e1;border-radius:.4rem;padding:.42rem;background:#fff}.forecast-table{font-size:.8rem}.forecast-table td,.forecast-table th{vertical-align:top}.forecast-source-text{max-width:34rem;white-space:normal}.forecast-draft{white-space:pre-wrap;background:#f8fafc;border:1px solid #dbe7e5;border-radius:.75rem;padding:1rem;font-size:.85rem}.forecast-actions{display:flex;gap:.5rem;flex-wrap:wrap}.forecast-revision-upward{color:#0f766e;font-weight:700}.forecast-revision-downward{color:#b45309;font-weight:700}.forecast-revision-blocked{color:#64748b;font-weight:700}@media(max-width:900px){.forecast-layer-grid,.forecast-placeholder-grid,.forecast-form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.forecast-layer-grid,.forecast-placeholder-grid,.forecast-form-grid{grid-template-columns:1fr}.forecast-hero{display:block}}`;

const metricLabels: Record<string, string> = {
  revenue: "营业收入", revenue_growth: "收入增速", net_profit: "净利润", net_profit_growth: "净利润增速",
  gross_margin: "毛利率", eps: "每股收益", operating_cash_flow: "经营现金流",
};
const unitLabels: Record<string, string> = {
  currency: "原币", ten_thousand_currency: "万原币", million_currency: "百万原币",
  hundred_million_currency: "亿原币", billion_currency: "十亿原币", percent: "%", currency_per_share: "原币/股",
};

export const ForecastWorkbench = defineComponent({
  name: "ForecastWorkbench",
  setup() {
    const payload = ref<ForecastPayload | null>(null);
    const loading = ref(true);
    const error = ref("");
    const saving = ref(false);
    const generating = ref(false);
    const selected = ref<ForecastCandidate | null>(null);
    const form = ref<ReviewForm>(emptyForm());
    const sourceIdentityGroupOpen = ref(false);
    const sourceIdentityGroupForm = ref<SourceIdentityGroupForm>(emptySourceIdentityGroupForm());
    const sourceIdentityOpen = ref(false);
    const sourceIdentityForm = ref<SourceIdentityForm>(emptySourceIdentityForm());
    const scenarioOpen = ref(false);
    const scenarioForm = ref<ScenarioForm>(emptyScenarioForm());
    const calibrationForecast = ref<CalibrationForecast | null>(null);
    const calibrationForm = ref<CalibrationForm>(emptyCalibrationForm());
    const actualCandidate = ref<ForecastPayload["formalActualCandidates"][number] | null>(null);
    const actualCandidateForm = ref<FormalActualReviewForm>(emptyFormalActualReviewForm());
    const actualCandidateMaterialization = ref("");
    const guidanceOpen = ref(false);
    const guidanceForm = ref<ManagementGuidanceForm>(emptyManagementGuidanceForm());
    const code = new URLSearchParams(location.search).get("code")?.trim() || "";

    const load = async () => {
      if (!code) { error.value = "缺少证券代码"; loading.value = false; return; }
      loading.value = true; error.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/forecasts`);
        const body = await response.json();
        if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取预测研究失败");
        payload.value = body.data;
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { loading.value = false; }
    };

    const edit = (candidate: ForecastCandidate) => {
      selected.value = candidate;
      const fiscalYear = candidate.period?.match(/^(\d{4})/)?.[1] || "";
      const percentage = candidate.category.endsWith("_growth") || candidate.category === "gross_margin";
      form.value = {
        ...emptyForm(), metric: candidate.category, fiscalYear,
        forecastDate: candidate.publishedAt?.slice(0, 10) || "",
        rawUnit: percentage ? "percent" : candidate.category === "eps" ? "currency_per_share" : "hundred_million_currency",
        currency: payload.value?.subject.listedSecurity.tradingCurrency || "",
      };
    };

    const save = async () => {
      if (!selected.value) return;
      saving.value = true; error.value = "";
      try {
        const input = form.value;
        const body = input.reviewStatus === "included" ? {
          informationId: selected.value.informationId,
          reviewStatus: input.reviewStatus,
          sourceIdentityId: input.sourceIdentityId,
          forecastDate: input.forecastDate,
          metric: input.metric,
          fiscalYear: Number(input.fiscalYear),
          rawValue: Number(input.rawValue),
          rawUnit: input.rawUnit,
          currency: input.currency || null,
          accountingBasis: input.accountingBasis,
          ownershipBasis: input.ownershipBasis,
          shareBasis: input.shareBasis,
          supersedesForecastId: input.supersedesForecastId || null,
        } : {
          informationId: selected.value.informationId,
          reviewStatus: input.reviewStatus,
          reviewReason: input.reviewReason,
        };
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/forecast-reviews`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存审核失败");
        selected.value = null;
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };

    const generateDraft = async () => {
      generating.value = true; error.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/forecast-synthesis-drafts`, { method: "POST" });
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "生成整理草稿失败");
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { generating.value = false; }
    };
    const saveSourceIdentityGroup = async () => {
      saving.value = true; error.value = "";
      try {
        const response = await fetch("/api/research/forecast-source-independence-groups", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sourceIdentityGroupForm.value),
        });
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存独立来源组失败");
        sourceIdentityGroupOpen.value = false;
        sourceIdentityGroupForm.value = emptySourceIdentityGroupForm();
        sourceIdentityForm.value = { ...sourceIdentityForm.value, independenceGroupId: String(result.data.independenceGroupId || "") };
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    const saveSourceIdentity = async () => {
      saving.value = true; error.value = "";
      try {
        const input = sourceIdentityForm.value;
        const response = await fetch("/api/research/forecast-source-identities", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, evidenceDocId: input.evidenceDocId.trim() || null }),
        });
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存来源身份断言失败");
        sourceIdentityOpen.value = false;
        sourceIdentityForm.value = emptySourceIdentityForm();
        form.value = { ...form.value, sourceIdentityId: String(result.data.sourceIdentityId || "") };
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };

    const saveScenario = async () => {
      saving.value = true; error.value = "";
      try {
        const input = scenarioForm.value;
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/forecast-scenarios`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarioName: input.scenarioName, assumptions: lines(input.assumptions, "分析假设"), outputs: lines(input.outputs, "模型输出"), status: input.status }) });
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存情景失败");
        scenarioOpen.value = false; scenarioForm.value = emptyScenarioForm(); await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };

    const startCalibration = (forecast: { forecastId: string; metric: string; fiscalPeriod: string }, forecastKind: CalibrationForecast["forecastKind"], label: string) => {
      calibrationForecast.value = { forecastKind, forecastId: forecast.forecastId, metric: forecast.metric, fiscalPeriod: forecast.fiscalPeriod, label };
      calibrationForm.value = { forecastId: forecast.forecastId, actualId: "" };
    };
    const saveCalibration = async () => {
      saving.value = true; error.value = "";
      try {
        const input = calibrationForm.value; const forecast = calibrationForecast.value;
        if (!forecast) throw new Error("缺少待校准预测或管理层指引");
        if (!input.actualId) throw new Error("请选择已由法定候选人工确认的正式实际");
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/formal-actual-calibrations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forecastKind: forecast.forecastKind, forecastId: forecast.forecastId, actualId: input.actualId }) });
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存预测—实际校准失败");
        calibrationForecast.value = null; calibrationForm.value = emptyCalibrationForm(); await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    const refreshActualCandidates = async () => {
      saving.value = true; error.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/formal-actual-candidates/refresh`, { method: "POST" }); const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "刷新法定实际候选失败");
        const report = result.data || {};
        const blocked = Array.isArray(report.blockedByReason) && report.blockedByReason.length
          ? `；${report.blockedCount || 0} 条阻断核验留在来源健康/法定核验账本（${report.blockedByReason.map((item: { reason: string; count: number }) => `${item.reason} ×${item.count}`).join("、")}）`
          : `；${report.blockedCount || 0} 条阻断核验留在来源健康/法定核验账本`;
        actualCandidateMaterialization.value = `已扫描 ${report.scannedVerificationCount || 0} 条既有法定核验，新增可审候选 ${report.createdCount || 0}，已存在可审候选 ${report.existingCount || 0}，可人工确认 ${report.readyForReviewCount || 0}${blocked}。仅追加可审候选，不生成正式实际或改写模型。`;
        await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    const reviewActualCandidate = async () => {
      if (!actualCandidate.value) return;
      saving.value = true; error.value = "";
      try {
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/formal-actual-candidate-reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(actualCandidateForm.value) }); const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存法定实际候选审核失败"); actualCandidate.value = null; actualCandidateForm.value = emptyFormalActualReviewForm(); await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };
    const saveManagementGuidance = async () => {
      saving.value = true; error.value = "";
      try {
        const input = guidanceForm.value;
        const fiscalYear = Number(input.fiscalYear);
        if (!Number.isInteger(fiscalYear)) throw new Error("管理层指引财年必须是整数");
        if (!input.sourceUrl.trim() || !input.sourceStatement.trim() || !input.conditions.trim()) throw new Error("管理层指引须填写法定/公司来源链接、原文说明和适用条件");
        const response = await fetch(`/api/research/company/${encodeURIComponent(code)}/management-guidance-forecasts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          guidanceDate: input.guidanceDate, metric: input.metric, fiscalYear, fiscalPeriod: input.fiscalPeriod, rawValue: Number(input.rawValue), rawUnit: input.rawUnit,
          currency: input.currency || null, accountingBasis: input.accountingBasis, ownershipBasis: input.ownershipBasis, shareBasis: input.shareBasis,
          guidanceConditions: input.conditions, sourceStatement: input.sourceStatement,
          sourceReferences: [{ sourceKind: "filing", url: input.sourceUrl, title: input.sourceStatement, publishedAt: input.guidanceDate }],
          supersedesGuidanceForecastId: input.supersedesGuidanceForecastId || null,
        }) });
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.msg || "保存管理层指引失败");
        guidanceOpen.value = false; guidanceForm.value = emptyManagementGuidanceForm(); await load();
      } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
      finally { saving.value = false; }
    };

    onMounted(() => { void load(); });
    return () => h("section", { class: "research-card forecast-workbench" }, [
      h("style", styles),
      h("div", { class: "forecast-hero" }, [
        h("div", [h("div", { class: "research-meta" }, "FORECAST LEDGER · 来源预测审计链"), h("h2", { class: "mt-1" }, "未来业绩预测"),
          h("p", { class: "small mb-0" }, "来源候选、人工确认样本、确定性汇总、本地模型草稿、自建情景和实际校准分别保存。")]),
        h("span", { class: "forecast-badge" }, "非市场一致预期"),
      ]),
      loading.value ? h("p", { class: "research-meta mt-3" }, "正在读取预测账本…") : null,
      error.value ? h("div", { class: "alert alert-danger py-2 mt-3" }, error.value) : null,
      payload.value ? renderPayload(payload.value, { selected, form, saving, generating, sourceIdentityGroupOpen, sourceIdentityGroupForm, sourceIdentityOpen, sourceIdentityForm, scenarioOpen, scenarioForm, calibrationForecast, calibrationForm, actualCandidate, actualCandidateForm, actualCandidateMaterialization, guidanceOpen, guidanceForm, edit, save, generateDraft, saveSourceIdentityGroup, saveSourceIdentity, saveScenario, startCalibration, saveCalibration, refreshActualCandidates, reviewActualCandidate, saveManagementGuidance }) : null,
    ]);
  },
});

function renderPayload(data: ForecastPayload, actions: {
  selected: typeof ref<ForecastCandidate | null>; form: typeof ref<ReviewForm>; saving: typeof ref<boolean>; generating: typeof ref<boolean>;
  sourceIdentityGroupOpen: typeof ref<boolean>; sourceIdentityGroupForm: typeof ref<SourceIdentityGroupForm>; sourceIdentityOpen: typeof ref<boolean>; sourceIdentityForm: typeof ref<SourceIdentityForm>;
  scenarioOpen: typeof ref<boolean>; scenarioForm: typeof ref<ScenarioForm>; calibrationForecast: typeof ref<CalibrationForecast | null>; calibrationForm: typeof ref<CalibrationForm>; actualCandidate: typeof ref<ForecastPayload["formalActualCandidates"][number] | null>; actualCandidateForm: typeof ref<FormalActualReviewForm>; actualCandidateMaterialization: typeof ref<string>; guidanceOpen: typeof ref<boolean>; guidanceForm: typeof ref<ManagementGuidanceForm>;
  edit: (candidate: ForecastCandidate) => void; save: () => Promise<void>; generateDraft: () => Promise<void>; saveSourceIdentityGroup: () => Promise<void>; saveSourceIdentity: () => Promise<void>; saveScenario: () => Promise<void>; startCalibration: (forecast: { forecastId: string; metric: string; fiscalPeriod: string }, forecastKind: CalibrationForecast["forecastKind"], label: string) => void; saveCalibration: () => Promise<void>; refreshActualCandidates: () => Promise<void>; reviewActualCandidate: () => Promise<void>; saveManagementGuidance: () => Promise<void>;
}) {
  const identity = h("div", { class: "forecast-warning mt-3" }, [
    h("strong", data.subject.operatingCompany ? data.subject.operatingCompany.canonicalName : "经营公司待确认"),
    h("div", { class: "small" }, `${data.subject.listedSecurity.name} · ${data.subject.listedSecurity.code} · ${data.subject.listedSecurity.venue} · ${data.subject.listedSecurity.tradingCurrency || (data.subject.listedSecurity.expectedTradingCurrency ? `${data.subject.listedSecurity.expectedTradingCurrency}（市场规则）` : "币种待补")}`),
    data.subject.blockingGaps.map((gap) => h("div", { class: "research-meta mt-1" }, gap)),
  ]);
  const layerLabels: Record<string, string> = { sourceCandidates: "来源候选", standardizedSamples: "标准化样本", synthesisDraft: "整理草稿", selfBuiltScenarios: "自建情景", actualCalibration: "实际校准" };
  const layerStatusText = (key: string, status: string) => {
    if (key === "actualCalibration" && status === "partial") return "已有审计校准记录，但预测与法定实际口径不可比；未生成误差统计";
    if (key === "actualCalibration" && status === "available") return "已有至少一条同口径预测—法定实际校准记录";
    if (key === "actualCalibration") return "尚无预测—法定实际校准记录";
    return status === "available" ? "已有记录" : "待补，不自动填充";
  };
  const layers = h("div", { class: "forecast-layer-grid mt-3" }, Object.entries(layerLabels).map(([key, label]) => h("div", { class: `forecast-layer ${data.layerStatus[key]}` }, [h("strong", label), h("div", { class: "research-meta" }, layerStatusText(key, data.layerStatus[key]))])));
  const candidateRows = data.sourceCandidates.map((item) => h("tr", { key: item.informationId }, [
    h("td", [h("strong", item.entity), h("div", { class: "research-meta" }, `${metricLabels[item.category] || item.category} · ${item.period || "期间待补"}`)]),
    h("td", { class: "forecast-source-text" }, item.statement),
    h("td", [item.sourceUrl ? h("a", { href: item.sourceUrl, target: "_blank", rel: "noreferrer" }, item.title) : item.title,
      h("div", { class: "research-meta" }, `${item.sourceName || "来源待补"} · ${item.publishedAt || "日期待补"}`),
      h("div", { class: "research-meta" }, `doc ${item.docId} · version ${short(item.versionId)} · result ${short(item.resultId)} · record ${short(item.informationId)}`),
      h("div", { class: "research-meta" }, `run ${short(item.processingRunId)} · ${item.processingModel} · ${item.processingPromptVersion} · input ${short(item.processingInputHash)}`)]),
    h("td", [h("span", { class: "forecast-badge" }, item.reviewStatus || "待审核"), item.reviewReason ? h("div", { class: "research-meta" }, item.reviewReason) : null]),
    h("td", data.capabilities.canReviewLocally ? h("button", { class: "btn btn-sm btn-outline-success", onClick: () => actions.edit(item) }, "审核") : h("span", { class: "research-meta" }, "生产只读")),
  ]));
  const candidates = h("section", { class: "mt-4" }, [h("h3", { class: "h6" }, `来源预测候选（${data.sourceCandidates.length}）`),
    h("p", { class: "research-meta" }, "候选来自信息预处理的 forecast 记录；信息陈述不是可直接统计的数字。"),
    candidateRows.length ? table(["对象/指标", "来源陈述", "文档证据链", "审核", "操作"], candidateRows) : h("div", { class: "research-note" }, "尚无 forecast 信息记录；需先在本地完成来源文档预处理。")]);
  const sourceIdentities = sourceIdentitySection(data, actions);
  const form = actions.selected.value ? renderForm(actions.selected.value, actions.form.value, data.forecastRevisions.catalog, data.sourceIdentityRegistry.identities, actions.saving.value, actions.save, (key, value) => { actions.form.value = { ...actions.form.value, [key]: value }; }, () => { actions.selected.value = null; }) : null;
  const sampleRows = data.sourceForecasts.map((item) => h("tr", { key: item.forecastId }, [
    h("td", [h("strong", item.institution || "机构待补"), h("div", { class: "research-meta" }, `${item.forecastDate} · ${identityTypeLabel(item.sourceIdentityType)}`), h("div", { class: "research-meta" }, `独立来源组：${item.independenceGroupName || "未确认"}`), item.sourceIdentityEvidenceUrl ? h("a", { class: "research-meta", href: item.sourceIdentityEvidenceUrl, target: "_blank", rel: "noreferrer" }, item.sourceIdentityEvidenceTitle || "查看身份审计证据") : null]),
    h("td", `${item.fiscalYear} ${metricLabels[item.metric] || item.metric}`),
    h("td", `${item.rawValue} ${unitLabels[item.rawUnit] || item.rawUnit}${item.currency ? ` · ${item.currency}` : ""}`),
    h("td", [h("div", `${item.accountingBasis} / ${item.ownershipBasis} / ${item.shareBasis}`), h("div", { class: "research-meta" }, item.normalizationStatus === "comparable" ? `${item.normalizedValue} ${item.normalizedUnit}` : item.normalizationNotes || "待核验")]),
    h("td", [item.sourceUrl ? h("a", { href: item.sourceUrl, target: "_blank", rel: "noreferrer" }, item.title) : item.title,
      data.capabilities.canReviewLocally ? h("button", { class: "btn btn-link btn-sm d-block px-0", onClick: () => actions.startCalibration(item, "third_party_forecast", item.institution || "机构待补") }, "录入正式实际并校准") : null]),
  ]));
  const samples = h("section", { class: "mt-4" }, [h("h3", { class: "h6" }, `已确认来源预测（${data.sourceForecasts.length}）`),
    h("p", { class: "research-meta" }, "机构显示名称不是独立性证明；只有身份断言和独立来源组均已确认的样本才可能进入统计。"),
    sampleRows.length ? table(["来源身份/日期", "期间/指标", "原始值", "口径/标准化", "来源与校准"], sampleRows) : h("div", { class: "research-note" }, "没有已确认的结构化样本；未审核候选不会进入汇总。")]);
  const consolidation = renderConsolidation(data);
  const revisions = renderForecastRevisions(data.forecastRevisions);
  const drafts = h("section", { class: "mt-4" }, [h("div", { class: "d-flex justify-content-between gap-2 align-items-start" }, [
    h("div", [h("h3", { class: "h6 mb-1" }, "本地模型预测整理草稿"), h("p", { class: "research-meta mb-2" }, "草稿只整理映射、分歧和缺口，不创建预测数字。")]),
    data.capabilities.canGenerateSynthesisLocally ? h("button", { class: "btn btn-sm btn-outline-primary", disabled: actions.generating.value || !data.consolidation?.groups.length, onClick: () => void actions.generateDraft() }, actions.generating.value ? "生成中…" : "生成草稿") : h("span", { class: "research-meta" }, "生产环境禁止调用 LLM"),
  ]), data.synthesisDrafts.length ? h("div", data.synthesisDrafts.map((draft) => h("article", { class: "forecast-draft mb-2" }, [h("div", { class: "research-meta mb-2" }, `${draft.model} · ${draft.promptVersion} · ${new Date(draft.createdAt).toLocaleString("zh-CN")}`), draft.contentMarkdown]))) : h("div", { class: "research-note" }, "尚无整理草稿。")]);
  const scenarios = scenarioSection(data, actions);
  const managementGuidance = managementGuidanceSection(data, actions);
  const calibrations = calibrationSection(data, actions);
  return h("div", [identity, layers, sourceIdentities, candidates, form, samples, consolidation, revisions, drafts, scenarios, managementGuidance, calibrations,
    h("ul", { class: "research-list research-meta mt-3" }, data.limitations.map((item) => h("li", item)))]);
}

function sourceIdentitySection(data: ForecastPayload, actions: any) {
  const groups = data.sourceIdentityRegistry.groups;
  const identities = data.sourceIdentityRegistry.identities;
  const groupForm = actions.sourceIdentityGroupForm.value as SourceIdentityGroupForm;
  const identityForm = actions.sourceIdentityForm.value as SourceIdentityForm;
  const groupRows = groups.map((group) => h("li", { key: group.independenceGroupId }, [
    h("strong", group.canonicalName), h("span", { class: "research-meta" }, ` · ${group.status} · ${short(group.independenceGroupId)}`),
  ]));
  const identityRows = identities.map((item) => h("li", { key: item.sourceIdentityId }, [
    h("strong", item.displayName), h("span", { class: "research-meta" }, ` · ${identityTypeLabel(item.identityType)} · ${groupName(data, item.independenceGroupId)} · ${item.identityStatus}`),
    h("a", { class: "research-meta d-block", href: item.evidenceUrl, target: "_blank", rel: "noreferrer" }, item.evidenceTitle),
  ]));
  const groupEditor = actions.sourceIdentityGroupOpen.value ? h("div", { class: "forecast-form mt-3" }, [
    h("strong", "新建独立来源组"), h("p", { class: "research-meta" }, "仅在能说明哪些报告共享同一原始研究/模型链时建立；显示名称相同或相似不是依据。"),
    h("label", ["原始独立来源名称", h("input", { value: groupForm.canonicalName, onInput: (event: Event) => { actions.sourceIdentityGroupForm.value = { canonicalName: (event.target as HTMLInputElement).value }; } })]),
    h("div", { class: "forecast-actions mt-2" }, [h("button", { class: "btn btn-success btn-sm", disabled: actions.saving.value, onClick: () => void actions.saveSourceIdentityGroup() }, actions.saving.value ? "保存中…" : "保存来源组"), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => { actions.sourceIdentityGroupOpen.value = false; } }, "取消")]),
  ]) : null;
  const identityEditor = actions.sourceIdentityOpen.value ? h("div", { class: "forecast-form mt-3" }, [
    h("strong", "新建来源身份断言"), h("p", { class: "research-meta" }, "承载平台、转载方、联合署名和数据库镜像必须如实标注。每条断言需要 HTTPS 审计证据；未知来源不要创建为可纳入身份。"),
    h("div", { class: "forecast-form-grid mt-2" }, [
      h("label", ["显示名称", h("input", { value: identityForm.displayName, onInput: (event: Event) => { actions.sourceIdentityForm.value = { ...identityForm, displayName: (event.target as HTMLInputElement).value }; } })]),
      h("label", ["承载关系", h("select", { value: identityForm.identityType, onChange: (event: Event) => { actions.sourceIdentityForm.value = { ...identityForm, identityType: (event.target as HTMLSelectElement).value as SourceIdentityForm["identityType"] }; } }, [["research_provider", "原始研究机构"], ["republisher", "转载/承载方"], ["joint_authorship", "联合署名"], ["database_aggregation", "同源数据库/聚合"]].map(([value, label]) => h("option", { value }, label)))]),
      h("label", ["独立来源组", h("select", { value: identityForm.independenceGroupId, onChange: (event: Event) => { actions.sourceIdentityForm.value = { ...identityForm, independenceGroupId: (event.target as HTMLSelectElement).value }; } }, [h("option", { value: "" }, "选择已确认来源组"), ...groups.filter((group) => group.status === "confirmed").map((group) => h("option", { value: group.independenceGroupId }, group.canonicalName))])]),
      h("label", ["审计证据 URL", h("input", { type: "url", value: identityForm.evidenceUrl, onInput: (event: Event) => { actions.sourceIdentityForm.value = { ...identityForm, evidenceUrl: (event.target as HTMLInputElement).value }; } })]),
      h("label", ["证据标题", h("input", { value: identityForm.evidenceTitle, onInput: (event: Event) => { actions.sourceIdentityForm.value = { ...identityForm, evidenceTitle: (event.target as HTMLInputElement).value }; } })]),
      h("label", ["已导入知识文档 ID（可选）", h("input", { value: identityForm.evidenceDocId, onInput: (event: Event) => { actions.sourceIdentityForm.value = { ...identityForm, evidenceDocId: (event.target as HTMLInputElement).value }; } })]),
    ]),
    h("div", { class: "forecast-actions mt-3" }, [h("button", { class: "btn btn-success btn-sm", disabled: actions.saving.value, onClick: () => void actions.saveSourceIdentity() }, actions.saving.value ? "保存中…" : "保存身份断言"), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => { actions.sourceIdentityOpen.value = false; } }, "取消")]),
  ]) : null;
  return h("section", { class: "mt-4" }, [
    h("div", { class: "section-head" }, [h("div", [h("h3", { class: "h6 mb-1" }, "来源身份与独立性审核"), h("p", { class: "research-meta mb-0" }, "统计以经审核的原始独立来源组为单位，而不是研报页面、平台名称或机构别名。身份未知、转载、联合署名与同源数据库仍可保留为来源明细，但不自动成为独立样本。")]), data.capabilities.canReviewLocally ? h("div", { class: "forecast-actions" }, [h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => { actions.sourceIdentityGroupOpen.value = !actions.sourceIdentityGroupOpen.value; } }, "新建来源组"), h("button", { class: "btn btn-outline-success btn-sm", disabled: !groups.length, onClick: () => { actions.sourceIdentityOpen.value = !actions.sourceIdentityOpen.value; } }, "新建身份断言")]) : h("span", { class: "research-meta" }, "生产只读")]),
    groupEditor, identityEditor,
    h("div", { class: "forecast-placeholder-grid mt-3" }, [h("article", { class: "forecast-placeholder" }, [h("strong", `独立来源组 ${groups.length}`), groupRows.length ? h("ul", { class: "research-list small mt-2 mb-0" }, groupRows) : h("p", { class: "research-meta mt-2 mb-0" }, "尚无已确认独立来源组；不能纳入预测汇总。")]), h("article", { class: "forecast-placeholder" }, [h("strong", `来源身份断言 ${identities.length}`), identityRows.length ? h("ul", { class: "research-list small mt-2 mb-0" }, identityRows) : h("p", { class: "research-meta mt-2 mb-0" }, "尚无来源身份断言；来源候选只能排除或待核验。")])]),
  ]);
}

function scenarioSection(data: ForecastPayload, actions: any) {
  const form = actions.scenarioForm.value as ScenarioForm;
  const update = (key: keyof ScenarioForm, value: string) => { actions.scenarioForm.value = { ...form, [key]: value }; };
  const field = (label: string, key: keyof ScenarioForm, textarea = false) => h("label", [label, textarea ? h("textarea", { value: form[key], onInput: (event: Event) => update(key, (event.target as HTMLTextAreaElement).value) }) : h("input", { value: form[key], onInput: (event: Event) => update(key, (event.target as HTMLInputElement).value) })]);
  const saved = data.scenarios.length ? h("div", { class: "mt-2" }, data.scenarios.map((item: any) => h("article", { class: "forecast-placeholder mb-2" }, [
    h("strong", `${scenarioLabel(item.scenarioName)} · v${item.version} · ${item.status}`),
    h("div", { class: "research-meta mt-1" }, `假设 ${item.assumptions?.length || 0} 项；输出 ${item.outputs?.length || 0} 项；${new Date(item.updatedAt || item.createdAt).toLocaleString("zh-CN")}`),
    item.assumptions?.length ? h("ul", { class: "research-list small mt-2" }, item.assumptions.slice(0, 4).map((x: any) => h("li", x.value || x.label || String(x)))) : null,
  ]))) : h("div", { class: "research-note" }, "尚未建立自建情景；不会从来源预测汇总自动生成。");
  return h("section", { class: "mt-4" }, [h("div", { class: "d-flex justify-content-between gap-2" }, [h("div", [h("h3", { class: "h6 mb-1" }, "自建三情景"), h("p", { class: "research-meta mb-0" }, "悲观、基准、乐观必须由研究者独立设置经营假设与模型输出；它们不属于机构预测。")]), data.capabilities.canReviewLocally ? h("button", { class: "btn btn-outline-success btn-sm", onClick: () => { actions.scenarioOpen.value = !actions.scenarioOpen.value; } }, actions.scenarioOpen.value ? "收起" : "新增情景") : h("span", { class: "research-meta" }, "生产只读")]),
    actions.scenarioOpen.value ? h("div", { class: "forecast-form mt-3" }, [h("div", { class: "forecast-form-grid" }, [h("label", ["情景", h("select", { value: form.scenarioName, onChange: (event: Event) => update("scenarioName", (event.target as HTMLSelectElement).value) }, [["downside", "悲观"], ["base", "基准"], ["upside", "乐观"]].map(([value, label]) => h("option", { value }, label)))]), h("label", ["状态", h("select", { value: form.status, onChange: (event: Event) => update("status", (event.target as HTMLSelectElement).value) }, [["draft", "草稿"], ["reviewed", "已复核"]].map(([value, label]) => h("option", { value }, label)))]), field("经营假设（每行一项，建议含 TAM/份额/ASP/利润率）", "assumptions", true), field("模型输出（每行一项，建议含收入/利润/现金流/资产负债）", "outputs", true)]), h("p", { class: "research-meta mt-2 mb-2" }, "此处写入的是版本化自建假设；请在估值案例中再说明从经营变量到具体证券每股价值的传导。"), h("button", { class: "btn btn-success btn-sm", disabled: actions.saving.value, onClick: () => void actions.saveScenario() }, actions.saving.value ? "保存中…" : "保存独立情景版本")]) : null, saved]);
}

function managementGuidanceSection(data: ForecastPayload, actions: any) {
  const form = actions.guidanceForm.value as ManagementGuidanceForm;
  const update = (key: keyof ManagementGuidanceForm, value: string) => { actions.guidanceForm.value = { ...form, [key]: value }; };
  const field = (label: string, key: keyof ManagementGuidanceForm, type = "text") => h("label", [label, h("input", { type, value: form[key], onInput: (event: Event) => update(key, (event.target as HTMLInputElement).value) })]);
  const select = (label: string, key: keyof ManagementGuidanceForm, options: Array<[string, string]>) => h("label", [label, h("select", { value: form[key], onChange: (event: Event) => update(key, (event.target as HTMLSelectElement).value) }, options.map(([value, text]) => h("option", { value }, text)))]);
  const records = data.managementGuidance.length ? table(["日期", "期间/指标", "管理层原文与口径", "实际校准"], data.managementGuidance.map((item) => h("tr", { key: item.forecastId }, [
    h("td", item.forecastDate),
    h("td", `${item.fiscalPeriod} ${metricLabels[item.metric] || item.metric}`),
    h("td", [item.sourceStatement, h("div", { class: "research-meta" }, `${item.normalizedValue ?? "—"} ${item.normalizedUnit || ""}${item.currency ? ` · ${item.currency}` : ""} · ${item.accountingBasis}/${item.ownershipBasis}/${item.shareBasis}`), h("div", { class: "research-meta" }, `记录 ${short(item.forecastId)}`)]),
    h("td", { "data-management-guidance-calibration": item.forecastId }, data.capabilities.canReviewLocally
      ? h("button", { class: "btn btn-link btn-sm px-0", onClick: () => actions.startCalibration(item, "management_guidance", "管理层指引") }, "选择正式实际校准")
      : h("span", { class: "research-meta" }, "生产只读")),
  ]))) : h("div", { class: "research-note" }, "尚无来源绑定的管理层指引。它与券商/第三方预测分开存储，不进入有限样本汇总。 ");
  const revisions = renderManagementGuidanceRevisions(data.managementGuidanceRevisions);
  return h("section", { class: "mt-4" }, [h("div", { class: "d-flex justify-content-between gap-2 align-items-start" }, [h("div", [h("h3", { class: "h6 mb-1" }, "管理层指引（独立来源层）"), h("p", { class: "research-meta mb-0" }, "只录入公司明确披露的指引及其适用条件；不将管理层话术改写成系统预测。")]), data.capabilities.canReviewLocally ? h("button", { class: "btn btn-outline-primary btn-sm", onClick: () => { actions.guidanceOpen.value = !actions.guidanceOpen.value; } }, actions.guidanceOpen.value ? "收起" : "新增管理层指引") : h("span", { class: "research-meta" }, "生产只读")]),
    actions.guidanceOpen.value ? h("div", { class: "forecast-form mt-3" }, [h("div", { class: "forecast-form-grid" }, [field("指引发布日期", "guidanceDate", "date"), select("指标", "metric", Object.entries(metricLabels).map(([value, text]) => [value, text])), field("财年", "fiscalYear", "number"), field("会计期间（如 2026FY）", "fiscalPeriod"), field("原始数值", "rawValue", "number"), select("原始单位", "rawUnit", Object.entries(unitLabels).map(([value, text]) => [value, text])), field("币种", "currency"), select("会计口径", "accountingBasis", [["gaap", "GAAP/法定"], ["non_gaap", "non-GAAP"], ["adjusted", "调整后"], ["unspecified", "未说明"]]), select("利润归属", "ownershipBasis", [["attributable_to_parent", "归母"], ["consolidated", "合并"], ["common_shareholders", "普通股股东"], ["unspecified", "未说明"]]), select("每股口径", "shareBasis", [["basic", "基本"], ["diluted", "稀释"], ["unspecified", "不适用/未说明"]]), field("法定/公司披露 URL", "sourceUrl"), field("替代的旧指引 ID（可选）", "supersedesGuidanceForecastId")]),
      h("label", { class: "d-block mt-2 small" }, ["适用条件/边界", h("textarea", { class: "form-control mt-1", value: form.conditions, onInput: (event: Event) => update("conditions", (event.target as HTMLTextAreaElement).value) })]), h("label", { class: "d-block mt-2 small" }, ["披露原文说明", h("textarea", { class: "form-control mt-1", value: form.sourceStatement, onInput: (event: Event) => update("sourceStatement", (event.target as HTMLTextAreaElement).value) })]),
      h("div", { class: "forecast-actions mt-3" }, [h("button", { class: "btn btn-success btn-sm", disabled: actions.saving.value, onClick: () => void actions.saveManagementGuidance() }, actions.saving.value ? "保存中…" : "保存来源绑定管理层指引"), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => { actions.guidanceOpen.value = false; } }, "取消")])]) : null,
    h("div", { class: "mt-3" }, records), revisions]);
}

function renderManagementGuidanceRevisions(revisions: ForecastPayload["managementGuidanceRevisions"]) {
  const directionLabel: Record<string, string> = {
    upward: "数值上修", downward: "数值下修", unchanged: "数值不变",
    not_comparable: "口径变化，不能比较", needs_review: "标准化待核验", unavailable: "前序版本不可得",
  };
  const rows = revisions.directions.map((item) => {
    const directionClass = item.direction === "upward" ? "forecast-revision-upward"
      : item.direction === "downward" ? "forecast-revision-downward" : "forecast-revision-blocked";
    const delta = item.absoluteChange === null ? "—" : `${item.absoluteChange > 0 ? "+" : ""}${number(item.absoluteChange)}${item.percentageChange === null ? "" : ` (${item.percentageChange > 0 ? "+" : ""}${(item.percentageChange * 100).toFixed(2)}%)`}`;
    return h("tr", { key: item.forecastId }, [
      h("td", item.forecastDate), h("td", `${item.fiscalPeriod} ${metricLabels[item.metric] || item.metric}`),
      h("td", `${item.previousValue ?? "—"} → ${item.currentValue ?? "—"}${item.currency ? ` ${item.currency}` : ""}`),
      h("td", { class: directionClass }, directionLabel[item.direction] || item.direction),
      h("td", [delta, h("div", { class: "research-meta" }, `${item.reasonCode} · 前序 ${short(item.supersedesGuidanceForecastId)}`)]),
    ]);
  });
  const chains = revisions.chains.length ? h("ul", { class: "research-list small mt-3 mb-0" }, revisions.chains.map((chain) => h("li", { key: chain.chainId }, `${chain.forecastIds.map(short).join(" → ")} · ${chain.branchStatus}`))) : h("p", { class: "research-meta mt-2 mb-0" }, "尚未建立显式指引替代关系；相近表述或相近数值不会被系统猜测为修订。 ");
  return h("div", { class: "mt-3" }, [
    h("h4", { class: "h6 mb-1" }, revisions.label),
    h("p", { class: "research-meta mb-2" }, "仅沿披露时明确指定的旧指引版本比较；必须同指标、期间、币种、单位和会计/归属/每股口径。修订不是系统判断或第三方预测。"),
    rows.length ? table(["发布日期", "期间/指标", "前序 → 当前", "修订方向", "变化/审计"], rows) : null,
    h("div", { class: "research-meta mt-2" }, `已关联 ${revisions.linkedGuidanceCount} 条；未建立前序关联 ${revisions.unlinkedGuidanceCount} 条；规则 ${revisions.ruleVersion}。`),
    chains,
  ]);
}

function calibrationSection(data: ForecastPayload, actions: any) {
  const selected = actions.calibrationForecast.value as CalibrationForecast | null;
  const form = actions.calibrationForm.value as CalibrationForm;
  const candidate = actions.actualCandidate.value as ForecastPayload["formalActualCandidates"][number] | null;
  const reviewForm = actions.actualCandidateForm.value as FormalActualReviewForm;
  const actualOptions = data.formalActuals.filter((actual) => !selected || (actual.metric === selected.metric && actual.fiscalPeriod === selected.fiscalPeriod));
  const records = data.formalActualCalibrations.length ? table(
    ["预测层", "预测/指引", "正式实际", "结果", "误差/阻断原因"],
    data.formalActualCalibrations.map((item) => {
      const detail = item.comparabilityStatus === "comparable"
        ? `${number(item.absoluteError || 0)}${item.percentageError === null ? "" : ` / ${(item.percentageError * 100).toFixed(2)}%`}`
        : item.comparabilityReason || "不可比";
      return h("tr", { key: item.calibrationId }, [h("td", item.forecastKind === "management_guidance" ? "管理层指引" : "第三方预测"), h("td", short(item.forecastId)), h("td", `${short(item.actualId)} · ${item.fiscalPeriod}`), h("td", item.comparabilityStatus), h("td", detail)]);
    }),
  ) : h("div", { class: "research-note" }, "尚无预测—正式实际校准。业绩预告、快报或不同币种、单位、会计/归属/每股口径不会生成误差统计。");
  const actuals = data.formalActuals.length ? h("div", { class: "mt-3" }, [
    h("h4", { class: "h6" }, "已接受法定实际（追加事实）"),
    table(["期间/指标", "原始值", "人工确认口径", "状态/版本", "法定来源"], data.formalActuals.slice(0, 12).map((item) => {
      const reference = item.sourceReferences.find((value) => value.url);
      return h("tr", { key: item.actualId }, [
        h("td", `${item.fiscalPeriod} ${metricLabels[item.metric] || item.metric}`),
        h("td", `${number(item.rawValue)} ${unitLabels[item.rawUnit] || item.rawUnit}${item.currency ? ` · ${item.currency}` : ""}`),
        h("td", `${item.accountingBasis} / ${item.ownershipBasis} / ${item.shareBasis}`),
        h("td", [
          `${item.actualStatus} v${item.revisionNumber}`,
          h("div", { class: "research-meta" }, `披露日 ${item.filedAt}${item.restatementNote ? `；${item.restatementNote}` : ""}`),
        ]),
        h("td", reference ? [
          h("a", { href: reference.url, target: "_blank", rel: "noreferrer" }, "查看法定披露"),
          reference.locator ? h("div", { class: "research-meta" }, reference.locator) : null,
        ] : h("span", { class: "research-meta" }, "来源定位待补")),
      ]);
    })),
    data.formalActuals.length > 12 ? h("p", { class: "research-meta mt-2 mb-0" }, `共 ${data.formalActuals.length} 条已接受实际；仅展示最新 12 条，历史重述仍保留在账本。`) : null,
  ]) : null;
  const orderedActualCandidates = [...data.formalActualCandidates];
  const candidateRows = orderedActualCandidates.slice(0, 32).map((item) => h("tr", { key: item.candidateId }, [
    h("td", `${item.fiscalPeriod} · ${metricLabels[item.metric] || item.metric}`),
    h("td", `${item.reportedValue ?? "—"} ${item.reportedUnit || ""} ${item.currency || ""}`),
    h("td", [item.statutoryDisclosureUrl ? h("a", { href: item.statutoryDisclosureUrl, target: "_blank", rel: "noreferrer" }, `${item.statutoryProvider} · ${item.statutoryLocator || "定位待补"}`) : `${item.statutoryProvider} · 定位待补`, h("div", { class: "research-meta" }, `核验 ${short(item.verificationId)} · ${String(item.sourceBinding.verificationRuleVersion || "规则版本待补")}`)]),
    h("td", "可人工确认"),
    h("td", data.capabilities.canReviewLocally ? h("button", { class: "btn btn-sm btn-outline-success", onClick: () => { actions.actualCandidate.value = item; actions.actualCandidateForm.value = { ...emptyFormalActualReviewForm(), candidateId: item.candidateId }; } }, "审核候选") : null),
  ]));
  const candidateTable = candidateRows.length ? h("div", [table(["期间/指标", "法定数值", "披露定位", "资格", "操作"], candidateRows), data.formalActualCandidates.length > candidateRows.length ? h("p", { class: "research-meta mt-2" }, `共 ${data.formalActualCandidates.length} 条可审候选；仅展示最新 ${candidateRows.length} 条，较早可审候选仍保留在账本。`) : null]) : h("div", { class: "research-note" }, "尚无可审候选。未核验、冲突或字典未映射项保留在法定核验与来源健康账本；先补证据再刷新候选，不会访问外部数据或自动创建正式实际。");
  const reviewEditor = candidate ? h("div", { class: "forecast-form mt-3" }, [h("strong", `审核法定实际候选：${candidate.fiscalPeriod} ${metricLabels[candidate.metric] || candidate.metric}`), h("p", { class: "research-meta" }, "数值、期间、文件 URL 和定位来自不可变候选，不能在此编辑；仅人工确认口径与采纳理由。"), h("div", { class: "forecast-form-grid mt-2" }, [
    h("label", ["决定", h("select", { value: reviewForm.decision, onChange: (event: Event) => { actions.actualCandidateForm.value = { ...reviewForm, decision: (event.target as HTMLSelectElement).value }; } }, [["accepted", "接受并生成正式实际"], ["rejected", "拒绝"], ["needs_evidence", "补充证据"]].map(([value, label]) => h("option", { value }, label)))]),
    h("label", ["会计口径", h("select", { value: reviewForm.accountingBasis, onChange: (event: Event) => { actions.actualCandidateForm.value = { ...reviewForm, accountingBasis: (event.target as HTMLSelectElement).value }; } }, [["gaap", "GAAP/法定"], ["non_gaap", "non-GAAP"], ["adjusted", "调整后"]].map(([value, label]) => h("option", { value }, label)))]),
    h("label", ["利润归属", h("select", { value: reviewForm.ownershipBasis, onChange: (event: Event) => { actions.actualCandidateForm.value = { ...reviewForm, ownershipBasis: (event.target as HTMLSelectElement).value }; } }, [["consolidated", "合并"], ["attributable_to_parent", "归母"], ["common_shareholders", "普通股股东"], ["unspecified", "不适用"]].map(([value, label]) => h("option", { value }, label)))]),
    h("label", ["每股口径", h("select", { value: reviewForm.shareBasis, onChange: (event: Event) => { actions.actualCandidateForm.value = { ...reviewForm, shareBasis: (event.target as HTMLSelectElement).value }; } }, [["unspecified", "不适用"], ["basic", "基本"], ["diluted", "稀释"]].map(([value, label]) => h("option", { value }, label)))])]),
    h("label", { class: "d-block mt-2 small" }, ["审核理由", h("textarea", { class: "form-control mt-1", value: reviewForm.reason, onInput: (event: Event) => { actions.actualCandidateForm.value = { ...reviewForm, reason: (event.target as HTMLTextAreaElement).value }; } })]),
    h("div", { class: "forecast-actions mt-3" }, [h("button", { class: "btn btn-success btn-sm", disabled: actions.saving.value, onClick: () => void actions.reviewActualCandidate() }, actions.saving.value ? "保存中…" : "保存人工审核"), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => { actions.actualCandidate.value = null; } }, "取消")])]) : null;
  const calibrationEditor = selected ? h("div", { class: "forecast-form mt-3" }, [h("strong", `校准 ${selected.label} · ${selected.fiscalPeriod} ${metricLabels[selected.metric] || selected.metric}`), h("p", { class: "research-meta" }, "只可选择已由法定候选审核生成的正式实际；系统将判断期间、币种、单位和口径可比性。管理层指引、第三方预测和自建情景绝不混为同一误差序列。"), h("label", { class: "d-block mt-2 small" }, ["正式实际", h("select", { class: "form-select mt-1", value: form.actualId, onChange: (event: Event) => { actions.calibrationForm.value = { ...form, actualId: (event.target as HTMLSelectElement).value }; } }, [h("option", { value: "" }, "选择已确认实际"), ...actualOptions.map((actual) => h("option", { value: actual.actualId }, `${actual.fiscalPeriod} ${metricLabels[actual.metric] || actual.metric} · ${actual.rawValue} ${actual.currency || ""}`))])]), h("div", { class: "forecast-actions mt-3" }, [h("button", { class: "btn btn-success btn-sm", disabled: actions.saving.value, onClick: () => void actions.saveCalibration() }, actions.saving.value ? "保存中…" : "保存校准记录"), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: () => { actions.calibrationForecast.value = null; } }, "取消")])]) : null;
  const reviewItems = data.modelReviewItems.length ? h("ul", { class: "research-list small mt-3" }, data.modelReviewItems.slice(0, 8).map((item) => h("li", `${item.state} · ${item.targetKind} ${short(item.targetVersionId)} · ${item.reason}`))) : h("p", { class: "research-meta mt-3" }, "尚无模型待复核项。新实际/校准会只创建待复核，不会自动改写已保存估值。 ");
  const health = data.formalActualHealth;
  const healthSummary = h("div", { class: "research-note mt-3", "data-formal-actual-health": health.ruleVersion }, [
    h("strong", `法定实际健康：${health.calibrationAvailability}`),
    h("div", { class: "research-meta mt-1" }, `实际 ${health.currentActualCount}/${health.actualCount} 当前；校准当前可比 ${health.currentComparableCalibrationCount}/${health.calibrationCount}；待下一自动证据同步候选 ${health.candidateWorkflow.pendingAutomaticEvidenceCount}。`),
    health.historicalCalibrationAffectedByRestatementCount ? h("div", { class: "research-meta mt-1" }, `有 ${health.historicalCalibrationAffectedByRestatementCount} 条历史可比校准已受重述影响，保留原记录但不作为当前可用校准。`) : null,
    health.candidateWorkflow.newerStatutoryDocumentAvailableCount ? h("div", { class: "research-meta mt-1" }, `${health.candidateWorkflow.newerStatutoryDocumentAvailableCount} 条候选已有更晚法定披露，旧候选不可接受为当前实际。`) : null,
    health.candidateWorkflow.sameDayStatutoryDocumentAmbiguityCount ? h("div", { class: "research-meta mt-1" }, `${health.candidateWorkflow.sameDayStatutoryDocumentAmbiguityCount} 条候选同日多文件，顺序不自动猜测。`) : null,
    health.lineageIssues.length ? h("div", { class: "research-meta mt-1" }, `重述谱系待复核：${health.lineageIssues.map((item) => item.reason).join("、")}`) : null,
  ]);
  return h("section", { class: "mt-4" }, [h("div", { class: "section-head" }, [h("div", [h("h3", { class: "h6 mb-1" }, "法定实际候选、校准与模型复核"), h("p", { class: "research-meta mb-0" }, "法定核验候选 → 人工确认 → 正式实际 → 校准 → 待复核，所有版本可追溯；不接受浏览器手填数值。")]), data.capabilities.canReviewLocally ? h("button", { class: "btn btn-outline-secondary btn-sm", disabled: actions.saving.value, onClick: () => void actions.refreshActualCandidates() }, "批量物化已有核验") : h("span", { class: "research-meta" }, "生产只读")]), healthSummary, actions.actualCandidateMaterialization.value ? h("p", { class: "research-note mt-2 mb-2" }, actions.actualCandidateMaterialization.value) : null, candidateTable, reviewEditor, calibrationEditor, h("div", { class: "mt-3" }, records), actuals, h("h4", { class: "h6 mt-4" }, "受影响模型待复核"), reviewItems]);
}

function renderConsolidation(data: ForecastPayload) {
  const snapshot = data.consolidation;
  if (!snapshot) {
    const requiresReReview = data.consolidationStatus.reason === "source_identity_re_review_required";
    return h("section", { class: "mt-4" }, [h("h3", { class: "h6" }, "已纳入样本的预测汇总"), h("div", { class: "research-note" }, requiresReReview
      ? `历史汇总使用 ${data.consolidationStatus.priorRuleVersion || "旧规则"}，未冻结来源身份和独立来源组；不能作为独立样本统计，须重新审核来源后再生成 v3 快照。`
      : "尚无不可变汇总快照。")]);
  }
  const rows = snapshot.groups.map((item) => h("tr", { key: item.comparisonKey }, [
    h("td", `${item.fiscalYear} ${metricLabels[item.metric] || item.metric}`),
    h("td", `${item.currency || "无币种"} · ${item.normalizedUnit}`),
    h("td", `${item.accountingBasis} / ${item.ownershipBasis} / ${item.shareBasis}`),
    h("td", String(item.sampleCount)), h("td", number(item.medianValue)), h("td", number(item.meanValue)),
    h("td", `${number(item.minValue)} – ${number(item.maxValue)}`), h("td", number(item.standardDeviation)),
  ]));
  return h("section", { class: "mt-4" }, [
    h("div", { class: "d-flex justify-content-between gap-2" }, [h("div", [h("h3", { class: "h6 mb-1" }, snapshot.label), h("div", { class: "research-meta" }, `快照 ${short(snapshot.consolidationId)} · ${new Date(snapshot.asOf).toLocaleString("zh-CN")} · ${snapshot.ruleVersion}`)]), h("span", { class: "forecast-badge" }, snapshot.marketConsensus ? "市场一致预期" : "有限样本，非市场一致预期")]),
    rows.length ? table(["期间/指标", "币种/单位", "可比口径", "样本数", "中位数", "均值", "区间", "离散度"], rows) : h("div", { class: "research-note mt-2" }, "当前快照没有可比组；排除原因仍保留在成员记录中。"),
    h("div", { class: "research-meta mt-2" }, `成员 ${snapshot.members.length} 条；来源宇宙 ${snapshot.sourceUniverse}。`),
    snapshot.members.length ? h("details", { class: "mt-2" }, [h("summary", { class: "research-meta" }, "查看逐项纳入/排除与来源身份审计"), h("ul", { class: "research-list small mt-2" }, snapshot.members.map((member) => h("li", { key: member.forecastId }, `${short(member.forecastId)} · ${member.membershipStatus} · ${consolidationReasonLabel(member.reasonCode)} · 身份 ${short(member.sourceIdentityId || "未确认")} · 来源组 ${short(member.independenceGroupId || "未确认")}`)))]) : null,
  ]);
}

function renderForecastRevisions(revisions: ForecastPayload["forecastRevisions"]) {
  const directionLabel: Record<string, string> = {
    upward: "数值上修", downward: "数值下修", unchanged: "数值不变",
    not_comparable: "口径变化，不能比较", needs_review: "标准化待核验", unavailable: "前序版本不可得",
  };
  const rows = revisions.directions.map((item) => {
    const directionClass = item.direction === "upward" ? "forecast-revision-upward"
      : item.direction === "downward" ? "forecast-revision-downward" : "forecast-revision-blocked";
    const delta = item.absoluteChange === null ? "—" : `${item.absoluteChange > 0 ? "+" : ""}${number(item.absoluteChange)}${item.percentageChange === null ? "" : ` (${item.percentageChange > 0 ? "+" : ""}${(item.percentageChange * 100).toFixed(2)}%)`}`;
    return h("tr", { key: item.forecastId }, [
      h("td", [h("strong", item.institution || "机构待补"), h("div", { class: "research-meta" }, `${item.forecastDate}${item.isCurrent ? " · 当前版本" : " · 历史版本"}`)]),
      h("td", `${item.fiscalPeriod} ${metricLabels[item.metric] || item.metric}`),
      h("td", `${item.previousValue ?? "—"} → ${item.currentValue ?? "—"}${item.currency ? ` ${item.currency}` : ""}`),
      h("td", { class: directionClass }, directionLabel[item.direction] || item.direction),
      h("td", [delta, h("div", { class: "research-meta" }, `${item.reasonCode} · 前序 ${short(item.supersedesForecastId)}`)]),
    ]);
  });
  const chainSummary = revisions.chains.length ? h("ul", { class: "research-list small mt-3 mb-0" }, revisions.chains.map((chain) => h("li", { key: chain.chainId }, [
    `${chain.forecastIds.length} 个不可变版本：${chain.forecastIds.map(short).join(" → ")}`,
    h("span", { class: "research-meta" }, ` · ${chain.branchStatus}${chain.isCurrentLeaf ? " · 当前链头" : ""}`),
  ]))) : h("div", { class: "research-note mt-2" }, "尚未建立显式来源预测版本关联；相同机构或相近数值不会被系统猜测为修订。 ");
  return h("section", { class: "mt-4" }, [
    h("div", { class: "d-flex justify-content-between gap-2 align-items-start" }, [h("div", [
      h("h3", { class: "h6 mb-1" }, revisions.label),
      h("p", { class: "research-meta mb-0" }, "仅比较显式替代关系中的同指标、同期间、同币种、单位和会计/归属/每股口径。数值上修或下修不是投资结论，也不代表市场一致预期。"),
    ]), h("span", { class: "forecast-badge" }, `${revisions.linkedForecastCount} 条已关联`)]),
    rows.length ? table(["机构/版本日", "期间/指标", "前序 → 当前", "修订方向", "变化/审计"], rows) : null,
    h("div", { class: "research-meta mt-2" }, `未建立前序关联的版本 ${revisions.unlinkedForecastCount} 条；规则 ${revisions.ruleVersion}。`),
    chainSummary,
  ]);
}

function renderForm(candidate: ForecastCandidate, value: ReviewForm, catalog: SourceForecast[], identities: ForecastPayload["sourceIdentityRegistry"]["identities"], saving: boolean, save: () => Promise<void>, update: (key: keyof ReviewForm, value: string) => void, close: () => void) {
  const field = (label: string, key: keyof ReviewForm, type = "text") => h("label", [label, h("input", { type, value: value[key], onInput: (event: Event) => update(key, (event.target as HTMLInputElement).value) })]);
  const select = (label: string, key: keyof ReviewForm, options: Array<[string, string]>) => h("label", [label, h("select", { value: value[key], onChange: (event: Event) => update(key, (event.target as HTMLSelectElement).value) }, options.map(([id, text]) => h("option", { value: id }, text)))]);
  const included = value.reviewStatus === "included";
  return h("section", { class: "forecast-form mt-3" }, [h("strong", `审核：${candidate.statement}`), h("div", { class: "forecast-form-grid mt-2" }, [
    select("处理结果", "reviewStatus", [["included", "纳入结构化样本"], ["excluded", "排除"], ["needs_review", "待进一步核验"]]),
    included ? h("label", ["已确认来源身份", h("select", { value: value.sourceIdentityId, onChange: (event: Event) => update("sourceIdentityId", (event.target as HTMLSelectElement).value) }, [h("option", { value: "" }, "选择已确认身份（未知来源不可纳入）"), ...identities.filter((item) => item.identityStatus === "confirmed").map((item) => h("option", { value: item.sourceIdentityId }, `${item.displayName} · ${item.identityType}`))])]) : field("原因", "reviewReason"),
    included ? field("预测日期", "forecastDate", "date") : null,
    included ? select("指标", "metric", Object.entries(metricLabels).map(([id, label]) => [id, label])) : null,
    included ? field("财年", "fiscalYear", "number") : null,
    included ? field("原始数值", "rawValue", "number") : null,
    included ? select("原始单位", "rawUnit", Object.entries(unitLabels).map(([id, label]) => [id, label])) : null,
    included ? field("币种", "currency") : null,
    included ? select("会计口径", "accountingBasis", [["gaap", "GAAP/法定"], ["non_gaap", "non-GAAP"], ["adjusted", "调整后"], ["unspecified", "未说明"]]) : null,
    included ? select("利润归属", "ownershipBasis", [["attributable_to_parent", "归母"], ["consolidated", "合并"], ["common_shareholders", "普通股股东"], ["unspecified", "未说明"]]) : null,
    included ? select("每股口径", "shareBasis", [["basic", "基本"], ["diluted", "稀释"], ["unspecified", "不适用/未说明"]]) : null,
    included ? h("label", ["替代的来源预测版本（可选）", h("select", { value: value.supersedesForecastId, onChange: (event: Event) => update("supersedesForecastId", (event.target as HTMLSelectElement).value) }, [h("option", { value: "" }, "不建立版本链"), ...catalog.filter((item) => item.forecastId !== candidate.informationId).slice(-100).map((item) => h("option", { value: item.forecastId }, `${item.forecastDate} · ${item.institution || "机构待补"} · ${item.fiscalPeriod} ${metricLabels[item.metric] || item.metric} · ${short(item.forecastId)}`))])]) : null,
  ].filter(Boolean)), h("div", { class: "forecast-actions mt-3" }, [h("button", { class: "btn btn-success btn-sm", disabled: saving, onClick: () => void save() }, saving ? "保存中…" : "保存审核并冻结汇总快照"), h("button", { class: "btn btn-outline-secondary btn-sm", onClick: close }, "取消")])]);
}

function emptyForm(): ReviewForm {
  return { reviewStatus: "included", reviewReason: "", sourceIdentityId: "", forecastDate: "", metric: "net_profit", fiscalYear: "", rawValue: "", rawUnit: "hundred_million_currency", currency: "", accountingBasis: "unspecified", ownershipBasis: "unspecified", shareBasis: "unspecified", supersedesForecastId: "" };
}
function emptySourceIdentityGroupForm(): SourceIdentityGroupForm { return { canonicalName: "" }; }
function emptySourceIdentityForm(): SourceIdentityForm { return { displayName: "", identityType: "research_provider", independenceGroupId: "", evidenceUrl: "", evidenceTitle: "", evidenceDocId: "" }; }
function groupName(data: ForecastPayload, groupId: string) { return data.sourceIdentityRegistry.groups.find((group) => group.independenceGroupId === groupId)?.canonicalName || "来源组待补"; }
function identityTypeLabel(type: SourceForecast["sourceIdentityType"]) { return ({ research_provider: "原始研究机构", republisher: "转载/承载方", joint_authorship: "联合署名", database_aggregation: "同源数据库/聚合" } as Record<string, string>)[type || ""] || "身份待确认"; }
function consolidationReasonLabel(reason: string) { return ({ included: "已纳入", source_identity_unresolved: "来源身份或独立性未确认", normalization_needs_review: "口径标准化待核验", superseded_by_latest_independence_group_forecast: "同一独立来源组已有更新版本" } as Record<string, string>)[reason] || reason; }
function emptyScenarioForm(): ScenarioForm { return { scenarioName: "base", assumptions: "", outputs: "", status: "draft" }; }
function emptyCalibrationForm(): CalibrationForm { return { forecastId: "", actualId: "" }; }
function emptyFormalActualReviewForm(): FormalActualReviewForm { return { candidateId: "", decision: "accepted", reason: "", accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified" }; }
function emptyManagementGuidanceForm(): ManagementGuidanceForm { const year = new Date().getFullYear() + 1; return { guidanceDate: new Date().toISOString().slice(0, 10), metric: "revenue", fiscalYear: String(year), fiscalPeriod: `${year}FY`, rawValue: "", rawUnit: "hundred_million_currency", currency: "", accountingBasis: "unspecified", ownershipBasis: "unspecified", shareBasis: "unspecified", conditions: "", sourceUrl: "", sourceStatement: "", supersedesGuidanceForecastId: "" }; }
function scenarioLabel(value: string) { return ({ downside: "悲观", base: "基准", upside: "乐观" } as Record<string, string>)[value] || value; }
function lines(value: string, label: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean).map((item) => ({ label, value: item, epistemicType: "analysis_assumption" })); }
function table(headers: string[], rows: ReturnType<typeof h>[]) { return h("div", { class: "table-responsive" }, h("table", { class: "table table-sm forecast-table" }, [h("thead", h("tr", headers.map((item) => h("th", item)))), h("tbody", rows)])); }
function short(value: string) { return value.length > 20 ? `${value.slice(0, 17)}…` : value; }
function number(value: number) { return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 4 }); }
