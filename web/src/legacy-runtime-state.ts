export type LegacyReportsMap = Record<string, any[]>

export type LegacyPortfolioAssetData = {
  trend: any[]
  positions: any[]
  accountTotals: any[]
  trendWithoutIncomeExpense: any[]
  stockTrends: Record<string, any[]>
}

export type LegacyPortfolioStockInfo = Record<string, { code?: string, sector?: string }>

export type LegacyPortfolioUiState = {
  action: string
  candidateStatus: string
  candidateStatusError: boolean
  showZeroQuantity: boolean
  generateCandidatesPending: boolean
  addPositionPending: boolean
  confirmCandidatesPending: boolean
  accountOptions: string[]
  selectedAccount: string
  selectedTransferFromAccount: string
  selectedTransferCurrency: string
  stockOptions: string[]
  stockNameInput: string
  quantityInput: string
  amountInput: string
}

export type LegacyRuntimeState = {
  cache: Record<string, unknown>
  code: string
  klineCodes: string[]
  selectedCodes: string[]
  markPoints: unknown[]
  codeNameMap: Record<string, string>
  reportsMap: LegacyReportsMap
  securities: string[][]
  assetDataCache: LegacyPortfolioAssetData | null
  portfolioStockInfoCache: LegacyPortfolioStockInfo | null
  portfolioTargetCashDeltas: Map<string, number>
  portfolioUiState: LegacyPortfolioUiState
  etfCodes: Array<{ code: string, name?: string }>
}

export function createLegacyRuntimeState(): LegacyRuntimeState {
  return {
    cache: {},
    code: '',
    klineCodes: [],
    selectedCodes: [],
    markPoints: [],
    codeNameMap: {
      'PDD.US': '拼多多',
    },
    reportsMap: {},
    securities: [],
    assetDataCache: null,
    portfolioStockInfoCache: null,
    portfolioTargetCashDeltas: new Map<string, number>(),
    portfolioUiState: {
      action: 'position',
      candidateStatus: '',
      candidateStatusError: false,
      showZeroQuantity: false,
      generateCandidatesPending: false,
      addPositionPending: false,
      confirmCandidatesPending: false,
      accountOptions: [],
      selectedAccount: '',
      selectedTransferFromAccount: '',
      selectedTransferCurrency: 'CNY',
      stockOptions: [],
      stockNameInput: '',
      quantityInput: '',
      amountInput: '',
    },
    etfCodes: [],
  }
}

export function replaceArrayItems<T>(target: T[], next: T[]): void {
  target.splice(0, target.length, ...next)
}

export function replaceRecordItems<T extends Record<string, any>>(target: T, next: T): void {
  for (const key of Object.keys(target)) {
    delete target[key]
  }
  Object.assign(target, next)
}

export function replaceMapItems<K, V>(target: Map<K, V>, next: Map<K, V>): void {
  target.clear()
  next.forEach((value, key) => {
    target.set(key, value)
  })
}
