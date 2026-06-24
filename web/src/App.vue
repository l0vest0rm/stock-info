<script setup lang="ts">
import { computed, ref } from "vue";

type ApiResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

type SecurityRecord = {
  code: string;
  market: string;
  type: string;
  name: string;
  source?: string;
  updatedAt: number;
};

type KlineRow = {
  date: string;
  open?: number | null;
  close?: number | null;
  high?: number | null;
  low?: number | null;
  nav?: number | null;
  accumNav?: number | null;
  pctChange?: number | null;
  dailyReturn?: number | null;
};

type KlinePayload = {
  code: string;
  source: string;
  rows: KlineRow[];
};

type FinanceRow = {
  reportDate: string;
  fiscalPeriod: string | null;
  payload: Record<string, unknown>;
};

type FinancePayload = {
  code: string;
  source: string;
  rows: FinanceRow[];
};

const query = ref("600519");
const loading = ref(false);
const status = ref("");
const results = ref<SecurityRecord[]>([]);
const selected = ref<SecurityRecord | null>(null);
const kline = ref<KlinePayload | null>(null);
const finance = ref<FinancePayload | null>(null);
const activeStatement = ref<"income" | "balance" | "cashflow">("income");

const latestPoint = computed(() => kline.value?.rows.at(-1) ?? null);

async function search() {
  const value = query.value.trim();
  if (!value) {
    return;
  }
  loading.value = true;
  status.value = "";
  try {
    const payload = await api<SecurityRecord[]>(`/api/search?q=${encodeURIComponent(value)}`);
    results.value = payload;
    selected.value = payload[0] ?? null;
    if (selected.value) {
      await loadSelected(selected.value);
    } else {
      kline.value = null;
      finance.value = null;
      status.value = "没有匹配结果";
    }
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function loadSelected(record: SecurityRecord) {
  selected.value = record;
  status.value = "";
  const to = new Date().toISOString().slice(0, 10);
  const from = offsetDate(to, 90);
  kline.value = await api<KlinePayload>(
    `/api/kline?code=${encodeURIComponent(record.code)}&from=${from}&to=${to}`
  );
  if (record.type === "stock") {
    finance.value = await api<FinancePayload>(
      `/api/finance/${activeStatement.value}?code=${encodeURIComponent(record.code)}`
    );
  } else {
    finance.value = null;
  }
}

async function switchStatement(statement: "income" | "balance" | "cashflow") {
  activeStatement.value = statement;
  if (selected.value?.type !== "stock") {
    return;
  }
  finance.value = await api<FinancePayload>(
    `/api/finance/${statement}?code=${encodeURIComponent(selected.value.code)}`
  );
}

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json()) as ApiResponse<T>;
  if (payload.code !== 200) {
    throw new Error(payload.msg);
  }
  return payload.data;
}

function offsetDate(endDate: string, days: number): string {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function formatNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (Math.abs(value) >= 100000000) {
    return `${(value / 100000000).toFixed(2)} 亿`;
  }
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(2)} 万`;
  }
  return value.toFixed(2);
}

function statementLabel(value: string): string {
  if (value === "balance") return "资产负债表";
  if (value === "cashflow") return "现金流量表";
  return "利润表";
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Cloudflare Workers</p>
        <h1>Stock Info</h1>
      </div>
      <div class="runtime">Hono API / Vue 3 / D1</div>
    </header>

    <section class="workspace">
      <aside class="search-pane">
        <form class="search-box" @submit.prevent="search">
          <input v-model="query" autocomplete="off" placeholder="股票、基金代码或名称" />
          <button :disabled="loading" type="submit">{{ loading ? "查询中" : "搜索" }}</button>
        </form>
        <p v-if="status" class="status">{{ status }}</p>

        <div class="result-list">
          <button
            v-for="item in results"
            :key="item.code"
            class="result-row"
            :class="{ active: item.code === selected?.code }"
            type="button"
            @click="loadSelected(item)"
          >
            <span>
              <strong>{{ item.name }}</strong>
              <small>{{ item.code }}</small>
            </span>
            <em>{{ item.type }}</em>
          </button>
        </div>
      </aside>

      <section class="detail-pane">
        <div v-if="selected" class="instrument-head">
          <div>
            <p class="eyebrow">{{ selected.market }} / {{ selected.type }}</p>
            <h2>{{ selected.name }}</h2>
          </div>
          <strong>{{ selected.code }}</strong>
        </div>

        <div v-if="kline" class="metrics">
          <div class="metric">
            <span>最新日期</span>
            <strong>{{ latestPoint?.date ?? "-" }}</strong>
          </div>
          <div class="metric">
            <span>{{ selected?.type === "fund" ? "单位净值" : "收盘价" }}</span>
            <strong>{{ formatNumber(selected?.type === "fund" ? latestPoint?.nav : latestPoint?.close) }}</strong>
          </div>
          <div class="metric">
            <span>{{ selected?.type === "fund" ? "日涨幅" : "涨跌幅" }}</span>
            <strong>{{ formatNumber(selected?.type === "fund" ? latestPoint?.dailyReturn : latestPoint?.pctChange) }}%</strong>
          </div>
          <div class="metric">
            <span>数据源</span>
            <strong>{{ kline.source }}</strong>
          </div>
        </div>

        <div v-if="kline" class="panel">
          <div class="panel-title">
            <h3>{{ selected?.type === "fund" ? "净值序列" : "K 线数据" }}</h3>
            <span>{{ kline.rows.length }} 条</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>{{ selected?.type === "fund" ? "单位净值" : "开盘" }}</th>
                  <th>{{ selected?.type === "fund" ? "累计净值" : "收盘" }}</th>
                  <th>{{ selected?.type === "fund" ? "日涨幅" : "涨跌幅" }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in kline.rows.slice(-12).reverse()" :key="row.date">
                  <td>{{ row.date }}</td>
                  <td>{{ formatNumber(selected?.type === "fund" ? row.nav : row.open) }}</td>
                  <td>{{ formatNumber(selected?.type === "fund" ? row.accumNav : row.close) }}</td>
                  <td>{{ formatNumber(selected?.type === "fund" ? row.dailyReturn : row.pctChange) }}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="finance" class="panel">
          <div class="panel-title">
            <h3>{{ statementLabel(activeStatement) }}</h3>
            <div class="tabs">
              <button
                v-for="statement in ['income', 'balance', 'cashflow']"
                :key="statement"
                :class="{ active: statement === activeStatement }"
                type="button"
                @click="switchStatement(statement as 'income' | 'balance' | 'cashflow')"
              >
                {{ statementLabel(statement) }}
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
                <tr v-for="row in finance.rows.slice(0, 8)" :key="row.reportDate">
                  <td>{{ row.reportDate }}</td>
                  <td>{{ row.fiscalPeriod ?? "-" }}</td>
                  <td>{{ formatNumber(row.payload.TOTAL_OPERATE_INCOME) }}</td>
                  <td>{{ formatNumber(row.payload.PARENT_NETPROFIT) }}</td>
                  <td>{{ formatNumber(row.payload.BASIC_EPS) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="!selected" class="empty-state">
          <h2>输入代码开始查询</h2>
          <p>优先查询 D1，本地没有时只补当前目标，避免免费额度被批量同步消耗。</p>
        </div>
      </section>
    </section>
  </main>
</template>
