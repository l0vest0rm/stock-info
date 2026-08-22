import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type FinanceTableCell = {
  valueText: string
  growthText: string
  ratioText: string
  growthClass: string
  isEmpty: boolean
}

type FinanceTableRow = {
  chartKey: string
  label: string
  labelClass: string
  cells: FinanceTableCell[]
}

type FinanceTableHeaderGroup = {
  className: string
  colspan: number
  text: string
}

type FinanceTableCodeHeader = {
  className: string
  code: string
  name: string
}

type FinanceTableState = {
  codeHeaders: FinanceTableCodeHeader[]
  headerGroups: FinanceTableHeaderGroup[]
  ratioByPercent: boolean
  rows: FinanceTableRow[]
  tableId: string
  tableName: string
}

type CompanyFinanceStateEvent = CustomEvent<{
  balanceTable?: FinanceTableState
  cashflowTable?: FinanceTableState
  coreTable?: FinanceTableState
  incomeTable?: FinanceTableState
}>

type FinanceTabKey = 'analysis' | 'core' | 'income' | 'balance' | 'cashflow'

type FinancialAnalysisState = {
  availability: 'empty' | 'pending' | 'available' | 'failed'
  task: { taskId?: number; name?: string; status?: string; requestedReasoningEffort?: string | null; lastErrorMessage?: string | null; completedAt?: number | null; updatedAt?: number | null } | null
  snapshot: {
    asOf?: string | null
    dataQuality?: { status?: string; sourcePolicy?: string; statutoryVerification?: { status?: string; reason?: string } }
    periodCoverage?: { annual?: string[]; quarterly?: string[]; ttmEndDate?: string | null }
    deterministicFlags?: Array<{ ruleId: string; severity: string; title: string; period: string; value: number; unit: string }>
  } | null
  report: { markdown?: string; citations?: Array<{ title?: string; url?: string }> } | null
  resume?: { available?: boolean }
}

function codeFromUrl() {
  return new URL(window.location.href).searchParams.get('code')?.trim().toUpperCase() || ''
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || `请求失败：${response.status}`)
  return payload.data as T
}

/** Persisted model output is rendered as VNodes, never injected as HTML. */
function inlineMarkdown(source: string): Array<string | ReturnType<typeof h>> {
  const nodes: Array<string | ReturnType<typeof h>> = []
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g
  let offset = 0
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > offset) nodes.push(source.slice(offset, start))
    const token = match[0]
    if (token.startsWith('**') || token.startsWith('__')) nodes.push(h('strong', token.slice(2, -2)))
    else if (token.startsWith('`')) nodes.push(h('code', token.slice(1, -1)))
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token)
      nodes.push(link ? h('a', { href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]) : token)
    }
    offset = start + token.length
  }
  if (offset < source.length) nodes.push(source.slice(offset))
  return nodes
}

function renderFinancialAnalysisMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim())
  const blocks: Array<string | ReturnType<typeof h>> = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line) { index += 1; continue }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      blocks.push(h(`h${Math.min(heading[1].length, 4)}`, { key: `heading-${index}` }, inlineMarkdown(heading[2])))
      index += 1
      continue
    }
    const list = /^([-*+] |\d+\. )(.+)$/.exec(line)
    if (list) {
      const ordered = /^\d+\. /.test(line)
      const matcher = ordered ? /^\d+\.\s+(.+)$/ : /^[-*+]\s+(.+)$/
      const items: string[] = []
      while (index < lines.length) {
        const item = matcher.exec(lines[index])
        if (!item) break
        items.push(item[1])
        index += 1
      }
      blocks.push(h(ordered ? 'ol' : 'ul', { key: `list-${index}` }, items.map((item, itemIndex) => h('li', { key: itemIndex }, inlineMarkdown(item)))))
      continue
    }
    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index] && !/^#{1,6}\s+|^[-*+]\s+|^\d+\.\s+/.test(lines[index])) paragraph.push(lines[index++])
    blocks.push(h('p', { key: `paragraph-${index}` }, inlineMarkdown(paragraph.join(' '))))
  }
  return blocks
}

