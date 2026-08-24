import { createApp, defineComponent, h, onMounted, ref } from "vue";

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
type SeriesPoint = Omit<RawPoint, "value"> & DerivedPoint;
type SeriesResponse = { generatedAt: string; asOf: string; series: Array<{ definition: Definition; measure: string; points: SeriesPoint[] }> };
type Detail = { entry: OverviewEntry; measure: "level" | "yoy" | "mom"; from: string; to: string };
type ApiEnvelope<T> = { code: number; msg: string; data: T };

const style = `
.macro-page{background:#f4f6f8;color:#172b2a;min-height:calc(100vh - 8rem);padding:1.25rem}.macro-shell{max-width:1360px;margin:auto}.macro-hero{background:linear-gradient(120deg,#073c3a,#12675d);border-radius:18px;color:#fff;padding:2rem}.macro-eyebrow{font-size:.75rem;letter-spacing:.15em;opacity:.78}.macro-hero h1{font-size:clamp(1.75rem,4vw,2.7rem);margin:.35rem 0 .6rem}.macro-hero p{max-width:780px;margin:0;opacity:.9}.macro-updated{font-size:.78rem;opacity:.8;margin-top:.75rem}.macro-controls,.macro-category,.macro-compare{background:#fff;border:1px solid #e2e8ed;border-radius:14px;margin-top:1.25rem}.macro-controls{padding:1rem 1.15rem}.macro-control-title{font-size:.8rem;font-weight:700;color:#53616b;margin:0 0 .45rem}.macro-region-list{display:flex;flex-wrap:wrap;gap:.45rem}.macro-region-choice{align-items:center;border:1px solid #d9e3e7;border-radius:999px;cursor:pointer;display:inline-flex;gap:.4rem;padding:.36rem .7rem}.macro-region-choice:has(input:checked){background:#e8f4f1;border-color:#4e958b}.macro-filter-row{align-items:end;display:flex;flex-wrap:wrap;gap:.8rem;margin-top:1rem}.macro-filter-row label{color:#53616b;display:grid;font-size:.8rem;font-weight:650;gap:.35rem;min-width:180px}.macro-filter-row input,.macro-filter-row select{background:#fff;border:1px solid #cad6db;border-radius:7px;color:#172b2a;font:inherit;font-size:.9rem;padding:.45rem .55rem}.macro-view-switch{display:flex;gap:.4rem}.macro-view-switch button{background:#f5f8f8;border:1px solid #cbd7da;border-radius:7px;color:#31514f;font-size:.85rem;padding:.45rem .75rem}.macro-view-switch button.active{background:#12675d;border-color:#12675d;color:#fff}.macro-category{overflow:hidden}.macro-category-head{align-items:baseline;border-bottom:1px solid #e7edf0;display:flex;gap:.7rem;justify-content:space-between;padding:1rem 1.15rem}.macro-category h2{font-size:1.05rem;margin:0}.macro-category-note,.macro-meta{color:#66747d;font-size:.78rem}.macro-card-grid{display:grid;gap:.85rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));padding:1rem}.macro-card{border:1px solid #e1e9ec;border-radius:11px;display:flex;flex-direction:column;gap:.65rem;min-width:0;padding:.9rem}.macro-card-head{align-items:start;display:flex;gap:.6rem;justify-content:space-between}.macro-card-title{font-size:.95rem;font-weight:700}.macro-card-subtitle{color:#66747d;font-size:.78rem;margin-top:.15rem}.macro-current{font-size:1.25rem;font-variant-numeric:tabular-nums;font-weight:750}.macro-measure-grid{display:grid;gap:.45rem;grid-template-columns:repeat(2,minmax(0,1fr))}.macro-measure{background:#f7faf9;border-radius:7px;min-width:0;padding:.5rem}.macro-measure-label{color:#66747d;font-size:.73rem}.macro-measure-value{font-size:.9rem;font-variant-numeric:tabular-nums;font-weight:700;margin-top:.1rem}.macro-measure-reason{color:#7a5a17;font-size:.72rem;line-height:1.3;margin-top:.15rem}.macro-status{border-radius:999px;display:inline-block;font-size:.72rem;font-weight:650;padding:.22rem .5rem;white-space:nowrap}.macro-status.fresh{background:#e7f5ed;color:#18704b}.macro-status.stale{background:#fff1dd;color:#8b5e00}.macro-status.missing{background:#f1f3f4;color:#64717a}.macro-status.unmapped{background:#fff0ee;color:#94351f}.macro-status.awaiting{background:#fff7df;color:#856109}.macro-trend{align-items:center;display:flex;gap:.5rem;min-height:40px}.macro-sparkline{height:38px;overflow:visible;width:128px}.macro-sparkline-line{fill:none;stroke:#12675d;stroke-width:2}.macro-detail-action{background:none;border:0;color:#0e5c58;font-size:.8rem;padding:0;text-align:left;text-decoration:underline}.macro-compare{overflow-x:auto}.macro-compare-table{border-collapse:collapse;min-width:680px;width:100%}.macro-compare-table th,.macro-compare-table td{border-bottom:1px solid #edf1f3;padding:.85rem;text-align:left;vertical-align:top}.macro-compare-table th{background:#f8fafb;color:#5b6871;font-size:.78rem;font-weight:650}.macro-compare-metric{min-width:200px}.macro-compare-cell{display:grid;gap:.6rem;min-width:220px}.macro-empty{color:#7a5a17;font-size:.85rem;font-weight:600;padding:1rem}.macro-error{background:#fff0ee;border:1px solid #f2beb5;border-radius:10px;color:#94351f;margin-top:1rem;padding:.8rem}.macro-loading{padding:2rem;text-align:center}.macro-detail-backdrop{align-items:flex-start;background:rgba(17,37,38,.45);display:flex;inset:0;justify-content:center;overflow:auto;padding:4vh 1rem;position:fixed;z-index:1050}.macro-detail-panel{background:#fff;border-radius:15px;box-shadow:0 16px 50px rgba(0,0,0,.25);max-width:850px;padding:1.1rem;width:100%}.macro-detail-head{align-items:start;display:flex;gap:1rem;justify-content:space-between}.macro-detail-head h2{font-size:1.2rem;margin:0}.macro-detail-close{background:none;border:0;color:#36514f;font-size:1.5rem;line-height:1;padding:.1rem .3rem}.macro-detail-filters{display:flex;flex-wrap:wrap;gap:.7rem;margin:1rem 0}.macro-detail-filters label{color:#53616b;display:grid;font-size:.78rem;font-weight:650;gap:.25rem}.macro-detail-filters input,.macro-detail-filters select{border:1px solid #cad6db;border-radius:7px;padding:.4rem}.macro-chart{background:#f7faf9;border-radius:10px;min-height:220px;padding:.6rem}.macro-chart svg{display:block;height:210px;width:100%}.macro-chart-line{fill:none;stroke:#12675d;stroke-width:2.25}.macro-chart-dot{fill:#12675d}.macro-point-list{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.8rem}.macro-point{background:#f4f6f8;border-radius:6px;font-size:.76rem;padding:.35rem .5rem}.macro-detail-source{margin-top:1rem}@media(max-width:760px){.macro-page{padding:.75rem}.macro-hero{padding:1.35rem}.macro-controls{padding:.85rem}.macro-filter-row label{min-width:100%}.macro-detail-backdrop{padding:1rem .5rem}.macro-detail-panel{padding:.9rem}.macro-chart{overflow-x:auto}.macro-chart svg{min-width:420px}}
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
        const { entry, measure, from, to } = detail.value;
        detailSeries.value = await fetchJson<SeriesResponse>(`/api/macro/series?${new URLSearchParams({ ids: String(entry.definition.id), measure, from, to })}`);
      } catch (reason) { detailError.value = errorMessage(reason); detailSeries.value = null; } finally { detailLoading.value = false; }
    };
    const openDetail = async (entry: OverviewEntry) => {
      const from = entry.trend.points[0]?.period ?? entry.current?.period;
      const to = entry.current?.period;
      if (!from || !to) { detailError.value = "该序列尚无可读取的统计期，无法加载趋势详情。"; return; }
      detail.value = { entry, measure: "level", from, to };
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
      const rows = new Map<number, OverviewEntry[]>();
      for (const entry of entriesForCategory(categoryId)) rows.set(entry.definition.metric.id, [...(rows.get(entry.definition.metric.id) ?? []), entry]);
      return [...rows.values()].sort((left, right) => left[0].definition.metric.sort - right[0].definition.metric.sort);
    };
    const regionsForCompare = () => (catalog.value?.regions ?? []).filter((region) => selectedRegions.value.includes(region.code));
    const entriesForRegion = (entries: OverviewEntry[], regionCode: string) => entries.filter((entry) => entry.definition.regionCode === regionCode);

    onMounted(() => { void loadCatalog(); });

    return () => h("main", { class: "macro-page" }, [h("style", style), h("div", { class: "macro-shell" }, [
      h("section", { class: "macro-hero" }, [h("div", { class: "macro-eyebrow" }, "DATA-DRIVEN MACRO DIRECTORY"), h("h1", "宏观指标浏览器"), h("p", "按目录元数据浏览各地区、分类和统计口径。当前值、同比、环比和趋势均保留数据期、发布时间与不可用原因。"), catalog.value ? h("div", { class: "macro-updated" }, `目录更新于 ${formatTimestamp(catalog.value.generatedAt)}`) : null]),
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
          h("tbody", compareRows(category.id).map((row) => h("tr", { key: row[0].definition.metric.id }, [
            h("td", { class: "macro-compare-metric" }, [h("strong", row[0].definition.metric.name), h("div", { class: "macro-meta" }, row[0].definition.metric.description)]),
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
    current ? h("div", [h("div", { class: "macro-current" }, `${formatValue(current.value, definition.unitFormat)}${unitSuffix(definition.unit)}`), h("div", { class: "macro-meta" }, `统计期 ${current.period} · 发布于 ${formatTimestamp(current.publishedAt)}`), h("div", { class: "macro-meta" }, freshness.status === "stale" ? "数据已超过目录的新鲜度阈值" : "数据新鲜度正常")]) : h("div", { class: "macro-empty" }, availability.reason ? reasonLabel(availability.reason) : "暂无可展示的当前值"),
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
  return h("div", { class: "macro-detail-backdrop", role: "presentation", onClick: (event: MouseEvent) => { if (event.target === event.currentTarget) close(); } }, [h("section", { class: "macro-detail-panel", role: "dialog", "aria-modal": "true", "aria-label": `${definition.name} 趋势详情` }, [
    h("div", { class: "macro-detail-head" }, [h("div", [h("h2", definition.name), h("div", { class: "macro-meta" }, `${definition.region.name} · ${definition.statisticalDefinition} · ${definition.frequency} · ${definition.unit}`)]), h("button", { class: "macro-detail-close", "aria-label": "关闭详情", onClick: close }, "×")]),
    h("div", { class: "macro-detail-filters" }, [h("label", ["测度", h("select", { value: detail.measure, onChange: (event: Event) => update({ measure: (event.target as HTMLSelectElement).value as Detail["measure"] }) }, [h("option", { value: "level" }, "当前值"), h("option", { value: "yoy" }, "同比"), h("option", { value: "mom" }, "环比")])]), h("label", ["开始统计期", h("input", { type: "date", value: detail.from, max: detail.to, onChange: (event: Event) => update({ from: (event.target as HTMLInputElement).value }) })]), h("label", ["结束统计期", h("input", { type: "date", value: detail.to, min: detail.from, onChange: (event: Event) => update({ to: (event.target as HTMLInputElement).value }) })])]),
    loading ? h("div", { class: "macro-loading" }, "正在按所选窗口加载趋势…") : error ? h("div", { class: "macro-error" }, error) : points.length ? h("div", { class: "macro-chart" }, [
      chart(points),
      h("div", { class: "macro-point-list" }, points.map((point) => h("span", { class: "macro-point", key: `${point.period}-${point.publishedAt}` }, `${point.period} · ${point.value === null ? reasonLabel(point.reason ?? "not_configured") : formatValue(point.value, detail.measure === "level" ? definition.unitFormat : measureDefinition(definition, detail.measure).displayFormat)}`))),
    ]) : h("div", { class: "macro-empty" }, "所选窗口没有可展示的数据。"),
    h("div", { class: "macro-detail-source" }, [h("div", { class: "macro-meta" }, `同比规则：${measureMethodDescription(definition.measures.yoy)}；环比规则：${measureMethodDescription(definition.measures.mom)}。`), definition.source?.url ? h("a", { href: definition.source.url, target: "_blank", rel: "noreferrer" }, `查看来源：${definition.source.publisher ?? definition.source.id}`) : h("div", { class: "macro-meta" }, "该具体序列尚未登记可访问的来源链接。")]),
  ])]);
}

function sparkline(points: RawPoint[]) { const coordinates = lineCoordinates(points, 128, 38, 2); return h("svg", { class: "macro-sparkline", viewBox: "0 0 128 38", role: "img", "aria-label": "趋势摘要" }, coordinates ? [h("polyline", { class: "macro-sparkline-line", points: coordinates })] : []); }
function chart(points: SeriesPoint[]) { const visible = points.filter((point) => point.value !== null) as Array<SeriesPoint & { value: number }>; const coordinates = lineCoordinates(visible, 760, 210, 14); const dots = plotCoordinates(visible, 760, 210, 14); return h("svg", { viewBox: "0 0 760 210", role: "img", "aria-label": "所选趋势图" }, [h("line", { x1: 14, y1: 196, x2: 746, y2: 196, stroke: "#d8e1e3" }), coordinates ? h("polyline", { class: "macro-chart-line", points: coordinates }) : null, ...dots.map(([x, y], index) => h("circle", { class: "macro-chart-dot", key: `${x}-${y}-${index}`, cx: x, cy: y, r: 2.8 }))]); }
function lineCoordinates(points: Array<{ value: number }>, width: number, height: number, padding: number): string | null { return plotCoordinates(points, width, height, padding).map(([x, y]) => `${x},${y}`).join(" ") || null; }
function plotCoordinates(points: Array<{ value: number }>, width: number, height: number, padding: number): Array<[number, number]> { if (!points.length) return []; const values = points.map((point) => point.value); const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1; const usableWidth = width - padding * 2; const usableHeight = height - padding * 2; return points.map((point, index) => [padding + (points.length === 1 ? usableWidth / 2 : index / (points.length - 1) * usableWidth), padding + (max - point.value) / span * usableHeight]); }
async function fetchJson<T>(url: string): Promise<T> { const response = await fetch(url); const body = await response.json() as ApiEnvelope<T>; if (!response.ok || body.code !== 200) throw new Error(body.msg || `HTTP ${response.status}`); return body.data; }
function formatValue(value: number, format = "number"): string { return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: format === "integer" ? 0 : format === "percent" || format === "percentage_point" ? 2 : 3 }).format(value); }
function formatSigned(value: number, format: string): string { return `${value > 0 ? "+" : ""}${formatValue(value, format)}`; }
function formatTimestamp(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : value; }
function unitSuffix(unit: string): string { return unit ? ` ${unit}` : ""; }
function measureSuffix(definition: MeasureDefinition, unit: string): string { return definition.method === "percentage_point_change" ? " 个百分点" : definition.displayFormat === "percent" && unit !== "%" ? " %" : ""; }
function measureDefinition(definition: Definition, measure: Detail["measure"]): MeasureDefinition { return measure === "yoy" ? definition.measures.yoy : definition.measures.mom; }
function measureMethodLabel(method: string): string { return method === "native" ? "（原生）" : method === "percentage_point_change" ? "（百分点）" : ""; }
function measureMethodDescription(definition: MeasureDefinition): string { return definition.method === "native" ? "使用来源发布的原生测度" : definition.method === "not_applicable" ? "不适用" : `${definition.method}，基期 ${definition.basePeriods} 期`; }
function labelForAvailability(status: OverviewEntry["availability"]["status"]): string { return ({ available: "可用", unmapped: "待接入", awaiting_first_release: "等待首发", awaiting_data: "等待数据" })[status]; }
function reasonLabel(reason: string): string { return ({ unmapped: "尚无已验证来源映射", awaiting_first_release: "来源已登记，等待首次发布", awaiting_data: "当前尚无可见观测", not_applicable: "该测度不适用", not_configured: "尚未配置计算规则", base_period_missing: "缺少严格对应的基期", base_zero: "基期为零，无法计算", insufficient_history: "历史期数不足" })[reason] ?? reason; }
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }

createApp(MacroPage).mount("#macro-vue-root");
