<script setup lang="ts">
import { BarChart, LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  type GridComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import { init, use, type ECharts, type ComposeOption } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

type ChartOption = ComposeOption<
  GridComponentOption | TooltipComponentOption
>;

type ApiResponse<T> = { code: number; msg: string; data: T };
type StatementType = "income" | "balance" | "cashflow";
type Overview = {
  code: string;
  name: string;
  market: string;
  type: string;
  latestPrice: number | null;
  pctChange: number | null;
  changeAmount: number | null;
  turnover: number | null;
  marketCapYi: number | null;
  peTtm: number | null;
  pb: number | null;
  source: string;
};
type KlineRow = {
  date: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  amount: number | null;
  pctChange: number | null;
};
type NoticeRow = { artCode: string; title: string; noticeDate: string; noticeType: string };
type FinanceRow = { reportDate: string; fiscalPeriod: string | null; payload: Record<string, unknown> };

const params = new URLSearchParams(window.location.search);
const code = ref((params.get("code") || "300308.SZ").toUpperCase());
const fromTs = Number(params.get("from") || "0");
const fromDate = ref(fromTs > 0 ? new Date(fromTs).toISOString().slice(0, 10) : "2025-01-01");
const toDate = ref(new Date().toISOString().slice(0, 10));
const fq = ref<"qfq" | "normal" | "hfq">("qfq");
const activeStatement = ref<StatementType>("income");
const loading = ref(false);
const status = ref("");
const overview = ref<Overview | null>(null);
const klineRows = ref<KlineRow[]>([]);
const financeRows = ref<FinanceRow[]>([]);
const notices = ref<NoticeRow[]>([]);
const chartRef = ref<HTMLDivElement | null>(null);
let chart: ECharts | null = null;

const latestRow = computed(() => klineRows.value.at(-1) ?? null);
const eastmoneyChartImage = computed(() =>
  isEastmoneyAStock(code.value) ? eastmoneyKlineImageUrl(code.value) : ""
);

async function bootstrap() {
  loading.value = true;
  status.value = "";
  try {
    await Promise.all([loadOverview(), loadKline(), loadFinance(), loadNotices()]);
    await nextTick();
    renderChart();
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function loadOverview() {
  overview.value = await api<Overview>(`/api/company/overview?code=${encodeURIComponent(code.value)}`);
  document.title = `${overview.value.name} - Company`;
}

async function loadKline() {
  if (isEastmoneyAStock(code.value)) {
    klineRows.value = [];
    return;
  }
  const payload = await api<{ rows: KlineRow[] }>(
    `/api/kline?code=${encodeURIComponent(code.value)}&fq=${fq.value}&from=${fromDate.value}&to=${toDate.value}`
  );
  klineRows.value = payload.rows;
}

async function loadFinance() {
  const payload = await api<{ rows: FinanceRow[] }>(
    `/api/finance/${activeStatement.value}?code=${encodeURIComponent(code.value)}`
  );
  financeRows.value = payload.rows;
}

async function loadNotices() {
  notices.value = await api<NoticeRow[]>(`/api/company/notices?code=${encodeURIComponent(code.value)}&pageSize=12`);
}

async function refreshPage() {
  await bootstrap();
}

function renderChart() {
  if (eastmoneyChartImage.value) {
    chart?.dispose();
    chart = null;
    return;
  }
  if (!chartRef.value) {
    return;
  }
  if (!chart) {
    chart = init(chartRef.value);
  }
  const option: ChartOption = {
    animation: false,
    backgroundColor: "transparent",
    grid: [
      { left: 52, right: 18, top: 20, height: "58%" },
      { left: 52, right: 18, top: "74%", height: "16%" }
    ],
    tooltip: { trigger: "axis" },
    xAxis: [
      {
        type: "category",
        data: klineRows.value.map((row) => row.date),
        boundaryGap: false,
        axisLabel: { color: "#5a6772" }
      },
      {
        type: "category",
        gridIndex: 1,
        data: klineRows.value.map((row) => row.date),
        boundaryGap: false,
        axisLabel: { show: false }
      }
    ],
    yAxis: [
      { scale: true, axisLabel: { color: "#5a6772" }, splitLine: { lineStyle: { color: "#e7ecef" } } },
      { gridIndex: 1, scale: true, axisLabel: { color: "#5a6772" }, splitLine: { show: false } }
    ],
    series: [
      {
        name: "收盘价",
        type: "line",
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2, color: "#155e63" },
        areaStyle: { color: "rgba(21,94,99,0.08)" },
        data: klineRows.value.map((row) => row.close)
      },
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        itemStyle: { color: "#b86a44" },
        data: klineRows.value.map((row) => row.volume)
      }
    ]
  };
  chart.setOption(option);
}

watch([fq, fromDate, toDate], async () => {
  await loadKline();
  await nextTick();
  renderChart();
});

watch(activeStatement, async () => {
  await loadFinance();
});

onMounted(async () => {
  await bootstrap();
  window.addEventListener("resize", renderChart);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", renderChart);
  chart?.dispose();
});

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json()) as ApiResponse<T>;
  if (payload.code !== 200) {
    throw new Error(payload.msg);
  }
  return payload.data;
}

