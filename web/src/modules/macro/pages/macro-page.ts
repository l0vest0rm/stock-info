import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import { createMacroValueFormatter, formatMacroValue } from "./macro-value-format";

type Region = { code: string; name: string; sort: number };
type Category = { id: number; code: string; name: string; sort: number };
type Metric = { id: number; categoryId: number; code: string; name: string; description: string; sort: number };
type MeasureDefinition = { method: string; basePeriods: number; displayFormat: string };
type Definition = {
  id: number; metricId: number; categoryId: number; regionCode: string; definitionId: number;
  region: Region; category: Category; metric: Metric;
  name: string; statisticalDefinition: string; frequency: string; unit: string; unitFormat: string;
  measurementKind: string; seasonalAdjustment: string | null; leadLag: string | null;
  measures: { yoy: MeasureDefinition; mom: MeasureDefinition };
  defaultTrendPeriods: number;
  source: { id: string; seriesId: string | null; url: string | null; publisher: string | null } | null;
};
type RawPoint = { value: number; period: string; publishedAt: string };
type DerivedPoint = { value: number | null; basePeriod: string | null; basePublishedAt: string | null; method: string; status: "available" | "unavailable"; reason: string | null };
type OverviewEntry = {
  definition: Definition; current: RawPoint | null; yoy: DerivedPoint; mom: DerivedPoint;
  freshness: { status: "fresh" | "stale" | "missing"; ageSeconds: number | null; staleAfterSeconds: number };
  availability: { status: "available" | "unmapped" | "awaiting_first_release" | "awaiting_data"; reason: string | null };
  trend: { status: "available" | "unavailable"; reason: string | null; defaultPeriods: number; points: RawPoint[] };
};
type Catalog = {
  generatedAt: string; regions: Region[]; categories: Category[]; metrics: Metric[]; series: Definition[];
  capabilities: { frequencies: string[]; measurementKinds: string[]; yoyMethods: string[]; momMethods: string[] };
};
type Overview = { generatedAt: string; asOf: string; regions: string[]; categories: string[]; series: OverviewEntry[] };
type SeriesPoint = Omit<RawPoint, "value"> & DerivedPoint & { derived: { yoy: DerivedPoint; mom: DerivedPoint } };
type Comparison = { status: "not_requested" | "single_series" | "comparable" | "not_comparable"; comparedIndicatorIds: number[]; reasons: string[] };
type SeriesResponse = { generatedAt: string; asOf: string; series: Array<{ definition: Definition; measure: string; points: SeriesPoint[] }>; comparison: Comparison };
type Detail = { entry: OverviewEntry; from: string; to: string };
type ApiEnvelope<T> = { code: number; msg: string; data: T };
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type MacroTask = { name?: string; status?: "queued" | "leased" | "running" | "interrupt_requested" | "succeeded" | "failed" | "interrupted" | "superseded"; errorMessage?: string | null; createdAt?: number; completedAt?: number | null };
type MacroRecovery = { phase?: "none" | "recovering" | "manual_required"; reason?: string | null };
type MacroReport = { markdown?: string; projectedAt?: number | null };
type MacroAnalysis = { availability?: "available" | "empty" | "pending" | "failed"; task?: MacroTask | null; recovery?: MacroRecovery | null; report?: MacroReport | null; resume?: { available?: boolean } | null };

echarts.use([AriaComponent, CanvasRenderer, GridComponent, LineChart, TooltipComponent]);

