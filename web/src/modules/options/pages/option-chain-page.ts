import { computed, createApp, defineComponent, h, onMounted, ref } from 'vue'
import { latestKlinePrice } from '../domain/latest-kline-price'
import {
  OPTION_UNDERLYINGS,
  annualizedPremiumYield,
  contractsFor,
  daysToExpiry,
  deltaBucket,
  expiryLabel,
  expirySummaries,
  formatNumber,
  formatPercent,
  formatSignedPercent,
  premiumPerDelta,
  premiumYieldOnStrike,
  volatilitySpread,
  type OptionChainContract,
  type OptionChainResponse,
  type OptionExpiration,
} from '../domain/option-chain'

const UNDERLYING_KEY = 'option-chain-underlying-v1'
const STORAGE_PREFIX = 'option-chain-selection-v2'

type ApiEnvelope<T> = { code: number; data: T; msg?: string }
type Kind = 'C' | 'P'

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  const body = (await response.json()) as ApiEnvelope<T>
  if (!response.ok || body.code !== 200) throw new Error(body.msg || `HTTP ${response.status}`)
  return body.data
}

function storedUnderlying(): string {
  try {
    const saved = window.localStorage.getItem(UNDERLYING_KEY)
    if (saved && OPTION_UNDERLYINGS.some((item) => item.code === saved)) return saved
  } catch {
    // Private-mode or blocked storage: fall back to the first underlying.
  }
  return OPTION_UNDERLYINGS[0].code
}

function storedExpiries(code: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}:${code}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null
  } catch {
    return null
  }
}

