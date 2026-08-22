import { computed, createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  calculateStrategyMetrics,
  daysToExpiry,
  intrinsicValue,
  legMoneynessDistancePct,
  strategyEntryCapital,
  strategyReturnRateAtExpiry,
  type OptionSide,
  type OptionType,
  type StrategyLeg,
} from '../domain/strategy-calculator'
import { latestKlinePrice } from '../domain/latest-kline-price'
import { optionContractKey } from '../domain/option-contract-key'
import { rememberRecentExpiration } from '../domain/recent-expirations'

declare const echarts: {
  dispose: (element: HTMLElement) => void
  init: (element: HTMLElement) => { setOption: (option: unknown) => void }
}

type Underlying = { code: string; name: string; spot: string; spotAsOf?: string; multiplier: string }
type Strategy = { id: string; name: string; savedAt: number; underlying: Underlying; legs: StrategyLeg[]; sequence?: number; isAutoName?: boolean }
type DraftLeg = Omit<StrategyLeg, 'id'>
type PayoffChartStrategy = { id: string; name: string; legs: StrategyLeg[] }
type HistoryRow = Strategy & { isCurrent: boolean }
type PremiumUpdateTarget = {
  key: string
  code: string
  type: OptionType
  strike: number
  expiration: string
  multiplier: number
  strategyCount: number
  premiumValues: number[]
}

const HISTORY_KEY = 'option-strategy-history-v1'
const DRAFT_KEY = 'option-strategy-draft-v1'
const RECENT_EXPIRATIONS_KEY = 'option-strategy-recent-expirations-v2'
const STRATEGY_SEQUENCE_KEY = 'option-strategy-sequence-v1'

function initialDraftLeg(): DraftLeg {
  return { side: 'buy', type: 'call', strike: '', expiration: '', premium: '', quantity: 1, multiplier: 100 } as unknown as DraftLeg
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
}

function formatUnderlyingPrice(value: number | null): string {
  return formatNumber(value, value !== null && value > 0 && value < 100 ? 3 : 2)
}

function inferMultiplier(code: string): string {
  const normalized = code.trim().toUpperCase()
  return /\.(SH|SZ|BJ)$/.test(normalized) ? '10000' : '100'
}

function normalizeUnderlying(input: Underlying): Underlying {
  const code = input.code.trim().toUpperCase()
  return { ...input, code, multiplier: input.multiplier || inferMultiplier(code) }
}

function toLeg(draft: DraftLeg): StrategyLeg {
  return {
    id: crypto.randomUUID(),
    side: draft.side,
    type: draft.type,
    strike: number(draft.strike),
    expiration: draft.expiration,
    premium: number(draft.premium),
    quantity: Math.max(1, Math.floor(number(draft.quantity))),
    multiplier: Math.max(1, number(draft.multiplier)),
  }
}

function restore<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '')
    return parsed && typeof parsed === 'object' ? parsed as T : fallback
  } catch {
    return fallback
  }
}

function metricCard(label: string, value: string, note = '') {
  return h('div', { class: 'col-6 col-lg-3' }, [
    h('div', { class: 'border rounded bg-light p-3 h-100' }, [
      h('div', { class: 'small text-muted' }, label),
      h('div', { class: 'fs-5 fw-semibold text-nowrap' }, value),
      note ? h('div', { class: 'small text-muted mt-1' }, note) : null,
    ]),
  ])
}

function automaticStrategyName(code: string, legs: StrategyLeg[]): string {
  const underlyingCode = code.trim().toUpperCase() || '未命名标的'
  if (legs.length === 0) return `${underlyingCode} 期权组合`
  const legNames = legs.map((leg) => [
    leg.side === 'buy' ? '买' : '卖',
    leg.type === 'call' ? 'Call' : 'Put',
    formatNumber(leg.strike, 3),
    `权利金${formatNumber(leg.premium, 4)}`,
    leg.expiration,
    `${leg.quantity}张×${leg.multiplier}`,
  ].join(' '))
  return `${underlyingCode} · ${legNames.join(' + ')}`
}

function strategyNumberLabel(sequence: number | null | undefined): string {
  return sequence && sequence > 0 ? `组合 #${String(sequence).padStart(3, '0')}` : '待创建组合'
}

function strategyDisplayName(strategy: Pick<Strategy, 'name' | 'sequence'>): string {
  return strategy.sequence ? strategyNumberLabel(strategy.sequence) : strategy.name
}

function payoffChartStrategies(current: PayoffChartStrategy, history: Strategy[], code: string): PayoffChartStrategy[] {
  const normalizedCode = code.trim().toUpperCase()
  if (!normalizedCode) return current.legs.length ? [current] : []
  return [
    ...(current.legs.length ? [current] : []),
    ...history
      .filter((item) => item.id !== current.id && item.underlying.code.trim().toUpperCase() === normalizedCode && item.legs.length > 0)
      .slice(0, 10)
      .map((item) => ({ id: item.id, name: strategyDisplayName(item), legs: item.legs })),
  ]
}

function payoffChartPriceRange(strategies: PayoffChartStrategy[], spot: number): [number, number] | null {
  const anchors = [spot, ...strategies.flatMap((strategy) => strategy.legs.map((leg) => leg.strike))].filter((value) => value > 0)
  if (anchors.length === 0) return null
  const maximum = Math.max(...anchors)
  return [0, Math.max(maximum * 1.5, 1)]
}

