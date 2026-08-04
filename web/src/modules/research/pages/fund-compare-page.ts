import { createApp, defineComponent, h, ref } from "vue";

type Row = {
  code: string;
  info: Record<string, string>;
  allocation: { stockPct: number | null; bondPct: number | null; cashPct: number | null } | null;
  holdingCount: number | null;
  performance: { oneYearReturnPct: number } | null;
  dataHealth: { navSource: string; latestNavDate: string | null };
};

const App = defineComponent({
  setup() {
    const codes = ref(new URLSearchParams(location.search).get("codes") || "");
    const rows = ref<Row[]>([]);
    const note = ref("");
    const loading = ref(false);
    const load = async () => {
      loading.value = true; note.value = "";
      try {
        const response = await fetch(`/api/fund/compare?codes=${encodeURIComponent(codes.value)}`);
        const body = await response.json();
        if (!response.ok || body.code !== 200) throw new Error(body.msg || "读取失败");
        rows.value = body.data.rows; note.value = body.data.limitation;
      } catch (error) { note.value = error instanceof Error ? error.message : String(error); } finally { loading.value = false; }
    };
    const header = ["基金", "类型 / 管理人", "规模", "资产配置（最新报告）", "持仓数", "约一年累计变化", "数据截至"];
    const table = () => h("div", { class: "table-responsive mt-3" }, h("table", { class: "table table-bordered table-hover align-middle" }, [
      h("thead", { class: "table-success" }, h("tr", header.map((item) => h("th", item)))),
      h("tbody", rows.value.map((row) => h("tr", { key: row.code }, [
        h("td", [h("strong", row.info.name || row.code), h("div", { class: "small text-muted" }, row.code)]),
        h("td", `${row.info.style || "—"} / ${row.info.manager || "—"}`), h("td", row.info.scale || "—"),
        h("td", row.allocation ? `股票 ${row.allocation.stockPct ?? "—"}% · 债券 ${row.allocation.bondPct ?? "—"}% · 现金 ${row.allocation.cashPct ?? "—"}%` : "待补"),
        h("td", row.holdingCount ?? "—"), h("td", row.performance ? `${row.performance.oneYearReturnPct.toFixed(2)}%` : "待补"),
        h("td", `${row.dataHealth.navSource} · ${row.dataHealth.latestNavDate ?? "待补"}`),
      ]))),
    ]));
    return () => h("main", { class: "py-4" }, h("div", { class: "container" }, [
      h("section", { class: "card shadow-sm" }, h("div", { class: "card-body" }, [
        h("h1", { class: "h3" }, "基金 / ETF 可比数据对照"),
        h("p", { class: "text-muted small" }, "比较公开的规模、资产配置、持仓数量和累计净值区间表现；不从横向排名生成配置结论。"),
        h("div", { class: "d-flex gap-2" }, [
          h("input", { class: "form-control", placeholder: "输入 2–6 个代码，以逗号分隔，如 513100.OF,510300.OF", value: codes.value, onInput: (event: Event) => { codes.value = (event.target as HTMLInputElement).value; } }),
          h("button", { class: "btn btn-success", onClick: () => void load() }, loading.value ? "读取中" : "对比"),
        ]),
      ])),
      note.value ? h("p", { class: "small text-muted mt-3" }, note.value) : null,
      rows.value.length ? table() : null,
    ]));
  },
});

const root = document.getElementById("fund-compare-vue-root");
if (root) createApp(App).mount(root);