const style = `
.macro-page{background:#f4f6f8;color:#172b2a;min-height:calc(100vh - 8rem);padding:1.25rem}.macro-shell{max-width:1360px;margin:auto}.macro-hero{background:linear-gradient(120deg,#073c3a,#12675d);border-radius:18px;color:#fff;padding:2rem}.macro-eyebrow{font-size:.75rem;letter-spacing:.15em;opacity:.78}.macro-hero h1{font-size:clamp(1.75rem,4vw,2.7rem);margin:.35rem 0 .6rem}.macro-hero p{max-width:780px;margin:0;opacity:.9}.macro-updated{font-size:.78rem;opacity:.8;margin-top:.75rem}.macro-controls,.macro-category,.macro-compare{background:#fff;border:1px solid #e2e8ed;border-radius:14px;margin-top:1.25rem}.macro-controls{padding:1rem 1.15rem}.macro-control-title{font-size:.8rem;font-weight:700;color:#53616b;margin:0 0 .45rem}.macro-region-list{display:flex;flex-wrap:wrap;gap:.45rem}.macro-region-choice{align-items:center;border:1px solid #d9e3e7;border-radius:999px;cursor:pointer;display:inline-flex;gap:.4rem;padding:.36rem .7rem}.macro-region-choice:has(input:checked){background:#e8f4f1;border-color:#4e958b}.macro-filter-row{align-items:end;display:flex;flex-wrap:wrap;gap:.8rem;margin-top:1rem}.macro-filter-row label{color:#53616b;display:grid;font-size:.8rem;font-weight:650;gap:.35rem;min-width:180px}.macro-filter-row input,.macro-filter-row select{background:#fff;border:1px solid #cad6db;border-radius:7px;color:#172b2a;font:inherit;font-size:.9rem;padding:.45rem .55rem}.macro-view-switch{display:flex;gap:.4rem}.macro-view-switch button{background:#f5f8f8;border:1px solid #cbd7da;border-radius:7px;color:#31514f;font-size:.85rem;padding:.45rem .75rem}.macro-view-switch button.active{background:#12675d;border-color:#12675d;color:#fff}.macro-category{overflow:hidden}.macro-category-head{align-items:baseline;border-bottom:1px solid #e7edf0;display:flex;gap:.7rem;justify-content:space-between;padding:1rem 1.15rem}.macro-category h2{font-size:1.05rem;margin:0}.macro-category-note,.macro-meta{color:#66747d;font-size:.78rem}.macro-card-grid{display:grid;gap:.85rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));padding:1rem}.macro-card{border:1px solid #e1e9ec;border-radius:11px;display:flex;flex-direction:column;gap:.65rem;min-width:0;padding:.9rem}.macro-card-head{align-items:start;display:flex;gap:.6rem;justify-content:space-between}.macro-card-title{font-size:.95rem;font-weight:700}.macro-card-subtitle{color:#66747d;font-size:.78rem;margin-top:.15rem}.macro-current{font-size:1.25rem;font-variant-numeric:tabular-nums;font-weight:750}.macro-measure-grid{display:grid;gap:.45rem;grid-template-columns:repeat(2,minmax(0,1fr))}.macro-measure{background:#f7faf9;border-radius:7px;min-width:0;padding:.5rem}.macro-measure-label{color:#66747d;font-size:.73rem}.macro-measure-value{font-size:.9rem;font-variant-numeric:tabular-nums;font-weight:700;margin-top:.1rem}.macro-measure-reason{color:#7a5a17;font-size:.72rem;line-height:1.3;margin-top:.15rem}.macro-status{border-radius:999px;display:inline-block;font-size:.72rem;font-weight:650;padding:.22rem .5rem;white-space:nowrap}.macro-status.fresh{background:#e7f5ed;color:#18704b}.macro-status.stale{background:#fff1dd;color:#8b5e00}.macro-status.missing{background:#f1f3f4;color:#64717a}.macro-status.unmapped{background:#fff0ee;color:#94351f}.macro-status.awaiting{background:#fff7df;color:#856109}.macro-trend{align-items:center;display:flex;gap:.5rem;min-height:40px}.macro-sparkline{height:38px;overflow:visible;width:128px}.macro-sparkline-line{fill:none;stroke:#12675d;stroke-width:2}.macro-detail-action{background:none;border:0;color:#0e5c58;font-size:.8rem;padding:0;text-align:left;text-decoration:underline}.macro-compare{overflow-x:auto}.macro-compare-table{border-collapse:collapse;min-width:680px;width:100%}.macro-compare-table th,.macro-compare-table td{border-bottom:1px solid #edf1f3;padding:.85rem;text-align:left;vertical-align:top}.macro-compare-table th{background:#f8fafb;color:#5b6871;font-size:.78rem;font-weight:650}.macro-compare-metric{min-width:200px}.macro-compare-cell{display:grid;gap:.6rem;min-width:220px}.macro-empty{color:#7a5a17;font-size:.85rem;font-weight:600;padding:1rem}.macro-error{background:#fff0ee;border:1px solid #f2beb5;border-radius:10px;color:#94351f;margin-top:1rem;padding:.8rem}.macro-loading{padding:2rem;text-align:center}.macro-detail-backdrop{align-items:flex-start;background:rgba(17,37,38,.45);display:flex;inset:0;justify-content:center;overflow:auto;padding:4vh 1rem;position:fixed;z-index:1050}.macro-detail-panel{background:#fff;border-radius:15px;box-shadow:0 16px 50px rgba(0,0,0,.25);max-width:850px;padding:1.1rem;width:100%}.macro-detail-head{align-items:start;display:flex;gap:1rem;justify-content:space-between}.macro-detail-head h2{font-size:1.2rem;margin:0}.macro-detail-close{background:none;border:0;color:#36514f;font-size:1.5rem;line-height:1;padding:.1rem .3rem}.macro-detail-filters{display:flex;flex-wrap:wrap;gap:.7rem;margin:1rem 0}.macro-detail-filters label{color:#53616b;display:grid;font-size:.78rem;font-weight:650;gap:.25rem}.macro-detail-filters input,.macro-detail-filters select{border:1px solid #cad6db;border-radius:7px;padding:.4rem}.macro-chart{background:#f7faf9;border-radius:10px;min-height:220px;padding:.6rem}.macro-chart svg{display:block;height:210px;width:100%}.macro-chart-line{fill:none;stroke:#12675d;stroke-width:2.25}.macro-chart-dot{fill:#12675d}.macro-point-list{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.8rem}.macro-point{background:#f4f6f8;border-radius:6px;font-size:.76rem;padding:.35rem .5rem}.macro-detail-source{margin-top:1rem}@media(max-width:760px){.macro-page{padding:.75rem}.macro-hero{padding:1.35rem}.macro-controls{padding:.85rem}.macro-filter-row label{min-width:100%}.macro-detail-backdrop{padding:1rem .5rem}.macro-detail-panel{padding:.9rem}.macro-chart{overflow-x:auto}.macro-chart svg{min-width:420px}}
.macro-chart{min-height:280px}.macro-echarts{height:280px;width:100%}.macro-analysis{background:#fff;border:1px solid #d8e5e4;border-radius:14px;margin-top:1.25rem;overflow:hidden}.macro-analysis-head{align-items:start;background:linear-gradient(120deg,#f1faf8,#fff);display:flex;gap:1rem;justify-content:space-between;padding:1.15rem}.macro-analysis-head h2{font-size:1.1rem;margin:0}.macro-analysis-head p{color:#526a68;font-size:.85rem;line-height:1.5;margin:.35rem 0 0;max-width:720px}.macro-analysis-controls{align-items:end;display:flex;flex-wrap:wrap;gap:.5rem}.macro-analysis-controls label{color:#526a68;display:grid;font-size:.72rem;font-weight:700;gap:.2rem}.macro-analysis-controls select,.macro-analysis-controls button{border:1px solid #a9cfca;border-radius:7px;font:inherit;padding:.42rem .62rem}.macro-analysis-controls button{background:#fff;color:#0d625b;font-size:.8rem;font-weight:750}.macro-analysis-controls button.primary{background:#0d625b;color:#fff}.macro-analysis-controls button:disabled{cursor:wait;opacity:.55}.macro-analysis-status{border-radius:999px;display:inline-block;font-size:.72rem;font-weight:700;margin-left:.45rem;padding:.22rem .5rem}.macro-analysis-status.pending{background:#e5f2f0;color:#12675d}.macro-analysis-status.failed{background:#fff0ee;color:#94351f}.macro-analysis-body{border-top:1px solid #e4eceb;padding:1.15rem}.macro-analysis-message{border:1px dashed #c9dbd8;border-radius:9px;color:#526a68;font-size:.88rem;line-height:1.6;padding:.8rem}.macro-analysis-message.error{background:#fff5f3;border-color:#efc5bd;color:#94351f}.macro-analysis-meta{color:#66747d;font-size:.75rem;margin-bottom:.7rem}.macro-analysis-report{color:#233c3a;font-size:.95rem;line-height:1.8}.macro-analysis-report h1{border-top:1px solid #e0eae8;color:#0d625b;font-size:1.18rem;margin:1.8rem 0 .65rem;padding-top:1.25rem}.macro-analysis-report h1:first-child{border-top:0;margin-top:0;padding-top:0}.macro-analysis-report h2{color:#214d49;font-size:1.02rem;margin:1.2rem 0 .45rem}.macro-analysis-report h3{font-size:.95rem;margin:1rem 0 .35rem}.macro-analysis-report p{margin:.55rem 0}.macro-analysis-report a{color:#0d625b;text-decoration:underline}.macro-analysis-report table{border-collapse:collapse;display:block;max-width:100%;overflow:auto}.macro-analysis-report th,.macro-analysis-report td{border:1px solid #dce7e5;padding:.4rem .55rem;vertical-align:top}.macro-analysis-report th{background:#f4f9f8}@media(max-width:760px){.macro-chart{min-height:250px;overflow:visible}.macro-echarts{height:250px}.macro-analysis-head{display:block}.macro-analysis-controls{margin-top:.8rem}}
`;