function formatFinancialAnalysisTimestamp(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(Number(value)))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
}

function renderFinancialAnalysis(state: FinancialAnalysisState | null, options: { generating: boolean; error: string | null; generate: () => Promise<void>; resume: () => Promise<void> }) {
  const code = codeFromUrl()
  if (!code) return h('section', { class: 'card border-info mb-3' }, [h('div', { class: 'card-body text-muted' }, '请选择单只股票后生成深入财务分析；多股票对比仍使用下方图表和三表。')])
  const snapshot = state?.snapshot
  const quality = snapshot?.dataQuality
  const flags = snapshot?.deterministicFlags || []
  const status = state?.availability === 'available' ? '已完成' : state?.availability === 'failed' ? '失败' : state?.availability === 'pending' ? '生成中' : '尚未生成'
  const reportGeneratedAt = formatFinancialAnalysisTimestamp(state?.task?.completedAt)
  const lastUpdatedAt = formatFinancialAnalysisTimestamp(state?.task?.updatedAt)
  const taskName = typeof state?.task?.name === 'string' && state.task.name.trim() ? state.task.name.trim() : ''
  const dataAsOf = typeof snapshot?.asOf === 'string' && snapshot.asOf.trim() ? snapshot.asOf.trim() : snapshot?.periodCoverage?.ttmEndDate || ''
  const statusSummary = [
    `单证券 · ${code} · ${status}`,
    reportGeneratedAt ? `${state?.availability === 'available' ? '报告生成' : '任务结束'}于 ${reportGeneratedAt}` : '',
  ].filter(Boolean).join(' · ')
  const timingSummary = [
    reportGeneratedAt ? `报告生成：${reportGeneratedAt}` : '',
    dataAsOf ? `数据截至：${dataAsOf}` : '',
    !reportGeneratedAt && lastUpdatedAt ? `最近更新：${lastUpdatedAt}` : '',
  ].filter(Boolean).join('；')
  return h('section', { class: 'card border-primary mb-3', id: 'financial-analysis' }, [
    h('div', { class: 'card-header d-flex align-items-center justify-content-between gap-2 flex-wrap' }, [
      h('div', [h('strong', '深入财务分析'), h('small', { class: 'text-muted ms-2' }, statusSummary)]),
      h('div', { class: 'd-flex gap-2' }, [
        h('button', { class: 'btn btn-sm btn-primary', disabled: options.generating, onClick: options.generate }, options.generating ? '正在提交…' : '生成/刷新'),
        state?.resume?.available ? h('button', { class: 'btn btn-sm btn-outline-primary', disabled: options.generating, onClick: options.resume }, '恢复失败任务') : null,
      ]),
    ]),
    h('div', { class: 'card-body' }, [
      timingSummary ? h('p', { class: 'small text-muted mb-2' }, timingSummary) : null,
      taskName ? h('p', { class: 'small text-muted mb-2' }, ['taskd 任务名：', h('code', { class: 'font-monospace text-break' }, taskName)]) : null,
      quality ? h('p', { class: 'small text-muted mb-2' }, `数据：${quality.status || 'unknown'}；${quality.sourcePolicy || '来源待载入'}；法定核验：${quality.statutoryVerification?.status || 'unknown'}。${quality.statutoryVerification?.reason || ''}`) : h('p', { class: 'small text-muted' }, '尚无冻结的财务分析输入。'),
      snapshot?.periodCoverage ? h('p', { class: 'small text-muted' }, `覆盖：年度 ${snapshot.periodCoverage.annual?.join('、') || '—'}；季度 ${snapshot.periodCoverage.quarterly?.join('、') || '—'}；TTM 截至 ${snapshot.periodCoverage.ttmEndDate || '—'}。`) : null,
      options.error ? h('p', { class: 'alert alert-danger py-2 small' }, options.error) : null,
      flags.length ? h('div', { class: 'mb-3' }, [h('strong', { class: 'small' }, '工程触发的财务风险信号'), h('ul', { class: 'small mb-0 mt-1' }, flags.map((flag) => h('li', { key: flag.ruleId }, `[${flag.severity}] ${flag.title}（${flag.period}，${flag.value}${flag.unit}）`)))]) : null,
      state?.report?.markdown ? h('article', { class: 'company-finance-analysis-markdown' }, renderFinancialAnalysisMarkdown(state.report.markdown)) : h('p', { class: 'text-muted mb-0' }, '报告生成后会在此展示；模型只解释工程冻结的三表指标、缺口和风险信号。'),
      state?.report?.citations?.length ? h('div', { class: 'mt-3 small' }, [h('strong', '引用：'), ...state.report.citations.map((citation, index) => citation.url ? h('a', { class: 'ms-2', key: `${citation.url}-${index}`, href: citation.url, target: '_blank', rel: 'noreferrer' }, citation.title || citation.url) : null)]) : null,
    ]),
  ])
}