function formatNumber(value: unknown, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function metricValue(row: FinanceRow, key: string): string {
  return formatNumber(Number(row.payload[key]));
}

function label(type: StatementType): string {
  if (type === "balance") return "资产负债表";
  if (type === "cashflow") return "现金流量表";
  return "利润表";
}

function isEastmoneyAStock(input: string): boolean {
  return /^\d{6}\.(SH|SZ|BJ)$/i.test(input.trim());
}

function eastmoneySecId(input: string): string {
  const [base, suffix] = input.trim().toUpperCase().split(".");
  if (!base || !suffix) {
    throw new Error(`unsupported code: ${input}`);
  }
  if (suffix === "SH") {
    return `1.${base}`;
  }
  if (suffix === "SZ" || suffix === "BJ") {
    return `0.${base}`;
  }
  throw new Error(`unsupported code: ${input}`);
}

function eastmoneyKlineImageUrl(inputCode: string): string {
  const url = new URL("https://webquoteklinepic.eastmoney.com/GetPic.aspx");
  url.searchParams.set("nid", eastmoneySecId(inputCode));
  url.searchParams.set("type", "");
  url.searchParams.set("unitWidth", "-6");
  url.searchParams.set("imageType", "KXL");
  url.searchParams.set("EF", "");
  url.searchParams.set("formula", "MACD");
  url.searchParams.set("AT", "1");
  url.searchParams.set("dt", "6");
  url.searchParams.set("token", "44c9d251add88e27b65ed86506f6e5da");
  return url.toString();
}
</script>

<template>
  <main class="company-shell">
    <header class="company-header">
      <div>
        <p class="eyebrow">Company</p>
        <h1>{{ overview?.name || code }}</h1>
        <p class="subline">{{ overview?.code || code }} / {{ overview?.market || "-" }}</p>
      </div>
      <div class="headline-metrics">
        <div><span>最新价</span><strong>{{ formatNumber(overview?.latestPrice) }}</strong></div>
        <div><span>涨跌幅</span><strong>{{ formatNumber(overview?.pctChange) }}%</strong></div>
        <div><span>市值(亿)</span><strong>{{ formatNumber(overview?.marketCapYi) }}</strong></div>
      </div>
    </header>

    <nav class="subnav">
      <a class="active" :href="`company.html?code=${encodeURIComponent(code)}&from=${Date.parse(fromDate)}`">公司概览</a>
      <a :href="`company.html?code=${encodeURIComponent(code)}&from=${Date.parse(fromDate)}`">财务估值</a>
      <a :href="`company.html?code=${encodeURIComponent(code)}&from=${Date.parse(fromDate)}`">公告</a>
    </nav>

    <section class="toolbar">
      <div class="toolbar-group">
        <label>代码<input v-model="code" /></label>
        <label>开始<input v-model="fromDate" type="date" /></label>
        <label>结束<input v-model="toDate" type="date" /></label>
      </div>
      <div class="toolbar-group">
        <label>复权
          <select v-model="fq">
            <option value="qfq">前复权</option>
            <option value="normal">不复权</option>
            <option value="hfq">后复权</option>
          </select>
        </label>
        <button type="button" @click="refreshPage">{{ loading ? "加载中" : "刷新" }}</button>
      </div>
    </section>

    <p v-if="status" class="status">{{ status }}</p>

    <section class="content-grid">
      <div class="chart-panel">
        <div class="panel-head">
          <h2>K 线</h2>
          <span>东财 / {{ eastmoneyChartImage ? "图片" : latestRow?.date || "-" }}</span>
        </div>
        <img v-if="eastmoneyChartImage" class="chart-image" :src="eastmoneyChartImage" alt="东财K线图" />
        <div v-else ref="chartRef" class="chart-box"></div>
      </div>

      <div class="quote-panel">
        <div class="panel-head">
          <h2>估值</h2>
          <span>{{ overview?.source || "-" }}</span>
        </div>
        <dl class="quote-grid">
          <div><dt>最新价</dt><dd>{{ formatNumber(overview?.latestPrice) }}</dd></div>
          <div><dt>涨跌额</dt><dd>{{ formatNumber(overview?.changeAmount) }}</dd></div>
          <div><dt>涨跌幅</dt><dd>{{ formatNumber(overview?.pctChange) }}%</dd></div>
          <div><dt>换手率</dt><dd>{{ formatNumber(overview?.turnover) }}%</dd></div>
          <div><dt>PE TTM</dt><dd>{{ formatNumber(overview?.peTtm) }}</dd></div>
          <div><dt>PB</dt><dd>{{ formatNumber(overview?.pb) }}</dd></div>
        </dl>
      </div>
    </section>

    <section class="panel finance-panel">
      <div class="panel-head">
        <h2>{{ label(activeStatement) }}</h2>
        <div class="tab-row">
          <button
            v-for="item in ['income', 'balance', 'cashflow']"
            :key="item"
            type="button"
            :class="{ active: item === activeStatement }"
            @click="activeStatement = item as StatementType"
          >
            {{ label(item as StatementType) }}
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>报告期</th>
              <th>类型</th>
              <th>营业收入</th>
              <th>归母净利润</th>
              <th>每股收益</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in financeRows.slice(0, 10)" :key="row.reportDate">
              <td>{{ row.reportDate }}</td>
              <td>{{ row.fiscalPeriod || "-" }}</td>
              <td>{{ metricValue(row, 'TOTAL_OPERATE_INCOME') }}</td>
              <td>{{ metricValue(row, 'PARENT_NETPROFIT') }}</td>
              <td>{{ metricValue(row, 'BASIC_EPS') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>公告</h2>
        <span>{{ notices.length }} 条</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>类型</th>
              <th>标题</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in notices" :key="item.artCode">
              <td>{{ item.noticeDate }}</td>
              <td>{{ item.noticeType || "-" }}</td>
              <td>{{ item.title }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>