const OptionStrategyPage = defineComponent({
  name: 'OptionStrategyPage',
  setup() {
    const underlying = ref<Underlying>({ code: '', name: '', spot: '', multiplier: '100' })
    const legDraft = ref<DraftLeg>(initialDraftLeg())
    const legs = ref<StrategyLeg[]>([])
    const strategyName = ref('')
    const history = ref<Strategy[]>([])
    const currentStrategyId = ref('')
    const currentStrategySequence = ref<number | null>(null)
    const nextStrategySequence = ref(1)
    const contractPremiumDrafts = ref<Record<string, string>>({})
    const suggestions = ref<Array<{ code: string; name: string }>>([])
    const recentExpirations = ref<string[]>([])
    const searchStatus = ref('')
    const spotStatus = ref('')
    let searchTimer: number | undefined
    let spotTimer: number | undefined
    let spotRequestSequence = 0

    const spot = computed(() => number(underlying.value.spot))
    const metrics = computed(() => calculateStrategyMetrics(legs.value, spot.value))
    const strategyDescription = computed(() => strategyName.value.trim() || automaticStrategyName(underlying.value.code, legs.value))
    const strategyNumber = computed(() => strategyNumberLabel(currentStrategySequence.value))
    const strategyTitle = computed(() => `${strategyNumber.value} · ${strategyDescription.value}`)
    const chartStrategies = computed(() => payoffChartStrategies({ id: currentStrategyId.value || 'current', name: `${strategyNumber.value}（当前）`, legs: legs.value }, history.value, underlying.value.code))
    const chartableStrategies = computed(() => chartStrategies.value.filter((strategy) => strategyEntryCapital(strategy.legs) > 0))
    const excludedChartStrategies = computed(() => chartStrategies.value.length - chartableStrategies.value.length)
    const currentHistoryRow = computed<HistoryRow | null>(() => {
      if (!underlying.value.code.trim() || legs.value.length === 0) return null
      return {
        id: currentStrategyId.value || 'current',
        sequence: currentStrategySequence.value ?? undefined,
        name: strategyDescription.value,
        savedAt: 0,
        underlying: normalizeUnderlying(underlying.value),
        legs: legs.value,
        isCurrent: true,
      }
    })
    const historyRows = computed<HistoryRow[]>(() => [
      ...(currentHistoryRow.value ? [currentHistoryRow.value] : []),
      ...history.value.filter((item) => item.id !== currentStrategyId.value).map((item) => ({ ...item, isCurrent: false })),
    ])
    const premiumUpdateTargets = computed<PremiumUpdateTarget[]>(() => {
      const targets = new Map<string, PremiumUpdateTarget & { strategyIds: Set<string>; premiums: Set<number> }>()
      for (const strategy of historyRows.value) {
        for (const leg of strategy.legs) {
          const key = optionContractKey(strategy.underlying.code, leg)
          const target = targets.get(key) || {
            key,
            code: strategy.underlying.code,
            type: leg.type,
            strike: leg.strike,
            expiration: leg.expiration,
            multiplier: leg.multiplier,
            strategyCount: 0,
            premiumValues: [],
            strategyIds: new Set<string>(),
            premiums: new Set<number>(),
          }
          target.strategyIds.add(strategy.id)
          target.premiums.add(leg.premium)
          targets.set(key, target)
        }
      }
      return [...targets.values()]
        .map(({ strategyIds, premiums, ...target }) => ({ ...target, strategyCount: strategyIds.size, premiumValues: [...premiums].sort((a, b) => a - b) }))
        .sort((left, right) => left.code.localeCompare(right.code) || left.expiration.localeCompare(right.expiration) || left.strike - right.strike || left.type.localeCompare(right.type))
    })

    function saveDraft() {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        underlying: underlying.value,
        legs: legs.value,
        strategyName: strategyName.value,
        currentStrategyId: currentStrategyId.value,
        currentStrategySequence: currentStrategySequence.value,
      }))
    }

    function ensureCurrentStrategyIdentity() {
      if (!currentStrategyId.value) currentStrategyId.value = crypto.randomUUID()
      if (!currentStrategySequence.value) {
        currentStrategySequence.value = nextStrategySequence.value
        nextStrategySequence.value += 1
        localStorage.setItem(STRATEGY_SEQUENCE_KEY, String(nextStrategySequence.value))
      }
    }

    function parsePremium(value: string): number | null {
      const normalized = value.trim()
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null
      const parsed = Number(normalized)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
    }

    function synchronizeContractPremium(contractKey: string, premium: number): number {
      const affectedStrategyIds = new Set<string>()
      const currentCode = underlying.value.code
      const updateLegs = (code: string, sourceLegs: StrategyLeg[], strategyId: string) => sourceLegs.map((leg) => {
        if (optionContractKey(code, leg) !== contractKey) return leg
        affectedStrategyIds.add(strategyId)
        return { ...leg, premium }
      })
      legs.value = updateLegs(currentCode, legs.value, currentStrategyId.value || 'current')
      history.value = history.value.map((strategy) => ({
        ...strategy,
        legs: updateLegs(strategy.underlying.code, strategy.legs, strategy.id),
      })).map((strategy) => strategy.isAutoName
        ? { ...strategy, name: automaticStrategyName(strategy.underlying.code, strategy.legs) }
        : strategy)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
      saveDraft()
      return affectedStrategyIds.size
    }

    function updateMatchingContractPremium(target: PremiumUpdateTarget) {
      const rawValue = contractPremiumDrafts.value[target.key]
      const premium = parsePremium(rawValue ?? '')
      if (premium === null) {
        searchStatus.value = '请输入有效的非负权利金。'
        return
      }
      const affectedStrategyCount = synchronizeContractPremium(target.key, premium)
      const nextDrafts = { ...contractPremiumDrafts.value }
      delete nextDrafts[target.key]
      contractPremiumDrafts.value = nextDrafts
      searchStatus.value = `已将当前和历史中 ${affectedStrategyCount} 套组合的匹配期权腿更新为权利金 ${formatNumber(premium, 4)}。`
    }

    function updateUnderlying(key: keyof Underlying, value: string) {
      underlying.value = normalizeUnderlying({
        ...underlying.value,
        [key]: value,
        ...(key === 'code' ? { multiplier: inferMultiplier(value) } : {}),
      })
      if (key === 'code') {
        underlying.value = { ...underlying.value, spot: '', spotAsOf: undefined }
        legDraft.value = { ...legDraft.value, multiplier: underlying.value.multiplier }
      }
      saveDraft()
    }

    async function refreshSpot(rawCode = underlying.value.code) {
      const code = rawCode.trim().toUpperCase()
      if (!/^(\d{6}|\d{5}|.+\.(SH|SZ|BJ|HK|US))$/i.test(code)) return
      const requestId = ++spotRequestSequence
      spotStatus.value = '正在通过 K 线获取最新收盘价…'
      try {
        const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
        const response = await fetch(`/api/kline?code=${encodeURIComponent(code)}&period=day&fq=normal&from=${from}&format=structured`)
        const body = await response.json()
        if (!response.ok || body.code !== 200) throw new Error(body.msg || 'K 线读取失败')
        const latest = latestKlinePrice(body.data)
        if (!latest) throw new Error('K 线未返回有效价格')
        if (requestId !== spotRequestSequence || underlying.value.code.trim().toUpperCase() !== code) return
        underlying.value = { ...underlying.value, spot: String(latest.price), spotAsOf: latest.date }
        spotStatus.value = `K 线最新收盘价${latest.date ? `（${latest.date}）` : ''}`
        saveDraft()
      } catch (error) {
        if (requestId !== spotRequestSequence || underlying.value.code.trim().toUpperCase() !== code) return
        underlying.value = { ...underlying.value, spot: '', spotAsOf: undefined }
        spotStatus.value = `K 线行情不可用：${error instanceof Error ? error.message : '读取失败'}`
        saveDraft()
      }
    }

    async function searchUnderlying(query: string) {
      updateUnderlying('code', query)
      window.clearTimeout(searchTimer)
      window.clearTimeout(spotTimer)
      suggestions.value = []
      searchStatus.value = ''
      spotStatus.value = ''
      spotTimer = window.setTimeout(() => void refreshSpot(query), 420)
      if (query.trim().length < 2) return
      searchTimer = window.setTimeout(async () => {
        try {
          const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`)
          const body = await response.json()
          if (!response.ok || body.code !== 200) throw new Error(body.msg || '搜索失败')
          suggestions.value = Array.isArray(body.data) ? body.data.filter((item: any) => item?.code && item?.name) : []
          if (suggestions.value.length === 0) searchStatus.value = '未找到标的，可继续手动输入。'
        } catch {
          searchStatus.value = '标的搜索暂不可用，可继续手动输入。'
        }
      }, 260)
    }

    function selectSuggestion(item: { code: string; name: string }) {
      underlying.value = normalizeUnderlying({ ...underlying.value, code: item.code, name: item.name, multiplier: inferMultiplier(item.code) })
      legDraft.value = { ...legDraft.value, multiplier: underlying.value.multiplier }
      suggestions.value = []
      searchStatus.value = ''
      saveDraft()
      void refreshSpot(item.code)
    }

    function addLeg() {
      const code = underlying.value.code.trim()
      const candidate = toLeg(legDraft.value)
      if (!code) {
        searchStatus.value = '请先输入或搜索期权标的代码。'
        return
      }
      if (!(candidate.strike > 0) || !(candidate.premium >= 0) || !candidate.expiration) {
        searchStatus.value = '请填写有效的行权价、到期日和权利金。'
        return
      }
      ensureCurrentStrategyIdentity()
      legs.value = [...legs.value, candidate]
      rememberExpiration(candidate.expiration)
      const affectedStrategyCount = synchronizeContractPremium(optionContractKey(code, candidate), candidate.premium)
      legDraft.value = { ...initialDraftLeg(), multiplier: underlying.value.multiplier }
      searchStatus.value = affectedStrategyCount > 1
        ? `已加入期权腿，并将相同合约的权利金同步更新到 ${affectedStrategyCount} 套当前/历史组合。`
        : '已加入期权腿。'
    }

    function removeLeg(id: string) {
      legs.value = legs.value.filter((leg) => leg.id !== id)
      saveDraft()
    }

    function selectExpiration(value: string) {
      legDraft.value = { ...legDraft.value, expiration: value }
    }

    function rememberExpiration(value: string) {
      const next = rememberRecentExpiration(recentExpirations.value, value)
      if (next !== recentExpirations.value) {
        recentExpirations.value = next
        localStorage.setItem(RECENT_EXPIRATIONS_KEY, JSON.stringify(next))
      }
    }

    function saveStrategy() {
      if (!underlying.value.code.trim() || legs.value.length === 0) {
        searchStatus.value = '至少添加一条期权腿后才能保存组合。'
        return
      }
      ensureCurrentStrategyIdentity()
      const item: Strategy = {
        id: currentStrategyId.value,
        sequence: currentStrategySequence.value ?? undefined,
        name: strategyDescription.value,
        isAutoName: !strategyName.value.trim(),
        savedAt: Date.now(),
        underlying: normalizeUnderlying(underlying.value),
        legs: legs.value,
      }
      history.value = [item, ...history.value.filter((existing) => existing.id !== item.id)].slice(0, 30)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
      searchStatus.value = '已保存到本机历史组合。'
    }

    function loadStrategy(item: Strategy) {
      underlying.value = normalizeUnderlying(item.underlying)
      legs.value = item.legs
      strategyName.value = item.isAutoName ? '' : item.name
      currentStrategyId.value = item.id
      currentStrategySequence.value = item.sequence ?? null
      ensureCurrentStrategyIdentity()
      legDraft.value = { ...initialDraftLeg(), multiplier: underlying.value.multiplier }
      saveDraft()
      searchStatus.value = `已载入「${item.name}」。`
    }

    function deleteStrategy(id: string) {
      history.value = history.value.filter((item) => item.id !== id)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
    }

    function clearCurrent() {
      legs.value = []
      strategyName.value = ''
      currentStrategyId.value = ''
      currentStrategySequence.value = null
      legDraft.value = { ...initialDraftLeg(), multiplier: underlying.value.multiplier }
      saveDraft()
    }

    function renderPayoffChart() {
      const element = document.getElementById('optionStrategyPayoffChart')
      if (!element || typeof echarts === 'undefined') return
      echarts.dispose(element)
      const strategies = chartableStrategies.value
      const range = payoffChartPriceRange(strategies, spot.value)
      if (!range) {
        echarts.init(element).setOption({ xAxis: { type: 'value', name: '标的到期价格' }, yAxis: { type: 'value', name: '到期收益率' }, series: [] })
        return
      }
      const [minimum, maximum] = range
      const pointCount = 121
      const step = (maximum - minimum) / (pointCount - 1)
      echarts.init(element).setOption({
        animation: false,
        tooltip: {
          trigger: 'axis',
          renderMode: 'richText',
          formatter: (points: Array<{ axisValue: number; data: [number, number]; seriesName: string }>) => [
            `标的到期价格：${formatUnderlyingPrice(points[0]?.axisValue ?? 0)}`,
            ...points.map((point) => `${point.seriesName}：${formatNumber(point.data[1])}%`),
          ].join('\n'),
        },
        legend: { type: 'scroll', top: 0 },
        grid: { left: 72, right: 28, top: 52, bottom: 58 },
        xAxis: { type: 'value', name: '标的到期价格', min: minimum, max: maximum, axisLabel: { formatter: (value: number) => formatUnderlyingPrice(value) } },
        yAxis: { type: 'value', name: '到期收益率', axisLabel: { formatter: (value: number) => `${formatNumber(value)}%` }, splitLine: { lineStyle: { color: '#e9ecef' } } },
        series: strategies.map((strategy) => ({
          name: strategy.name,
          type: 'line',
          showSymbol: false,
          data: Array.from({ length: pointCount }, (_, index) => {
            const price = minimum + step * index
            return [price, strategyReturnRateAtExpiry(strategy.legs, price) ?? 0]
          }),
          markLine: strategy.id === 'current' && spot.value > 0 ? {
            silent: true,
            symbol: 'none',
            data: [{ xAxis: spot.value, label: { formatter: '当前价' }, lineStyle: { type: 'dashed', color: '#6c757d' } }],
          } : undefined,
        })),
      })
    }

    onMounted(() => {
      const saved = restore<Strategy[]>(HISTORY_KEY, [])
      const restoredHistory = Array.isArray(saved) ? saved.filter((item) => item?.underlying && Array.isArray(item.legs)) : []
      let highestSequence = Math.max(0, ...restoredHistory.map((item) => number(item.sequence)))
      const normalizedHistory = restoredHistory.map((item) => {
        const hasSequence = number(item.sequence) > 0
        const normalized = {
          ...item,
          id: item.id || crypto.randomUUID(),
          sequence: hasSequence ? number(item.sequence) : ++highestSequence,
        }
        return normalized
      })
      history.value = normalizedHistory
      if (normalizedHistory.some((item, index) => item.id !== restoredHistory[index].id || item.sequence !== restoredHistory[index].sequence)) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(normalizedHistory))
      }
      nextStrategySequence.value = Math.max(highestSequence + 1, number(restore<unknown>(STRATEGY_SEQUENCE_KEY, 1)), 1)
      const savedExpirations = restore<unknown>(RECENT_EXPIRATIONS_KEY, [])
      recentExpirations.value = Array.isArray(savedExpirations)
        ? [...savedExpirations].slice(0, 10).reverse().reduce<string[]>((items, value) => rememberRecentExpiration(items, typeof value === 'string' ? value : ''), [])
        : []
      const draft = restore<{ underlying?: Underlying; legs?: StrategyLeg[]; strategyName?: string; currentStrategyId?: string; currentStrategySequence?: number }>(DRAFT_KEY, {})
      const codeFromUrl = new URLSearchParams(window.location.search).get('code') || ''
      if (draft.underlying) underlying.value = normalizeUnderlying(draft.underlying)
      if (Array.isArray(draft.legs)) legs.value = draft.legs
      if (typeof draft.strategyName === 'string') strategyName.value = draft.strategyName
      if (typeof draft.currentStrategyId === 'string') currentStrategyId.value = draft.currentStrategyId
      if (number(draft.currentStrategySequence) > 0) currentStrategySequence.value = number(draft.currentStrategySequence)
      if (codeFromUrl) underlying.value = normalizeUnderlying({ ...underlying.value, code: codeFromUrl, multiplier: inferMultiplier(codeFromUrl) })
      if (legs.value.length > 0) ensureCurrentStrategyIdentity()
      legDraft.value = { ...initialDraftLeg(), multiplier: underlying.value.multiplier }
      if (underlying.value.code) void refreshSpot(underlying.value.code)
      void nextTick(renderPayoffChart)
    })

    watch([legs, history, underlying, strategyName], () => void nextTick(renderPayoffChart), { deep: true })
    const onResize = () => void nextTick(renderPayoffChart)
    onMounted(() => window.addEventListener('resize', onResize))
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize)
      const element = document.getElementById('optionStrategyPayoffChart')
      if (element && typeof echarts !== 'undefined') echarts.dispose(element)
    })

    return () => {
      const currentMetrics = metrics.value
      return h('main', { class: 'option-strategy-page' }, [
        h('section', { class: 'mb-3' }, [
          h('div', { class: 'd-flex flex-wrap justify-content-between gap-2 align-items-end mb-2' }, [
            h('div', [h('h2', { class: 'h4 mb-1' }, '期权策略'), h('p', { class: 'text-muted small mb-0' }, '手工录入单腿，组合计算在浏览器本机完成；支持 A 股、港股和美股标的。')]),
            h('div', { class: 'd-flex gap-2' }, [
              h('button', { type: 'button', class: 'btn btn-outline-secondary btn-sm', onClick: clearCurrent }, '清空当前组合'),
              h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: saveStrategy }, '保存 / 更新历史'),
            ]),
          ]),
          h('div', { class: 'border rounded p-3 bg-white' }, [
            h('div', { class: 'row g-2' }, [
              h('div', { class: 'col-12 col-lg-4 position-relative' }, [
                h('label', { class: 'form-label mb-1', for: 'optionUnderlying' }, '标的代码 / 搜索'),
                h('input', { id: 'optionUnderlying', class: 'form-control form-control-sm', value: underlying.value.code, placeholder: '如 600519.SH、00700.HK、AAPL.US', autocomplete: 'off', onInput: (event: Event) => void searchUnderlying((event.target as HTMLInputElement).value) }),
                suggestions.value.length ? h('div', { class: 'list-group position-absolute w-100 shadow-sm', style: 'z-index: 10; max-height: 210px; overflow: auto;' }, suggestions.value.map((item) => h('button', { type: 'button', class: 'list-group-item list-group-item-action py-2', onClick: () => selectSuggestion(item) }, `${item.name} · ${item.code}`))) : null,
              ]),
              h('div', { class: 'col-12 col-md-4 col-lg-3' }, [h('label', { class: 'form-label mb-1' }, '标的名称（可选）'), h('input', { class: 'form-control form-control-sm', value: underlying.value.name, onInput: (event: Event) => updateUnderlying('name', (event.target as HTMLInputElement).value) })]),
              h('div', { class: 'col-6 col-md-4 col-lg-2' }, [
                h('label', { class: 'form-label mb-1' }, '当前价格（K 线）'),
                h('div', { class: 'input-group input-group-sm' }, [
                  h('input', { class: 'form-control text-end', value: spot.value > 0 ? formatUnderlyingPrice(spot.value) : '', placeholder: '自动获取', readonly: true }),
                  h('button', { type: 'button', class: 'btn btn-outline-secondary', disabled: !underlying.value.code.trim(), onClick: () => void refreshSpot() }, '刷新'),
                ]),
              ]),
              h('div', { class: 'col-6 col-md-4 col-lg-2' }, [h('label', { class: 'form-label mb-1' }, '默认合约乘数'), h('input', { class: 'form-control form-control-sm text-end', type: 'number', min: '1', step: '1', value: underlying.value.multiplier, onInput: (event: Event) => { const value = (event.target as HTMLInputElement).value; updateUnderlying('multiplier', value); legDraft.value = { ...legDraft.value, multiplier: value } } })]),
              h('div', { class: 'col-12 col-lg-1' }, [h('label', { class: 'form-label mb-1' }, '组合名称'), h('input', { class: 'form-control form-control-sm', value: strategyName.value, placeholder: '可选', onInput: (event: Event) => { strategyName.value = (event.target as HTMLInputElement).value; saveDraft() } })]),
            ]),
            h('div', { class: 'small text-muted mt-2' }, spotStatus.value || 'A 股代码默认乘数为 10,000，港股/美股默认 100；请以实际合约为准并可直接修改。'),
          ]),
        ]),
        h('section', { class: 'border rounded p-3 bg-white mb-3' }, [
          h('h3', { class: 'h6 mb-3' }, '添加期权腿'),
          h('div', { class: 'row g-2 align-items-end' }, [
            h('div', { class: 'col-6 col-md-2' }, [h('label', { class: 'form-label mb-1' }, '买卖'), h('select', { class: 'form-select form-select-sm', value: legDraft.value.side, onChange: (event: Event) => legDraft.value = { ...legDraft.value, side: (event.target as HTMLSelectElement).value as OptionSide } }, [h('option', { value: 'buy' }, '买入'), h('option', { value: 'sell' }, '卖出')])]),
            h('div', { class: 'col-6 col-md-2' }, [h('label', { class: 'form-label mb-1' }, 'Call / Put'), h('select', { class: 'form-select form-select-sm', value: legDraft.value.type, onChange: (event: Event) => legDraft.value = { ...legDraft.value, type: (event.target as HTMLSelectElement).value as OptionType } }, [h('option', { value: 'call' }, 'Call（认购）'), h('option', { value: 'put' }, 'Put（认沽）')])]),
            h('div', { class: 'col-6 col-md-2' }, [h('label', { class: 'form-label mb-1' }, '行权价'), h('input', { class: 'form-control form-control-sm text-end', type: 'text', inputmode: 'decimal', pattern: '[0-9]*\\.?[0-9]*', placeholder: '如 1.888', value: legDraft.value.strike, onInput: (event: Event) => legDraft.value = { ...legDraft.value, strike: (event.target as HTMLInputElement).value } })]),
            h('div', { class: 'col-12 col-md-3' }, [
              h('label', { class: 'form-label mb-1' }, '到期日'),
              h('div', { class: 'd-flex gap-1' }, [
                h('select', { class: 'form-select form-select-sm', value: legDraft.value.expiration, onChange: (event: Event) => selectExpiration((event.target as HTMLSelectElement).value) }, [
                  h('option', { value: '' }, '最近选择'),
                  ...recentExpirations.value.map((expiration) => h('option', { value: expiration }, expiration)),
                ]),
                h('input', { class: 'form-control form-control-sm', type: 'date', value: legDraft.value.expiration, onInput: (event: Event) => selectExpiration((event.target as HTMLInputElement).value) }),
              ]),
            ]),
            h('div', { class: 'col-6 col-md-2' }, [h('label', { class: 'form-label mb-1' }, '权利金 / 股'), h('input', { class: 'form-control form-control-sm text-end', type: 'text', inputmode: 'decimal', pattern: '[0-9]*\\.?[0-9]*', placeholder: '如 0.125', value: legDraft.value.premium, onInput: (event: Event) => legDraft.value = { ...legDraft.value, premium: (event.target as HTMLInputElement).value } })]),
            h('div', { class: 'col-3 col-md-1' }, [h('label', { class: 'form-label mb-1' }, '张数'), h('input', { class: 'form-control form-control-sm text-end', type: 'number', min: '1', step: '1', value: legDraft.value.quantity, onInput: (event: Event) => legDraft.value = { ...legDraft.value, quantity: (event.target as HTMLInputElement).value as unknown as number } })]),
            h('div', { class: 'col-3 col-md-1' }, [h('label', { class: 'form-label mb-1' }, '乘数'), h('input', { class: 'form-control form-control-sm text-end', type: 'number', min: '1', step: '1', value: legDraft.value.multiplier, onInput: (event: Event) => legDraft.value = { ...legDraft.value, multiplier: (event.target as HTMLInputElement).value as unknown as number } })]),
            h('div', { class: 'col-12 col-md-2' }, [h('button', { type: 'button', class: 'btn btn-success btn-sm w-100', onClick: addLeg }, '加入组合')]),
          ]),
          searchStatus.value ? h('div', { class: 'small text-muted mt-2', role: 'status' }, searchStatus.value) : null,
        ]),
        h('section', { class: 'mb-3' }, [
          h('div', { class: 'd-flex justify-content-between align-items-center mb-2' }, [h('h3', { class: 'h6 mb-0' }, `当前组合 · ${strategyTitle.value}`), h('span', { class: 'small text-muted' }, `${legs.value.length} 条期权腿`)]),
          h('div', { class: 'table-responsive border rounded bg-white' }, [
            h('table', { class: 'table table-sm align-middle mb-0' }, [
              h('thead', { class: 'table-light' }, [h('tr', ['买卖', '类型', '行权价', '权利金 / 股', '到期日', '行权距离', '时间价值/股', '剩余天数', '张数', '乘数', ''].map((label) => h('th', { class: label === '行权价' || label === '权利金 / 股' || label === '行权距离' || label === '时间价值/股' ? 'text-end' : '' }, label)))]),
              h('tbody', legs.value.length ? legs.value.map((leg) => {
                const distance = legMoneynessDistancePct(leg, spot.value)
                const timeValue = Math.max(0, leg.premium - intrinsicValue(leg.type, spot.value, leg.strike))
                return h('tr', { key: leg.id }, [
                  h('td', { class: leg.side === 'buy' ? 'text-danger' : 'text-success' }, leg.side === 'buy' ? '买入' : '卖出'),
                  h('td', leg.type.toUpperCase()), h('td', { class: 'text-end' }, formatNumber(leg.strike, 3)), h('td', { class: 'text-end' }, formatNumber(leg.premium, 4)), h('td', leg.expiration),
                  h('td', { class: 'text-end' }, distance === null ? '请填现价' : `${distance >= 0 ? '+' : ''}${formatNumber(distance)}%`), h('td', { class: 'text-end' }, spot.value > 0 ? formatNumber(timeValue, 4) : '请填现价'), h('td', String(daysToExpiry(leg.expiration) ?? '—')), h('td', String(leg.quantity)), h('td', String(leg.multiplier)),
                  h('td', [h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', onClick: () => removeLeg(leg.id) }, '移除')]),
                ])
              }) : [h('tr', [h('td', { class: 'text-center text-muted py-4', colspan: 11 }, '还没有期权腿。先填写上方表单并加入组合。')])]),
            ]),
          ]),
        ]),
        h('section', { class: 'mb-3' }, [
          h('h3', { class: 'h6 mb-2' }, '组合参考数据'),
          h('div', { class: 'row g-2' }, [
            metricCard('净权利金支出', formatNumber(currentMetrics.netPremiumCash), currentMetrics.netPremiumCash >= 0 ? '正数为净支出' : '负数为净收入'),
            metricCard('净时间成本', formatNumber(currentMetrics.timeCostCash), currentMetrics.timeCostCash >= 0 ? '正数为时间价值支出' : '负数为时间价值收入'),
            metricCard('时间成本年化', currentMetrics.timeCostAnnualized === null ? '—' : `${formatNumber(currentMetrics.timeCostAnnualized * 100)}%`, '按总权利金与最晚到期日估算'),
            metricCard('盈亏线', currentMetrics.breakevens.length ? currentMetrics.breakevens.map((item) => formatNumber(item, 3)).join(' / ') : '—', '到期收益为零的标的价格'),
            metricCard('最近盈亏距离', currentMetrics.nearestBreakevenDistancePct === null ? '—' : `${formatNumber(currentMetrics.nearestBreakevenDistancePct)}%`, '相对当前价格的绝对距离'),
            metricCard('到期剩余天数', currentMetrics.minimumDaysToExpiry === null ? '—' : currentMetrics.minimumDaysToExpiry === currentMetrics.maximumDaysToExpiry ? `${currentMetrics.minimumDaysToExpiry} 天` : `${currentMetrics.minimumDaysToExpiry}–${currentMetrics.maximumDaysToExpiry} 天`, '最近–最远到期日'),
            metricCard('到期剩余周数', currentMetrics.minimumWeeksToExpiry === null ? '—' : currentMetrics.minimumWeeksToExpiry === currentMetrics.maximumWeeksToExpiry ? `${formatNumber(currentMetrics.minimumWeeksToExpiry, 1)} 周` : `${formatNumber(currentMetrics.minimumWeeksToExpiry, 1)}–${formatNumber(currentMetrics.maximumWeeksToExpiry, 1)} 周`, '最近–最远到期日'),
            metricCard('标的当前价', spot.value > 0 ? formatUnderlyingPrice(spot.value) : '待输入', underlying.value.code || '请先填写标的代码'),
          ]),
          currentMetrics.mixedExpirations ? h('div', { class: 'alert alert-warning small py-2 mt-3 mb-0' }, '组合包含不同到期日；盈亏线使用“各腿在同一标的终值结算”的参考假设，不应替代逐日盯市或实际提前结算结果。') : null,
          h('p', { class: 'small text-muted mt-2 mb-0' }, '行权距离：Call 为行权价相对现价的距离，Put 为现价相对行权价的距离；正数代表价外。时间成本为权利金扣除内在价值后的净额。数据仅作策略测算，不构成投资建议。'),
        ]),
        h('section', { class: 'mb-3 border rounded p-3 bg-white' }, [
          h('div', { class: 'd-flex flex-wrap justify-content-between gap-2 align-items-baseline mb-2' }, [
            h('h3', { class: 'h6 mb-0' }, '组合到期收益率曲线'),
            h('span', { class: 'small text-muted' }, '当前组合 + 最近 10 个同标的历史组合'),
          ]),
          h('div', { id: 'optionStrategyPayoffChart', style: 'height: 420px; min-width: 300px;' }),
          h('p', { class: 'small text-muted mb-0' }, '纵轴为到期损益 ÷ 1.00 亿：按每个组合的净权利金支出，以原有各腿比例重复买入完整组合，最多使用 1.00 亿资金；余额按现金、收益率为 0 处理，币种与标的交易币种相同。'),
          chartStrategies.value.length === 0 ? h('p', { class: 'small text-muted mt-2 mb-0' }, '加入至少一条期权腿后显示到期收益率曲线。') : null,
          excludedChartStrategies.value > 0 ? h('p', { class: 'small text-warning mt-2 mb-0' }, `${excludedChartStrategies.value} 个净收权利金或零成本组合未纳入图表；该类策略需要保证金口径，不能按“投入 1.00 亿”直接计算收益率。`) : null,
        ]),
        h('section', { class: 'mb-3 border rounded p-3 bg-white' }, [
          h('div', { class: 'd-flex flex-wrap justify-content-between gap-2 align-items-baseline mb-2' }, [
            h('h3', { class: 'h6 mb-0' }, '期权权利金统一更新'),
            h('span', { class: 'small text-muted' }, `当前 + 历史去重后 ${premiumUpdateTargets.value.length} 个合约`),
          ]),
          h('p', { class: 'small text-muted mb-2' }, '这是唯一的权利金修改入口。按标的、Call/Put、行权价、到期日和乘数去重；买卖方向和张数不影响匹配。更新一次会同步当前组合及所有历史组合，并立即重算图表和参考数据。'),
          premiumUpdateTargets.value.length ? h('div', { class: 'table-responsive border rounded' }, [h('table', { class: 'table table-sm align-middle mb-0' }, [
            h('thead', { class: 'table-light' }, [h('tr', ['标的', '类型', '行权价', '到期日', '乘数', '现有权利金', '涉及组合', '新权利金 / 股', ''].map((label) => h('th', { class: ['行权价', '乘数', '现有权利金', '涉及组合', '新权利金 / 股'].includes(label) ? 'text-end' : '' }, label)))]),
            h('tbody', premiumUpdateTargets.value.map((target) => h('tr', { key: target.key }, [
              h('td', target.code),
              h('td', target.type.toUpperCase()),
              h('td', { class: 'text-end' }, formatNumber(target.strike, 3)),
              h('td', target.expiration),
              h('td', { class: 'text-end' }, String(target.multiplier)),
              h('td', { class: 'text-end' }, target.premiumValues.map((value) => formatNumber(value, 4)).join(' / ')),
              h('td', { class: 'text-end' }, `${target.strategyCount} 套`),
              h('td', { style: 'min-width: 170px;' }, [h('input', {
                class: 'form-control form-control-sm text-end',
                type: 'text',
                inputmode: 'decimal',
                pattern: '[0-9]*\\.?[0-9]*',
                placeholder: '输入新权利金',
                value: contractPremiumDrafts.value[target.key] ?? '',
                onInput: (event: Event) => contractPremiumDrafts.value = { ...contractPremiumDrafts.value, [target.key]: (event.target as HTMLInputElement).value },
                onKeyup: (event: KeyboardEvent) => { if (event.key === 'Enter') updateMatchingContractPremium(target) },
              })]),
              h('td', [h('button', { type: 'button', class: 'btn btn-sm btn-primary text-nowrap', onClick: () => updateMatchingContractPremium(target) }, `更新 ${target.strategyCount} 套`)]),
            ]))),
          ])]) : h('p', { class: 'small text-muted mb-0' }, '添加期权腿后，涉及的合约会在此去重汇总并统一更新。'),
        ]),
        h('section', { class: 'mt-4' }, [
          h('h3', { class: 'h6 mb-2' }, `历史组合（含当前 · ${historyRows.value.length}）`),
          h('div', { class: 'table-responsive border rounded bg-white' }, [h('table', { class: 'table table-sm align-middle mb-0' }, [
            h('thead', { class: 'table-light' }, [h('tr', ['编号', '名称 / 结构', '标的', '现价', '期权腿', '权利金支出', '盈亏线', '最近盈亏距离', '保存时间', ''].map((label) => h('th', { class: ['现价', '权利金支出', '盈亏线', '最近盈亏距离'].includes(label) ? 'text-end' : '' }, label)))]),
            h('tbody', historyRows.value.length ? historyRows.value.map((item) => {
              const itemMetrics = calculateStrategyMetrics(item.legs, number(item.underlying.spot))
              return h('tr', { key: `${item.isCurrent ? 'current-' : ''}${item.id}`, class: item.isCurrent ? 'table-primary' : '' }, [
                h('td', { class: 'text-nowrap fw-semibold' }, [strategyNumberLabel(item.sequence), item.isCurrent ? h('span', { class: 'badge text-bg-primary ms-1' }, '当前') : null]),
                h('td', { class: 'small', style: 'min-width: 260px;' }, item.name),
                h('td', `${item.underlying.name ? `${item.underlying.name} · ` : ''}${item.underlying.code}`),
                h('td', { class: 'text-end' }, formatUnderlyingPrice(number(item.underlying.spot))),
                h('td', { class: 'text-end' }, String(item.legs.length)),
                h('td', { class: `text-end ${itemMetrics.netPremiumCash >= 0 ? '' : 'text-success'}` }, formatNumber(itemMetrics.netPremiumCash)),
                h('td', { class: 'text-end text-nowrap' }, itemMetrics.breakevens.length ? itemMetrics.breakevens.map((point) => formatNumber(point, 3)).join(' / ') : '—'),
                h('td', { class: 'text-end' }, itemMetrics.nearestBreakevenDistancePct === null ? '—' : `${formatNumber(itemMetrics.nearestBreakevenDistancePct)}%`),
                h('td', { class: 'text-nowrap small' }, item.isCurrent ? '当前编辑中' : new Date(item.savedAt).toLocaleString('zh-CN')),
                h('td', { class: 'text-nowrap' }, item.isCurrent
                  ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', onClick: saveStrategy }, '保存')
                  : [h('button', { type: 'button', class: 'btn btn-sm btn-outline-primary me-2', onClick: () => loadStrategy(item) }, '载入'), h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', onClick: () => deleteStrategy(item.id) }, '删除')]),
              ])
            }) : [h('tr', [h('td', { class: 'text-center text-muted py-4', colspan: 10 }, '暂无组合。添加一条期权腿后，当前组合会自动显示在这里。')])]),
          ])]),
        ]),
      ])
    }
  },
})

const root = document.getElementById('option-strategy-vue-root')
if (root) createApp(OptionStrategyPage).mount(root)