function renderFinanceTable(table: FinanceTableState | null) {
  if (!table) {
    return h('div', { class: 'small text-muted text-center py-4' }, '加载中...')
  }
  return h('table', {
    id: table.tableId,
    class: 'table table-sm table-bordered table-hover text-center w-auto mx-auto',
  }, [
    h('thead', { class: 'theadFix' }, [
      h('tr', [
      h('th', {
          rowspan: '2',
          scope: 'col',
          class: 'table-warning text-end',
        }, [
          table.tableName,
          table.ratioByPercent ? '(占比%)' : '',
          h('br'),
          '增长率%',
        ]),
        ...table.headerGroups.map((group) => h('th', {
          colspan: String(group.colspan),
          scope: 'col',
          class: group.className,
        }, group.text)),
      ]),
      h('tr', { class: 'fs-6' }, table.codeHeaders.map((header) => h('th', {
        scope: 'col',
        class: header.className,
      }, header.name))),
    ]),
    h('tbody', table.rows.map((row) => h('tr', { key: `${table.tableId}-${row.chartKey}` }, [
      h('td', {
        class: ['text-end', 'align-middle', row.labelClass].filter(Boolean).join(' '),
      }, [
        h('a', {
          'data-bs-target': '#chartModal',
          'data-bs-toggle': 'modal',
          'data-key': row.chartKey,
        }, row.label),
      ]),
      ...row.cells.map((cell, index) => {
        if (cell.isEmpty) {
          return h('td', { key: `${row.chartKey}-cell-${index}`, class: 'align-middle' }, '-')
        }
        const pieces: Array<string | ReturnType<typeof h>> = [cell.valueText]
        if (cell.ratioText) {
          pieces.push(`(${cell.ratioText}%)`)
        }
        pieces.push(h('br'))
        pieces.push(h('span', { class: cell.growthClass }, `${cell.growthText}%`))
        return h('td', { key: `${row.chartKey}-cell-${index}` }, pieces)
      }),
    ]))),
  ])
}