const MacroPage = defineComponent({
  setup() {
    const catalog = ref<Catalog | null>(null);
    const overview = ref<Overview | null>(null);
    const selectedRegions = ref<string[]>([]);
    const selectedCategory = ref("");
    const search = ref("");
    const view = ref<"overview" | "compare">("overview");
    const loadingCatalog = ref(false);
    const loadingOverview = ref(false);
    const error = ref<string | null>(null);
    const detail = ref<Detail | null>(null);
    const detailSeries = ref<SeriesResponse | null>(null);
    const detailLoading = ref(false);
    const detailError = ref<string | null>(null);
    const analysis = ref<MacroAnalysis | null>(null);
    const analysisLoading = ref(false);
    const analysisBusy = ref(false);
    const analysisError = ref<string | null>(null);
    const reasoningEffort = ref<ReasoningEffort>("xhigh");

    const loadAnalysis = async () => {
      analysisLoading.value = true;
      try { analysis.value = await fetchJson<MacroAnalysis>("/api/macro/analysis"); analysisError.value = null; }
      catch (reason) { analysisError.value = errorMessage(reason); }
      finally { analysisLoading.value = false; }
    };
    const submitAnalysis = async () => {
      analysisBusy.value = true; analysisError.value = null;
      try {
        await fetchJson("/api/macro/analysis/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reasoningEffort: reasoningEffort.value }) });
        await loadAnalysis();
      } catch (reason) { analysisError.value = errorMessage(reason); }
      finally { analysisBusy.value = false; }
    };
    const syncAnalysis = async () => {
      analysisBusy.value = true; analysisError.value = null;
      try { analysis.value = await fetchJson<MacroAnalysis>("/api/macro/analysis/sync", { method: "POST" }); }
      catch (reason) { analysisError.value = errorMessage(reason); }
      finally { analysisBusy.value = false; }
    };
    const resumeAnalysis = async () => {
      analysisBusy.value = true; analysisError.value = null;
      try { analysis.value = await fetchJson<MacroAnalysis>("/api/macro/analysis/resume", { method: "POST" }); }
      catch (reason) { analysisError.value = errorMessage(reason); }
      finally { analysisBusy.value = false; }
    };

    const loadOverview = async () => {
      loadingOverview.value = true;
      error.value = null;
      try {
        const params = new URLSearchParams();
        if (selectedRegions.value.length) params.set("regions", selectedRegions.value.join(","));
        if (selectedCategory.value) params.set("categories", selectedCategory.value);
        overview.value = await fetchJson<Overview>(`/api/macro/overview?${params.toString()}`);
      } catch (reason) { error.value = errorMessage(reason); } finally { loadingOverview.value = false; }
    };
    const loadCatalog = async () => {
      loadingCatalog.value = true;
      error.value = null;
      try {
        const data = await fetchJson<Catalog>("/api/macro/catalog");
        catalog.value = data;
        if (!selectedRegions.value.length && data.regions.length) selectedRegions.value = [data.regions[0].code];
        await loadOverview();
      } catch (reason) { error.value = errorMessage(reason); } finally { loadingCatalog.value = false; }
    };
    const toggleRegion = (regionCode: string, checked: boolean) => {
      selectedRegions.value = checked ? [...new Set([...selectedRegions.value, regionCode])] : selectedRegions.value.filter((code) => code !== regionCode);
      if (selectedRegions.value.length < 2 && view.value === "compare") view.value = "overview";
      void loadOverview();
    };
    const changeCategory = (categoryCode: string) => { selectedCategory.value = categoryCode; void loadOverview(); };
    const loadDetailSeries = async () => {
      if (!detail.value) return;
      detailLoading.value = true;
      detailError.value = null;
      try {
        const { entry, from, to } = detail.value;
        detailSeries.value = await fetchJson<SeriesResponse>(`/api/macro/series?${new URLSearchParams({ ids: String(entry.definition.id), from, to })}`);
      } catch (reason) { detailError.value = errorMessage(reason); detailSeries.value = null; } finally { detailLoading.value = false; }
    };
    const openDetail = async (entry: OverviewEntry) => {
      const from = entry.trend.points[0]?.period ?? entry.current?.period;
      const to = entry.current?.period;
      if (!from || !to) { detailError.value = "该序列尚无可读取的统计期，无法加载趋势详情。"; return; }
      detail.value = { entry, from, to };
      await loadDetailSeries();
    };
    const updateDetail = (patch: Partial<Omit<Detail, "entry">>) => { if (detail.value) { detail.value = { ...detail.value, ...patch }; void loadDetailSeries(); } };
    const visibleEntries = () => {
      const needle = search.value.trim().toLocaleLowerCase();
      return overview.value?.series.filter((entry) => !needle || [entry.definition.name, entry.definition.metric.name, entry.definition.metric.description, entry.definition.statisticalDefinition, entry.definition.region.name].join(" ").toLocaleLowerCase().includes(needle)) ?? [];
    };
    const visibleCategories = () => {
      const ids = new Set(visibleEntries().map((entry) => entry.definition.category.id));
      return (catalog.value?.categories ?? []).filter((category) => ids.has(category.id));
    };
    const entriesForCategory = (categoryId: number) => visibleEntries().filter((entry) => entry.definition.category.id === categoryId);
    const compareRows = (categoryId: number) => {
      // A shared metric is an economic concept, not proof that two concrete
      // series are comparable. Keep each distinct statistical definition in a
      // separate row so annual WEO and domestic monthly/quarterly series can
      // never appear as one merged comparison.
      const rows = new Map<string, OverviewEntry[]>();
      for (const entry of entriesForCategory(categoryId)) {
        const definition = entry.definition;
        const key = [definition.metric.id, definition.definitionId, definition.statisticalDefinition, definition.frequency, definition.unit, definition.unitFormat].join("\u0000");
        rows.set(key, [...(rows.get(key) ?? []), entry]);
      }
      return [...rows.values()].sort((left, right) => left[0].definition.metric.sort - right[0].definition.metric.sort);
    };
    const regionsForCompare = () => (catalog.value?.regions ?? []).filter((region) => selectedRegions.value.includes(region.code));
    const entriesForRegion = (entries: OverviewEntry[], regionCode: string) => entries.filter((entry) => entry.definition.regionCode === regionCode);

    onMounted(() => { void loadCatalog(); void loadAnalysis(); });

    return () => h("main", { class: "macro-page" }, [h("style", style), h("div", { class: "macro-shell" }, [
      h("section", { class: "macro-hero" }, [h("div", { class: "macro-eyebrow" }, "DATA-DRIVEN MACRO DIRECTORY"), h("h1", "宏观指标浏览器"), h("p", "按目录元数据浏览各地区、分类和统计口径。当前值、同比、环比和趋势均保留数据期、发布时间与不可用原因。"), catalog.value ? h("div", { class: "macro-updated" }, `目录更新于 ${formatTimestamp(catalog.value.generatedAt)}`) : null]),
      h("section", { class: "macro-analysis", "data-macro-analysis": "taskd" }, [
        h("div", { class: "macro-analysis-head" }, [
          h("div", [h("h2", ["全球宏观投资分析", h("span", { class: `macro-analysis-status ${macroAnalysisStatusClass(analysis.value)}` }, macroAnalysisStatus(analysis.value))]), h("p", "手动提交 taskd 任务，按指定研究框架用 Web Search 核验中美与全球美元流动性。本地运行期会每 15 秒只读同步状态并投影已校验报告；页面不会自动提交或重放提示词。")]),
          h("div", { class: "macro-analysis-controls" }, [
            h("label", ["推理深度", h("select", { value: reasoningEffort.value, disabled: analysisBusy.value, onChange: (event: Event) => { reasoningEffort.value = (event.target as HTMLSelectElement).value as ReasoningEffort; } }, ["low", "medium", "high", "xhigh"].map((value) => h("option", { value }, value)))]),
            analysis.value?.task ? h("button", { disabled: analysisBusy.value, onClick: () => void syncAnalysis() }, analysisBusy.value ? "正在同步" : "同步 taskd 状态") : null,
            analysis.value?.resume?.available ? h("button", { disabled: analysisBusy.value, onClick: () => void resumeAnalysis() }, "找回已提交结果") : null,
            h("button", { class: "primary", disabled: analysisBusy.value || macroAnalysisPending(analysis.value), onClick: () => void submitAnalysis() }, macroAnalysisPending(analysis.value) ? "任务执行中" : analysis.value?.report?.markdown ? "重新生成分析" : "生成宏观分析"),
          ]),
        ]),
        h("div", { class: "macro-analysis-body" }, [
          analysisLoading.value ? h("div", { class: "macro-analysis-message" }, "正在读取已保存的宏观任务状态…") : null,
          analysisError.value ? h("div", { class: "macro-analysis-message error", role: "alert" }, analysisError.value) : null,
          analysis.value?.recovery?.phase === "manual_required" ? h("div", { class: "macro-analysis-message error" }, analysis.value.recovery.reason || "无法确认原会话，需人工处理。") : null,
          analysis.value?.recovery?.phase === "recovering" ? h("div", { class: "macro-analysis-message" }, analysis.value.recovery.reason || "正在只读找回已提交结果，不会重发提示词。") : null,
          analysis.value?.task?.status === "failed" && analysis.value.recovery?.phase === "none" ? h("div", { class: "macro-analysis-message error" }, analysis.value.resume?.available ? "检测到可找回的已提交任务；可只读找回原 ChatGPT 结果，不会重发提示词。" : analysis.value.task.errorMessage || "taskd 任务失败。") : null,
          macroAnalysisPending(analysis.value) ? h("div", { class: "macro-analysis-message" }, "任务已提交给 taskd。本地运行期会周期性只读同步状态与已校验报告；也可立即手动同步。") : null,
          analysis.value?.report?.markdown ? [h("div", { class: "macro-analysis-meta" }, `报告投影时间：${formatTimestamp(String(analysis.value.report.projectedAt ?? ""))}`), h("article", { class: "macro-analysis-report", innerHTML: renderMacroMarkdown(analysis.value.report.markdown) })] : !analysisLoading.value && !analysisError.value && !macroAnalysisPending(analysis.value) ? h("div", { class: "macro-analysis-message" }, "尚无已完成的全球宏观投资分析。点击“生成宏观分析”手动提交任务。") : null,
        ]),
      ]),
      error.value ? h("div", { class: "macro-error" }, [error.value, h("button", { class: "btn btn-sm btn-outline-danger ms-3", onClick: () => void loadCatalog() }, "重试")]) : null,
      loadingCatalog.value && !catalog.value ? h("div", { class: "macro-loading" }, "正在加载宏观目录…") : null,
      catalog.value ? h("section", { class: "macro-controls", "data-macro-controls": "directory" }, [
        h("p", { class: "macro-control-title" }, "国家或地区（可多选）"),
        h("div", { class: "macro-region-list" }, catalog.value.regions.map((region) => h("label", { class: "macro-region-choice", key: region.code }, [h("input", { type: "checkbox", checked: selectedRegions.value.includes(region.code), onChange: (event: Event) => toggleRegion(region.code, (event.target as HTMLInputElement).checked) }), region.name]))),
        h("div", { class: "macro-filter-row" }, [
          h("label", ["分类", h("select", { value: selectedCategory.value, onChange: (event: Event) => changeCategory((event.target as HTMLSelectElement).value) }, [h("option", { value: "" }, "全部分类"), ...catalog.value.categories.map((category) => h("option", { key: category.id, value: category.code }, category.name))])]),
          h("label", ["搜索指标", h("input", { value: search.value, placeholder: "指标、口径或地区", onInput: (event: Event) => { search.value = (event.target as HTMLInputElement).value; } })]),
          h("div", [h("p", { class: "macro-control-title" }, "展示方式"), h("div", { class: "macro-view-switch" }, [h("button", { class: view.value === "overview" ? "active" : "", onClick: () => { view.value = "overview"; } }, "概览"), h("button", { class: view.value === "compare" ? "active" : "", disabled: selectedRegions.value.length < 2, onClick: () => { view.value = "compare"; } }, "对比")])]),
        ]),
      ]) : null,
      loadingOverview.value ? h("div", { class: "macro-loading" }, "正在更新指标概览…") : null,
      !loadingOverview.value && overview.value && !visibleEntries().length ? h("div", { class: "macro-empty" }, "当前筛选没有匹配的具体序列。目录中的新地区、分类或指标在有目录数据后会自动出现。") : null,
      view.value === "overview" ? visibleCategories().map((category) => h("section", { class: "macro-category", key: category.id }, [
        h("div", { class: "macro-category-head" }, [h("h2", `${category.code} · ${category.name}`), h("span", { class: "macro-category-note" }, `${entriesForCategory(category.id).length} 个具体序列`)]),
        h("div", { class: "macro-card-grid" }, entriesForCategory(category.id).map((entry) => renderSeriesCard(entry, openDetail))),
      ])) : selectedRegions.value.length < 2 ? h("div", { class: "macro-empty" }, "选择至少两个国家或地区后可按通用指标对比。") : visibleCategories().map((category) => h("section", { class: "macro-compare", key: category.id }, [
        h("div", { class: "macro-category-head" }, [h("h2", `${category.code} · ${category.name}`), h("span", { class: "macro-category-note" }, "同一通用指标下按地区动态生成列")]),
        h("table", { class: "macro-compare-table" }, [
          h("thead", [h("tr", [h("th", "通用指标"), ...regionsForCompare().map((region) => h("th", { key: region.code }, region.name))])]),
          h("tbody", compareRows(category.id).map((row) => h("tr", { key: comparisonKey(row[0].definition) }, [
            h("td", { class: "macro-compare-metric" }, [h("strong", row[0].definition.metric.name), h("div", { class: "macro-meta" }, row[0].definition.metric.description), h("div", { class: "macro-meta" }, `可比口径：${row[0].definition.statisticalDefinition} · ${row[0].definition.frequency} · ${row[0].definition.unit}`)]),
            ...regionsForCompare().map((region) => h("td", { key: region.code }, [
              entriesForRegion(row, region.code).length
                ? h("div", { class: "macro-compare-cell" }, entriesForRegion(row, region.code).map((entry) => renderSeriesCard(entry, openDetail, true)))
                : h("span", { class: "macro-meta" }, "该地区没有此统计定义"),
            ])),
          ]))),
        ]),
      ])),
    ]), detail.value ? renderDetail(detail.value, detailSeries.value, detailLoading.value, detailError.value, updateDetail, () => { detail.value = null; detailSeries.value = null; detailError.value = null; }) : null]);
  },
});

function renderSeriesCard(entry: OverviewEntry, openDetail: (entry: OverviewEntry) => Promise<void>, compact = false) {
  const { definition, current, availability, freshness, trend } = entry;
  return h("article", { class: "macro-card", key: definition.id, "data-macro-series": String(definition.id) }, [
    h("div", { class: "macro-card-head" }, [h("div", [h("div", { class: "macro-card-title" }, compact ? definition.name : definition.metric.name), h("div", { class: "macro-card-subtitle" }, compact ? definition.statisticalDefinition : `${definition.region.name} · ${definition.name} · ${definition.statisticalDefinition}`)]), h("span", { class: `macro-status ${availability.status === "available" ? freshness.status : availability.status === "unmapped" ? "unmapped" : "awaiting"}` }, labelForAvailability(availability.status))]),
    current ? h("div", [h("div", { class: "macro-current" }, formatMacroValue(current.value, definition)), h("div", { class: "macro-meta" }, `统计期 ${current.period} · 发布于 ${formatTimestamp(current.publishedAt)}`), h("div", { class: "macro-meta" }, freshness.status === "stale" ? "数据已超过目录的新鲜度阈值" : "数据新鲜度正常")]) : h("div", { class: "macro-empty" }, availability.reason ? reasonLabel(availability.reason) : "暂无可展示的当前值"),
    h("div", { class: "macro-measure-grid" }, [renderMeasure("同比", entry.yoy, definition.measures.yoy, definition.unit), renderMeasure("环比", entry.mom, definition.measures.mom, definition.unit)]),
    trend.status === "available" ? h("div", { class: "macro-trend" }, [sparkline(trend.points), h("span", { class: "macro-meta" }, `${trend.points.length} 期趋势摘要`)]) : h("div", { class: "macro-meta" }, trend.reason ? `趋势暂不可用：${reasonLabel(trend.reason)}` : "趋势暂不可用"),
    h("button", { class: "macro-detail-action", disabled: !current, onClick: () => void openDetail(entry) }, current ? "查看趋势与数据口径" : "暂无趋势详情"),
  ]);
}

function renderMeasure(label: string, point: DerivedPoint, definition: MeasureDefinition, unit: string) {
  const value = point.value === null ? "—" : `${formatSigned(point.value, definition.displayFormat)}${measureSuffix(definition, unit)}`;
  return h("div", { class: "macro-measure" }, [h("div", { class: "macro-measure-label" }, `${label}${measureMethodLabel(point.method)}`), h("div", { class: "macro-measure-value" }, value), point.status === "available" && point.basePeriod ? h("div", { class: "macro-meta" }, `基期 ${point.basePeriod}`) : h("div", { class: "macro-measure-reason" }, reasonLabel(point.reason ?? "not_configured"))]);
}

function renderDetail(detail: Detail, response: SeriesResponse | null, loading: boolean, error: string | null, update: (patch: Partial<Omit<Detail, "entry">>) => void, close: () => void) {
  const points = response?.series[0]?.points ?? [];
  const definition = detail.entry.definition;
  const valueFormatter = createMacroValueFormatter(definition, points.flatMap((point) => point.value === null ? [] : [point.value]));
  return h("div", { class: "macro-detail-backdrop", role: "presentation", onClick: (event: MouseEvent) => { if (event.target === event.currentTarget) close(); } }, [h("section", { class: "macro-detail-panel", role: "dialog", "aria-modal": "true", "aria-label": `${definition.name} 趋势详情` }, [
    h("div", { class: "macro-detail-head" }, [h("div", [h("h2", definition.name), h("div", { class: "macro-meta" }, `${definition.region.name} · ${definition.statisticalDefinition} · ${definition.frequency} · ${definition.unit}`)]), h("button", { class: "macro-detail-close", "aria-label": "关闭详情", onClick: close }, "×")]),
    h("div", { class: "macro-detail-filters" }, [h("label", ["开始统计期", h("input", { type: "date", value: detail.from, max: detail.to, onChange: (event: Event) => update({ from: (event.target as HTMLInputElement).value }) })]), h("label", ["结束统计期", h("input", { type: "date", value: detail.to, min: detail.from, onChange: (event: Event) => update({ to: (event.target as HTMLInputElement).value }) })])]),
    loading ? h("div", { class: "macro-loading" }, "正在按所选窗口加载趋势…") : error ? h("div", { class: "macro-error" }, error) : points.length ? h("div", { class: "macro-chart" }, [
      h(MacroLineChart, { points, valueLabel: valueFormatter.format, yoyLabel: (point: DerivedPoint) => detailDerivedValueLabel(point, definition.measures.yoy, definition.unit), momLabel: (point: DerivedPoint) => detailDerivedValueLabel(point, definition.measures.mom, definition.unit), yAxisName: valueFormatter.unit }),
    ]) : h("div", { class: "macro-empty" }, "所选窗口没有可展示的数据。"),
    h("div", { class: "macro-detail-source" }, [h("div", { class: "macro-meta" }, `同比规则：${measureMethodDescription(definition.measures.yoy)}；环比规则：${measureMethodDescription(definition.measures.mom)}。`), definition.source?.url ? h("a", { href: definition.source.url, target: "_blank", rel: "noreferrer" }, `查看来源：${definition.source.publisher ?? definition.source.id}`) : h("div", { class: "macro-meta" }, "该具体序列尚未登记已验证来源；不会用镜像、抓取时刻或近似指标填充。")]),
  ])]);
}

function sparkline(points: RawPoint[]) { const coordinates = lineCoordinates(points, 128, 38, 2); return h("svg", { class: "macro-sparkline", viewBox: "0 0 128 38", role: "img", "aria-label": "趋势摘要" }, coordinates ? [h("polyline", { class: "macro-sparkline-line", points: coordinates })] : []); }

const MacroLineChart = defineComponent({
  name: "MacroLineChart",
  props: {
    points: { type: Array as PropType<SeriesPoint[]>, required: true },
    valueLabel: { type: Function as PropType<(value: number) => string>, required: true },
    yoyLabel: { type: Function as PropType<(point: DerivedPoint) => string>, required: true },
    momLabel: { type: Function as PropType<(point: DerivedPoint) => string>, required: true },
    yAxisName: { type: String, required: true },
  },
  setup(props) {
    const element = ref<HTMLElement | null>(null);
    let instance: ReturnType<typeof echarts.init> | null = null;
    const draw = () => {
      if (!element.value) return;
      instance ??= echarts.getInstanceByDom(element.value) ?? echarts.init(element.value);
      instance.setOption({
        animationDuration: 220,
        aria: { enabled: true, description: "宏观指标趋势折线图，可悬浮查看各统计期数据。" },
        grid: { left: 64, right: 24, top: 24, bottom: 52, containLabel: true },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "line" },
          formatter: (params: Array<{ dataIndex: number }>) => {
            const point = props.points[params[0]?.dataIndex];
            if (!point) return "";
            return [
              `统计期：${point.period}`,
              `数值：${point.value === null ? reasonLabel(point.reason ?? "not_configured") : props.valueLabel(point.value)}`,
              `同比：${props.yoyLabel(point.derived.yoy)}`,
              `环比：${props.momLabel(point.derived.mom)}`,
              `发布时间：${formatTimestamp(point.publishedAt)}`,
            ].join("<br/>");
          },
        },
        xAxis: {
          type: "category",
          boundaryGap: false,
          data: props.points.map((point) => point.period),
          axisLabel: { hideOverlap: true },
          axisTick: { alignWithLabel: true },
        },
        yAxis: {
          type: "value",
          name: props.yAxisName,
          nameTextStyle: { color: "#66747d", padding: [0, 0, 0, 6] },
          axisLabel: { formatter: (value: number) => props.valueLabel(value) },
          splitLine: { lineStyle: { color: "#e5edef" } },
        },
        series: [{
          type: "line",
          data: props.points.map((point) => point.value),
          connectNulls: false,
          showSymbol: true,
          symbolSize: 6,
          lineStyle: { color: "#12675d", width: 2.25 },
          itemStyle: { color: "#12675d" },
        }],
      });
    };
    const resize = () => instance?.resize();
    onMounted(() => { draw(); window.addEventListener("resize", resize); });
    watch(() => [props.points, props.valueLabel, props.yoyLabel, props.momLabel, props.yAxisName] as const, draw, { deep: true, flush: "post" });
    onBeforeUnmount(() => {
      window.removeEventListener("resize", resize);
      instance?.dispose();
      instance = null;
    });
    return () => h("div", { ref: element, class: "macro-echarts", role: "img", "aria-label": "所选趋势图" });
  },
});