function saveExpiries(code: string, months: string[]): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}:${code}`, JSON.stringify(months))
  } catch {
    // Selection persistence is a convenience, never a requirement.
  }
}

/** Beijing calendar date: the option board's own timezone, not the browser's. */
function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

const OptionChainPage = defineComponent({
  name: 'OptionChainPage',
  setup() {
    const underlying = ref(storedUnderlying())
    const expirations = ref<OptionExpiration[]>([])
    const selected = ref<string[]>([])
    const chain = ref<OptionChainResponse | null>(null)
    const kind = ref<Kind>('P')
    const spotInput = ref('')
    const spotSource = ref('')
    const spotDate = ref<string | null>(null)
    const loadingExpirations = ref(false)
    const loadingChain = ref(false)
    const error = ref('')

    const underlyingMeta = computed(
      () => OPTION_UNDERLYINGS.find((item) => item.code === underlying.value) ?? OPTION_UNDERLYINGS[0],
    )

    const rows = computed(() =>
      chain.value ? contractsFor(chain.value.contracts, kind.value, selected.value) : [],
    )
    const priced = computed(() => rows.value.filter((row) => row.volatility !== null))
    /**
     * Contract IDs nearest the spot, one per expiry block. With several
     * expiries on screen a single ATM strike would be misleading, and recomputing
     * this per row would rescan the table once per rendered cell.
     */
    const atmIds = computed(() => {
      const spot = chain.value?.spot ?? 0
      const best = new Map<string, OptionChainContract>()
      if (!(spot > 0)) return new Set<string>()
      for (const row of rows.value) {
        const current = best.get(row.expiryMonth)
        if (!current || Math.abs(row.strike - spot) < Math.abs(current.strike - spot)) {
          best.set(row.expiryMonth, row)
        }
      }
      return new Set([...best.values()].map((row) => row.contractId))
    })
    const summaries = computed(() =>
      chain.value ? expirySummaries(chain.value.contracts, kind.value, selected.value, chain.value.spot) : [],
    )
    // A merged table spans expiries, so "the" forward and "the" ATM volatility
    // would be misleading; they are reported per expiry instead.
    const skew = computed(() => volatilitySpread(priced.value))
    const spotStale = computed(
      () => Boolean(spotDate.value && chain.value?.quoteDate && spotDate.value !== chain.value.quoteDate),
    )

    async function loadSpot(code: string): Promise<void> {
      const meta = OPTION_UNDERLYINGS.find((item) => item.code === code)
      const symbol = meta ? `${meta.code}.${meta.market}` : code
      try {
        const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
        const response = await fetch(
          `/api/kline?code=${encodeURIComponent(symbol)}&period=day&fq=normal&from=${from}&format=structured`,
        )
        const body = (await response.json()) as ApiEnvelope<unknown>
        if (!response.ok || body.code !== 200) throw new Error(body.msg || 'K 线读取失败')
        const latest = latestKlinePrice(body.data)
        if (!latest) throw new Error('K 线未返回有效收盘价')
        spotInput.value = String(latest.price)
        spotDate.value = latest.date || null
        spotSource.value = `标的收盘价${latest.date ? `（${latest.date}）` : ''}`
      } catch (failure) {
        spotInput.value = ''
        spotDate.value = null
        spotSource.value = `标的价不可用：${failure instanceof Error ? failure.message : '读取失败'}。可手动填写后再计算。`
      }
    }

    async function loadExpirations(code: string): Promise<void> {
      loadingExpirations.value = true
      try {
        const data = await fetchJson<{ expirations: OptionExpiration[] }>(
          `/api/options/cn/expirations?underlying=${encodeURIComponent(code)}`,
        )
        expirations.value = data.expirations
        const available = data.expirations.map((item) => item.expiryMonth)
        const wanted = (storedExpiries(code) ?? []).filter((month) => available.includes(month))
        // Default to the nearest expiry; more than one is an explicit choice.
        selected.value = wanted.length > 0 ? wanted : available.slice(0, 1)
      } catch (failure) {
        expirations.value = []
        selected.value = []
        throw failure
      } finally {
        loadingExpirations.value = false
      }
    }

    async function loadChain(): Promise<void> {
      if (selected.value.length === 0) return
      const spot = Number(spotInput.value)
      if (!Number.isFinite(spot) || spot <= 0) {
        error.value = '需要标的现价才能计算波动率；上方价格为空或无效。'
        return
      }
      loadingChain.value = true
      error.value = ''
      try {
        // asOf is sent only when the spot is known to belong to a session, so the
        // backend can otherwise date the board from the exchange snapshot.
        const asOf = spotDate.value ?? shanghaiToday()
        chain.value = await fetchJson<OptionChainResponse>(
          `/api/options/cn/chain?underlying=${encodeURIComponent(underlying.value)}&spot=${spot}&asOf=${asOf}`,
        )
      } catch (failure) {
        chain.value = null
        error.value = `期权链计算失败：${failure instanceof Error ? failure.message : '读取失败'}`
      } finally {
        loadingChain.value = false
      }
    }

    async function selectUnderlying(code: string): Promise<void> {
      underlying.value = code
      chain.value = null
      error.value = ''
      try {
        window.localStorage.setItem(UNDERLYING_KEY, code)
      } catch {
        // Ignored: persistence is optional.
      }
      await Promise.all([loadSpot(code), loadExpirations(code).catch(() => undefined)])
      await loadChain()
    }

    async function toggleExpiry(month: string): Promise<void> {
      const next = selected.value.includes(month)
        ? selected.value.filter((item) => item !== month)
        : [...selected.value, month]
      // An empty selection would blank the table with no explanation.
      if (next.length === 0) return
      selected.value = next.sort()
      saveExpiries(underlying.value, selected.value)
      await loadChain()
    }

    /** Selecting every expiry is one state change, not one request per month. */
    async function selectAllExpiries(): Promise<void> {
      selected.value = expirations.value.map((item) => item.expiryMonth).sort()
      saveExpiries(underlying.value, selected.value)
      await loadChain()
    }

    async function selectKind(next: Kind): Promise<void> {
      kind.value = next
    }

    onMounted(async () => {
      await Promise.all([loadSpot(underlying.value), loadExpirations(underlying.value).catch(() => undefined)])
      await loadChain()
    })

    const statusBadge = () => {
      if (loadingChain.value) return h('span', { class: 'badge text-bg-secondary' }, '计算中…')
      if (error.value) return h('span', { class: 'badge text-bg-danger' }, '计算失败')
      if (!chain.value) return h('span', { class: 'badge text-bg-light text-dark' }, '未计算')
      return h('span', { class: 'badge text-bg-success' }, '已计算')
    }

    const headerCell = (label: string, alignEnd = true, title?: string) =>
      h('th', { class: alignEnd ? 'text-end text-nowrap' : 'text-nowrap', title }, label)

    function moneynessLabel(row: OptionChainContract): string {
      const spot = chain.value?.spot ?? 0
      if (!(spot > 0)) return '—'
      const distance = row.kind === 'P' ? (row.strike - spot) / spot : (spot - row.strike) / spot
      const zone = distance >= 0 ? '价外' : '价内'
      return `${zone} ${formatSignedPercent(distance)}`
    }

    return {
      underlying, underlyingMeta, expirations, selected, chain, kind, spotInput, spotSource,
      spotDate, spotStale, loadingExpirations, loadingChain, error, rows, priced, summaries, skew, atmIds,
      selectUnderlying, toggleExpiry, selectKind, loadChain, statusBadge, headerCell,
      moneynessLabel, expiryLabel, selectAllExpiries,
    }
  },
  render() {
    const expiryButtons = h('div', { class: 'd-flex flex-wrap align-items-end gap-2 mb-3' }, [
      h('div', { class: 'small text-muted me-1 mb-1', id: 'optionChainExpiryLabel' }, '到期日（可多选）'),
      ...this.expirations.map((item) => {
        const active = this.selected.includes(item.expiryMonth)
        return h(
          'button',
          {
            type: 'button',
            class: `btn btn-sm ${active ? 'btn-primary' : 'btn-outline-secondary'}`,
            'aria-pressed': active ? 'true' : 'false',
            disabled: this.loadingExpirations,
            onClick: () => void this.toggleExpiry(item.expiryMonth),
          },
          `${item.expiry ?? item.expiryMonth}${item.daysToExpiry === null ? '' : `（${item.daysToExpiry}天）`}`,
        )
      }),
      this.expirations.length > 1
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-link text-decoration-none',
              disabled: this.loadingExpirations,
              onClick: () => void this.selectAllExpiries(),
            },
            '全选',
          )
        : null,
      this.expirations.length === 0 && !this.loadingExpirations
        ? h('span', { class: 'small text-muted mb-1' }, '该标的当前没有可取到的到期月份。')
        : null,
    ])

    const controlRow = h('div', { class: 'd-flex flex-wrap align-items-end gap-3 mb-3' }, [
      h('div', { style: 'min-width: 210px;' }, [
        h('label', { class: 'form-label small text-muted mb-1', for: 'optionChainUnderlying' }, '期权标的'),
        h(
          'select',
          {
            id: 'optionChainUnderlying',
            class: 'form-select form-select-sm',
            value: this.underlying,
            onChange: (event: Event) => void this.selectUnderlying((event.target as HTMLSelectElement).value),
          },
          OPTION_UNDERLYINGS.map((item) =>
            h('option', { value: item.code }, `${item.name} · ${item.code}${item.market === 'SZ' ? '（深）' : ''}`),
          ),
        ),
      ]),
      h('div', { class: 'btn-group btn-group-sm mb-1', role: 'group', 'aria-label': '看涨看跌' }, [
        h(
          'button',
          {
            type: 'button',
            class: `btn ${this.kind === 'P' ? 'btn-primary' : 'btn-outline-primary'}`,
            onClick: () => void this.selectKind('P'),
          },
          'Put（看跌）',
        ),
        h(
          'button',
          {
            type: 'button',
            class: `btn ${this.kind === 'C' ? 'btn-primary' : 'btn-outline-primary'}`,
            onClick: () => void this.selectKind('C'),
          },
          'Call（看涨）',
        ),
      ]),
      h('div', { style: 'min-width: 170px;' }, [
        h('label', { class: 'form-label small text-muted mb-1', for: 'optionChainSpot' }, '标的现价'),
        h('input', {
          id: 'optionChainSpot',
          class: 'form-control form-control-sm text-end',
          type: 'text',
          inputmode: 'decimal',
          value: this.spotInput,
          onInput: (event: Event) => { this.spotInput = (event.target as HTMLInputElement).value },
        }),
        this.spotSource ? h('div', { class: 'form-text mt-1' }, this.spotSource) : null,
      ]),
      h('div', { class: 'mb-1' }, [
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-primary',
            disabled: this.loadingChain || this.selected.length === 0,
            onClick: () => void this.loadChain(),
          },
          this.loadingChain ? '计算中…' : '重新计算',
        ),
      ]),
      h('div', { class: 'mb-2 ms-auto' }, this.statusBadge()),
    ])

    // Each expiry has its own forward and ATM volatility, so the summary is one
    // row per expiry rather than one card for a mix of them.
    const summary = this.chain
      ? h('div', { class: 'table-responsive mb-3' }, [
          h(
            'table',
            { class: 'table table-sm table-bordered align-middle mb-0 bg-white' },
            [
              h('thead', { class: 'table-light' }, [
                h('tr', [
                  this.headerCell('到期月', false),
                  this.headerCell('隐含远期'),
                  this.headerCell('定价口径', false),
                  this.headerCell('ATM 行权价'),
                  this.headerCell('ATM 隐含波动率'),
                  this.headerCell('波动率极差'),
                  this.headerCell('有效报价'),
                ]),
              ]),
              h(
                'tbody',
                this.summaries.map((item) =>
                  h('tr', [
                    h('td', { class: 'fw-semibold text-nowrap' }, item.label),
                    h('td', { class: 'text-end text-nowrap' }, formatNumber(item.forward, 4)),
                    h('td', { class: 'small text-muted text-nowrap' },
                      item.basis === 'forward' ? '远期（平价反解）' : item.basis === 'spot' ? '现货' : '—'),
                    h('td', { class: 'text-end text-nowrap' }, formatNumber(item.atmStrike, 4)),
                    h('td', { class: 'text-end text-nowrap fw-semibold' }, formatPercent(item.atmVolatility)),
                    h('td', { class: 'text-end text-nowrap' },
                      item.skew === null ? '—' : `${(item.skew * 100).toFixed(1)} 点`),
                    h('td', { class: 'text-end text-nowrap' }, `${item.priced} / ${item.total}`),
                  ]),
                ),
              ),
            ],
          ),
        ])
      : null

    const showExpiryColumn = this.selected.length > 1
    const table = h('div', { class: 'table-responsive border rounded bg-white' }, [
      h('table', { class: 'table table-sm table-hover align-middle mb-0' }, [
        h('thead', { class: 'table-light' }, [
          h('tr', [
            this.headerCell('行权价', false),
            showExpiryColumn ? this.headerCell('到期月', false) : null,
            this.headerCell('状态', false),
            this.headerCell('最新价'),
            this.headerCell('涨跌'),
            this.headerCell('隐含波动率'),
            this.headerCell('Delta'),
            this.headerCell('Theta/日'),
            this.headerCell('Vega/点'),
            this.headerCell('保本价'),
            this.headerCell('距现价'),
            this.headerCell('权利金/行权价'),
            this.headerCell('年化收益率'),
            this.headerCell('权利金/|Delta|', true, '每承担 1 单位 Delta 风险换来的权利金收益率'),
            this.headerCell('距到期(天)'),
          ].filter((cell): cell is NonNullable<typeof cell> => cell !== null)),
        ]),
        h('tbody', this.rows.length ? this.rows.map((row) => {
          const bucket = deltaBucket(row.delta)
          // One ATM strike per expiry block, computed once in `atmIds`.
          const atMoney = this.atmIds.has(row.contractId)
          return h('tr', { key: row.contractId, class: atMoney ? 'table-primary' : '' }, [
            h('td', { class: 'fw-semibold text-nowrap' }, [
              formatNumber(row.strike, 4),
              row.adjusted ? h('span', { class: 'badge text-bg-warning text-dark ms-1', title: '该系列因除权除息调整过，合约代码中的行权价仍是调整前数值；此处显示的是实际行权价' }, '已调整') : null,
            ]),
            showExpiryColumn ? h('td', { class: 'text-nowrap' }, expiryLabel(row)) : null,
            h('td', { class: 'text-nowrap' }, [
              bucket ? h('span', { class: 'badge text-bg-light text-dark border', title: bucket.hint }, bucket.label) : h('span', { class: 'text-muted small' }, '无报价'),
              h('span', { class: 'small text-muted ms-1' }, this.moneynessLabel(row)),
            ]),
            h('td', { class: 'text-end text-nowrap' }, formatNumber(row.last, 4)),
            h('td', { class: `text-end text-nowrap ${(row.changeRate ?? 0) >= 0 ? 'text-danger' : 'text-success'}` },
              row.changeRate === null ? '—' : `${row.changeRate > 0 ? '+' : ''}${row.changeRate.toFixed(2)}%`),
            h('td', { class: 'text-end text-nowrap fw-semibold' }, formatPercent(row.volatility)),
            h('td', { class: 'text-end text-nowrap' }, formatNumber(row.delta, 3)),
            h('td', { class: 'text-end text-nowrap' }, formatNumber(row.thetaPerDay, 5)),
            h('td', { class: 'text-end text-nowrap' }, formatNumber(row.vegaPerPoint, 5)),
            h('td', { class: 'text-end text-nowrap' }, formatNumber(row.breakeven, 4)),
            h('td', { class: 'text-end text-nowrap' }, formatSignedPercent(row.breakevenFromSpot)),
            h('td', { class: 'text-end text-nowrap' }, formatPercent(premiumYieldOnStrike(row), 2)),
            h('td', { class: 'text-end text-nowrap' }, formatPercent(annualizedPremiumYield(row), 1)),
            h('td', { class: 'text-end text-nowrap' }, formatNumber(premiumPerDelta(row), 2)),
            h('td', { class: 'text-end text-nowrap' }, daysToExpiry(row) === null ? '—' : String(daysToExpiry(row))),
          ].filter((cell): cell is NonNullable<typeof cell> => cell !== null))
        }) : [h('tr', [h('td', { class: 'text-center text-muted py-4', colspan: showExpiryColumn ? 15 : 14 }, '暂无合约数据。')])]),
      ]),
    ])

    return h('div', { class: 'container my-3' }, [
      h('div', { class: 'd-flex flex-wrap justify-content-between align-items-baseline gap-2 mb-2' }, [
        h('h1', { class: 'h4 mb-0' }, '期权链分析'),
        h('span', { class: 'small text-muted' },
          `${this.underlyingMeta.market === 'SZ' ? '深交所' : '上交所'} ETF 期权 · 价格为最后成交价${this.chain?.quoteDate ? `（${this.chain.quoteDate}）` : ''}`),
      ]),
      h(
        'p',
        { class: 'small text-muted' },
        '按行权价列出隐含波动率、Delta、每日 Theta、Vega、保本价与收益率，用于比较不同行权价的卖出性价比。可同时勾选多个到期月，每个到期月各自按 put-call parity 反解隐含远期——不同到期月的远期不同，因此汇总按到期月分行显示。波动率与希腊字母全部由本地 Rust 计算；缺失报价返回空值，不按 0 波动率处理。',
      ),
      controlRow,
      expiryButtons,
      this.error ? h('div', { class: 'alert alert-danger py-2 small' }, this.error) : null,
      this.spotStale
        ? h('div', { class: 'alert alert-warning py-2 small' },
            `标的收盘价为 ${this.spotDate}，而期权报价来自 ${this.chain?.quoteDate}；两者不是同一交易日，波动率不可用。请手动填入 ${this.chain?.quoteDate} 的标的收盘价后重新计算。`)
        : null,
      summary,
      table,
      h('p', { class: 'small text-muted mt-3 mb-0' },
        '说明：年化收益率 =（权利金 ÷ 行权价）÷ 剩余年数，是现金担保口径下的简化指标，未计入资金成本、手续费与保证金要求；权利金/|Delta| 是每单位 Delta 风险换得的权利金比例。Delta 分档仅是风险描述，不构成投资建议。'),
    ])
  },
})

const root = document.getElementById('option-chain-vue-root')
if (root) createApp(OptionChainPage).mount(root)