const CompanyFinancePage = defineComponent({
  name: 'CompanyFinancePage',
  setup() {
    const activeTab = ref<FinanceTabKey>('analysis')
    const coreTable = ref<FinanceTableState | null>(null)
    const incomeTable = ref<FinanceTableState | null>(null)
    const balanceTable = ref<FinanceTableState | null>(null)
    const cashflowTable = ref<FinanceTableState | null>(null)
    const financialAnalysis = ref<FinancialAnalysisState | null>(null)
    const financialAnalysisError = ref<string | null>(null)
    const financialAnalysisGenerating = ref(false)
    let financialAnalysisTimer: number | null = null

    const loadFinancialAnalysis = async () => {
      const code = codeFromUrl()
      if (!code) return
      try {
        financialAnalysis.value = await request<FinancialAnalysisState>(`/api/research/company/${encodeURIComponent(code)}/financial-analysis`)
        financialAnalysisError.value = null
      } catch (error) { financialAnalysisError.value = error instanceof Error ? error.message : String(error) }
    }
    const refreshFinancialAnalysis = async () => {
      const code = codeFromUrl()
      if (!code) return
      financialAnalysisGenerating.value = true
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/financial-analysis/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true, reasoningEffort: 'xhigh' }) })
        await loadFinancialAnalysis()
      } catch (error) { financialAnalysisError.value = error instanceof Error ? error.message : String(error) }
      finally { financialAnalysisGenerating.value = false }
    }
    const resumeFinancialAnalysis = async () => {
      const code = codeFromUrl()
      if (!code) return
      financialAnalysisGenerating.value = true
      try {
        await request(`/api/research/company/${encodeURIComponent(code)}/financial-analysis/resume`, { method: 'POST' })
        await loadFinancialAnalysis()
      } catch (error) { financialAnalysisError.value = error instanceof Error ? error.message : String(error) }
      finally { financialAnalysisGenerating.value = false }
    }

    const onState = (event: Event) => {
      const detail = (event as CompanyFinanceStateEvent).detail
      if (!detail) {
        return
      }
      if (detail.coreTable) {
        coreTable.value = detail.coreTable
      }
      if (detail.incomeTable) {
        incomeTable.value = detail.incomeTable
      }
      if (detail.balanceTable) {
        balanceTable.value = detail.balanceTable
      }
      if (detail.cashflowTable) {
        cashflowTable.value = detail.cashflowTable
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-finance-state', onState)
      void loadFinancialAnalysis()
      financialAnalysisTimer = window.setInterval(() => {
        if (financialAnalysis.value?.availability === 'pending') void loadFinancialAnalysis()
      }, 3000)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-finance-state', onState)
      if (financialAnalysisTimer !== null) window.clearInterval(financialAnalysisTimer)
    })

    const tabButton = (key: FinanceTabKey, label: string, target: string) => h('li', {
      class: 'nav-item',
      role: 'presentation',
    }, [
      h('button', {
        type: 'button',
        class: ['nav-link', 'border', 'border-primary', 'p-1', activeTab.value === key ? 'active' : ''].filter(Boolean).join(' '),
        'aria-selected': activeTab.value === key ? 'true' : 'false',
        'data-bs-target': target,
        'data-bs-toggle': 'pill',
        onClick: () => {
          activeTab.value = key
        },
        role: 'tab',
      }, label),
    ])

    const tabPane = (key: FinanceTabKey, id: string, table: FinanceTableState | null) => h('div', {
      class: ['tab-pane', 'fade', activeTab.value === key ? 'show active' : ''].filter(Boolean).join(' '),
      id,
      role: 'tabpanel',
      tabindex: '0',
    }, [renderFinanceTable(table)])

    return () => h('div', { class: 'company-finance-page' }, [
      h('div', { class: 'row' }, [
        h('div', { class: 'col-4' }),
        h('div', { class: 'col-4' }, [
          h('ul', { class: 'nav nav-pills mb-2 nav-justified', role: 'tablist' }, [
            tabButton('analysis', '深入分析', '#pills-financialAnalysis'),
            tabButton('core', '核心表', '#pills-coreTable'),
            tabButton('income', '利润表', '#pills-incomeTable'),
            tabButton('balance', '资产负债表', '#pills-balanceTable'),
            tabButton('cashflow', '现金流量表', '#pills-cashflowTable'),
          ]),
        ]),
        h('div', { class: 'col-4' }),
      ]),
      h('div', { class: 'tab-content' }, [
        h('div', { class: ['tab-pane', 'fade', activeTab.value === 'analysis' ? 'show active' : ''].filter(Boolean).join(' '), id: 'pills-financialAnalysis', role: 'tabpanel', tabindex: '0' }, [renderFinancialAnalysis(financialAnalysis.value, { generating: financialAnalysisGenerating.value, error: financialAnalysisError.value, generate: refreshFinancialAnalysis, resume: resumeFinancialAnalysis })]),
        tabPane('core', 'pills-coreTable', coreTable.value),
        tabPane('income', 'pills-incomeTable', incomeTable.value),
        tabPane('balance', 'pills-balanceTable', balanceTable.value),
        tabPane('cashflow', 'pills-cashflowTable', cashflowTable.value),
      ]),
    ])
  },
})

const root = document.getElementById('company-finance-vue-root')
if (root) {
  createApp(CompanyFinancePage).mount(root)
}