function detailDerivedValueLabel(point: DerivedPoint, definition: MeasureDefinition, unit: string): string {
  return point.value === null
    ? reasonLabel(point.reason ?? "not_configured")
    : `${formatSigned(point.value, definition.displayFormat)}${measureSuffix(definition, unit)}`;
}

function macroAnalysisPending(analysis: MacroAnalysis | null): boolean { const status = analysis?.task?.status; return status === "queued" || status === "leased" || status === "running" || status === "interrupt_requested" || analysis?.recovery?.phase === "recovering"; }
function macroAnalysisStatus(analysis: MacroAnalysis | null): string { if (!analysis) return "读取中"; if (analysis.recovery?.phase === "recovering") return "正在找回"; if (analysis.recovery?.phase === "manual_required") return "需人工处理"; return ({ queued: "已排队", leased: "执行器已领取", running: "正在生成", interrupt_requested: "正在中断", succeeded: "已完成", failed: "失败", interrupted: "已中断", superseded: "已替代" } as Record<string, string>)[analysis.task?.status ?? ""] ?? (analysis.report?.markdown ? "已完成" : "尚未提交"); }
function macroAnalysisStatusClass(analysis: MacroAnalysis | null): string { return analysis?.recovery?.phase === "manual_required" || analysis?.task?.status === "failed" ? "failed" : macroAnalysisPending(analysis) ? "pending" : ""; }
function renderMacroMarkdown(markdown: string): string {
  const marked = (window as Window & { marked?: { parse?: (content: string, options?: Record<string, unknown>) => string | Promise<string> } }).marked;
  if (!marked?.parse) return `<pre>${escapeMacroHtml(markdown)}</pre>`;
  const rendered = marked.parse(markdown, { gfm: true, breaks: true });
  return typeof rendered === "string" ? rendered : `<pre>${escapeMacroHtml(markdown)}</pre>`;
}
function escapeMacroHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;"); }
function lineCoordinates(points: Array<{ value: number }>, width: number, height: number, padding: number): string | null { return plotCoordinates(points, width, height, padding).map(([x, y]) => `${x},${y}`).join(" ") || null; }
function plotCoordinates(points: Array<{ value: number }>, width: number, height: number, padding: number): Array<[number, number]> { if (!points.length) return []; const values = points.map((point) => point.value); const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1; const usableWidth = width - padding * 2; const usableHeight = height - padding * 2; return points.map((point, index) => [padding + (points.length === 1 ? usableWidth / 2 : index / (points.length - 1) * usableWidth), padding + (max - point.value) / span * usableHeight]); }
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init); const body = await response.json() as ApiEnvelope<T>; if (!response.ok || body.code !== 200) throw new Error(body.msg || `HTTP ${response.status}`); return body.data; }
function formatValue(value: number, format = "number"): string { return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: format === "integer" ? 0 : format === "percent" || format === "percentage_point" ? 2 : 3 }).format(value); }
function formatSigned(value: number, format: string): string { return `${value > 0 ? "+" : ""}${formatValue(value, format)}`; }
function formatTimestamp(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : value; }
function measureSuffix(definition: MeasureDefinition, unit: string): string { return definition.method === "percentage_point_change" ? " 个百分点" : definition.displayFormat === "percent" && unit !== "%" ? " %" : ""; }
function measureMethodLabel(method: string): string { return method === "native" ? "（原生）" : method === "percentage_point_change" ? "（百分点）" : ""; }
function measureMethodDescription(definition: MeasureDefinition): string { return definition.method === "native" ? "使用来源发布的原生测度" : definition.method === "not_applicable" ? "不适用" : `${definition.method}，基期 ${definition.basePeriods} 期`; }
function labelForAvailability(status: OverviewEntry["availability"]["status"]): string { return ({ available: "可用", unmapped: "待接入", awaiting_first_release: "等待首发", awaiting_data: "等待数据" })[status]; }
function reasonLabel(reason: string): string { return ({ unmapped: "尚无已验证来源映射", awaiting_first_release: "来源已登记，等待首次发布", awaiting_data: "当前尚无可见观测", not_applicable: "该测度不适用", not_configured: "尚未配置计算规则", base_period_missing: "缺少严格对应的基期", base_zero: "基期为零，无法计算", insufficient_history: "历史期数不足" })[reason] ?? reason; }
function comparisonKey(definition: Definition): string { return [definition.metricId, definition.definitionId, definition.statisticalDefinition, definition.frequency, definition.unit, definition.unitFormat].join("\u0000"); }
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }

createApp(MacroPage).mount("#macro-vue-root");
