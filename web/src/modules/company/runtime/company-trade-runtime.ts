type CompanyTradeRuntimeContext = {
  getCode: () => string
  server?: string
  fetchRequest?: (request: {
    url?: string
    cacheKey?: string
    cacheTtl?: number
    silent?: boolean
    params?: Record<string, unknown>
  }) => Promise<unknown>
  fetchKline: (code: string, fq?: string) => Promise<unknown>
}

type CompanyTradeSnapshot = {
  code: string
  error?: string
  loading: boolean
  rows?: number[][]
}

export function createCompanyTradeInitializer(context: CompanyTradeRuntimeContext) {
  function emit(snapshot: CompanyTradeSnapshot): void {
    ;(window as typeof window & { __licaiCompanyTradeState?: CompanyTradeSnapshot }).__licaiCompanyTradeState = snapshot
    window.dispatchEvent(new CustomEvent('licai:company-trade-state', { detail: snapshot }))
  }

  return async function initCompanyTrade(): Promise<void> {
    const code = context.getCode()
    if (!code) {
      emit({ code: '', loading: false, error: '请先在地址中指定股票代码' })
      return
    }
    emit({ code, loading: true })
    try {
      const rows = await fetchTradeKline(context, code)
      if (!Array.isArray(rows)) throw new Error('K 线数据格式无效')
      emit({ code, loading: false, rows: rows as number[][] })
    } catch (error) {
      emit({ code, loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

async function fetchTradeKline(context: CompanyTradeRuntimeContext, code: string): Promise<unknown> {
  if (!context.fetchRequest) {
    return context.fetchKline(code, 'before')
  }
  const to = new Date().toISOString().slice(0, 10)
  const from = shiftYear(to, -1)
  return context.fetchRequest({
    url: `${context.server ?? ''}/api/kline`,
    cacheKey: `company-trade:${code}:qfq:${from}:${to}`,
    cacheTtl: 86400,
    silent: true,
    params: { code, period: 'day', fq: 'qfq', from, to },
  })
}

function shiftYear(date: string, amount: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year + amount, month - 1, day))
  if (shifted.getUTCMonth() !== month - 1) shifted.setUTCDate(0)
  return shifted.toISOString().slice(0, 10)
}
