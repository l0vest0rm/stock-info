import type {
  LegacyPortfolioAssetData,
  LegacyPortfolioStockInfo,
  LegacyRuntimeState,
} from '../../../platform/legacy/legacy-runtime-state'
import { replaceMapItems } from '../../../platform/legacy/legacy-runtime-state'

export type PortfolioPosition = {
  account: string
  currency: string
  stockName: string
  quantity: number
  marketValue: number
  rmbValue: number
  exposureRmbValue: number
  proportion: number
  costPerShare: number
  currentPrice: number
  profitLossRatio: number
  sector?: string
}

type AssetTrend = {
  date: string
  totalAsset: number
}

export type PortfolioAccountTotal = {
  account: string
  currency: string
  cash: number
  holdings: number
  originalTotalAsset: number
  totalAsset: number
  proportion: number
}

type PortfolioTransaction = {
  id?: string
  status: string
  type: string
  date: string
  account: string
  stockName: string
  currency: string
  quantityDelta?: number
  amount?: number
  fee?: number
  cashEffect?: number
  relatedAccount?: string
  remark: string
}

type PortfolioRuntimeContext = {
  runtimeState: LegacyRuntimeState
  selectedOptionValues: (element: Element | null) => string[]
  fetchKlines: (codes: string[], fq: string, callback: (codes: string[]) => void) => void
  rerenderMyChart: (fq?: string) => void
  bsTable: (tableId: string, config: any) => void
}

export type PortfolioRuntime = {
  onPortfolioCodeSelectChange: () => void
  renderPortfolioChart: (data?: LegacyPortfolioAssetData) => void
  setupPortfolioTransactionControls: () => void
  updatePortfolioAddActionMode: () => void
  loadPortfolioStockInfo: () => Promise<LegacyPortfolioStockInfo>
  fillPortfolioStockOptions: (stockInfo: LegacyPortfolioStockInfo) => void
  setPortfolioCandidateStatus: (message: string, isError?: boolean) => void
  renderPortfolioUiState: (patch: any) => void
  clearAssetDataCache: () => void
  calculateAssetData: () => Promise<LegacyPortfolioAssetData>
  fillPortfolioAccountOptionsFromTotals: (accountTotals: PortfolioAccountTotal[]) => void
  prepareChartData: (data?: LegacyPortfolioAssetData, callback?: () => void) => Promise<void>
  renderPositionTableWithData: (positions: PortfolioPosition[]) => void
  renderStockPositionTableWithData: (positions: PortfolioPosition[]) => void
  renderSectorTableWithData: (positions: PortfolioPosition[]) => void
  renderAccountTotalTableWithData: (accountTotals: PortfolioAccountTotal[]) => void
}

const portfolioCalculateTimeoutMs = 120_000
const portfolioCashStockNames = new Set(['CNY', 'USD', 'HKD', 'USDT'])

function emitPortfolioUiState(uiState: any): boolean {
  window.dispatchEvent(new CustomEvent('licai:portfolio-ui-state', { detail: { uiState } }))
  return true
}

function portfolioEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function portfolioRound2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function portfolioTradeCashEffect(quantityDelta: number, amount: number, fee: number): number {
  if (quantityDelta > 0) {
    return portfolioRound2(-(amount + fee))
  }
  return portfolioRound2(amount - fee)
}

function portfolioCashKey(account: string, currency: string): string {
  return `${account}\u0000${currency}`
}

function portfolioInputNumber(input: HTMLInputElement | null): number {
  if (!input) {
    return 0
  }
  const value = Number(input.value)
  return Number.isFinite(value) ? value : 0
}

function portfolioIsOptionName(stockName: string): boolean {
  return stockName.includes('--')
}

export function createPortfolioRuntime(context: PortfolioRuntimeContext): PortfolioRuntime {
  const { runtimeState, selectedOptionValues, fetchKlines, rerenderMyChart, bsTable } = context
  const cache = runtimeState.cache as Record<string, any>
  const klineCodes = runtimeState.klineCodes
  const codeNameMap = runtimeState.codeNameMap

  async function calculateAssetData(): Promise<LegacyPortfolioAssetData> {
    if (runtimeState.assetDataCache) {
      return runtimeState.assetDataCache
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), portfolioCalculateTimeoutMs)

    try {
      const response = await fetch('/api/portfolio/calculate', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      })

      const result = await response.json()
      if (result.code === 200) {
        runtimeState.assetDataCache = result.data
        return result.data
      }

      const message = result?.msg || `Portfolio calculate failed with code ${result?.code ?? response.status}`
      console.error('Failed to calculate asset data:', result)
      throw new Error(message)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.error(`Portfolio calculate request timed out after ${portfolioCalculateTimeoutMs}ms`)
        throw new Error(`资产计算超时，${portfolioCalculateTimeoutMs / 1000} 秒内未返回`)
      }
      console.error('Failed to calculate asset data:', error)
      throw error
    } finally {
      window.clearTimeout(timeoutId)
    }
  }

  function clearAssetDataCache() {
    runtimeState.assetDataCache = null
  }

  async function prepareChartData(data?: LegacyPortfolioAssetData, callback?: () => void) {
    const assetData = data || await calculateAssetData()
    const { trend, trendWithoutIncomeExpense } = assetData
    const portfolioCode = 'PORTFOLIO.TOTAL'
    const portfolioCodeWithoutIncomeExpense = 'PORTFOLIO.TOTAL.WITHOUT_INCOME_EXPENSE'
    const selectedCodes = selectedOptionValues(document.getElementById('codes'))

    klineCodes.length = 0
    klineCodes.push(portfolioCode)
    klineCodes.push(portfolioCodeWithoutIncomeExpense)

    codeNameMap[portfolioCode] = '总资产'
    cache[portfolioCode + 'normal'] = trend.map((item: AssetTrend) => {
      const date = new Date(item.date)
      return [date.getTime(), item.totalAsset]
    })

    codeNameMap[portfolioCodeWithoutIncomeExpense] = '净资产'
    cache[portfolioCodeWithoutIncomeExpense + 'normal'] = trendWithoutIncomeExpense.map((item: AssetTrend) => {
      const date = new Date(item.date)
      return [date.getTime(), item.totalAsset]
    })

    if (selectedCodes && selectedCodes.length > 0) {
      const codesToFetch = selectedCodes.filter((code) => !cache[code] || (cache[code] as any[]).length === 0)
      klineCodes.push(...selectedCodes)

      if (codesToFetch.length > 0) {
        console.log('Fetching data for codes:', codesToFetch)
        fetchKlines(codesToFetch, 'normal', () => {
          console.log('Fetched data for codes:', codesToFetch)
          console.log('klineCodes after fetch:', klineCodes)
          if (callback) {
            callback()
          }
        })
      } else {
        console.log('All codes already in cache:', selectedCodes)
        console.log('klineCodes:', klineCodes)
        if (callback) {
          callback()
        }
      }
    } else {
      console.log('No codes selected')
      console.log('klineCodes:', klineCodes)
      if (callback) {
        callback()
      }
    }
  }

  function renderPortfolioChart(data?: LegacyPortfolioAssetData) {
    prepareChartData(data, () => {
      rerenderMyChart('normal')
    })
  }

  function onPortfolioCodeSelectChange() {
    renderPortfolioChart()
  }

  function renderPortfolioUiState(patch: any) {
    Object.assign(runtimeState.portfolioUiState, patch || {})
    emitPortfolioUiState(patch || {})
  }

  async function loadPortfolioStockInfo(): Promise<LegacyPortfolioStockInfo> {
    if (runtimeState.portfolioStockInfoCache) {
      return runtimeState.portfolioStockInfoCache as LegacyPortfolioStockInfo
    }
    const response = await fetch('/api/stock-info')
    const result = await response.json()
    if (result.code !== 200) {
      throw new Error(result?.msg || '加载股票信息失败')
    }
    const stockInfo = (result.data || {}) as LegacyPortfolioStockInfo
    runtimeState.portfolioStockInfoCache = stockInfo
    return stockInfo
  }

  function fillPortfolioStockOptions(stockInfo: LegacyPortfolioStockInfo) {
    renderPortfolioUiState({
      stockOptions: Object.keys(stockInfo).sort((a, b) => a.localeCompare(b)),
    })
  }

  function fillPortfolioAccountOptions(positions: PortfolioPosition[]) {
    fillPortfolioAccountSelect(positions.filter((item) => item.account !== '汇总').map((item) => item.account))
  }

  function fillPortfolioAccountOptionsFromTotals(accountTotals: PortfolioAccountTotal[]) {
    fillPortfolioAccountSelect(accountTotals.filter((item) => item.account !== '汇总').map((item) => item.account))
  }

  function fillPortfolioAccountSelect(accounts: string[]) {
    const select = document.getElementById('portfolioNewAccount') as HTMLSelectElement | null
    const transferFromSelect = document.getElementById('portfolioTransferFromAccount') as HTMLSelectElement | null
    if (!select) {
      return
    }
    const currentValue = select.value
    const currentTransferFromValue = transferFromSelect?.value || ''
    const uniqueAccounts = Array.from(new Set(accounts.filter(Boolean))).sort((a, b) => a.localeCompare(b))
    renderPortfolioUiState({
      accountOptions: uniqueAccounts,
      selectedAccount: uniqueAccounts.includes(currentValue) ? currentValue : (uniqueAccounts[0] || ''),
      selectedTransferFromAccount: uniqueAccounts.includes(currentTransferFromValue) ? currentTransferFromValue : (uniqueAccounts[0] || ''),
    })
  }

  function portfolioInferCurrency(stockName: string, info: LegacyPortfolioStockInfo): string {
    if (['CNY', 'USD', 'HKD', 'USDT'].includes(stockName)) {
      return stockName
    }
    if (stockName === 'BTC' || stockName === 'ETH') {
      return 'USDT'
    }
    if (stockName.includes('--')) {
      return 'USD'
    }
    const code = (info[stockName]?.code || '').toUpperCase()
    if (code.endsWith('.SZ') || code.endsWith('.SH')) {
      return 'CNY'
    }
    if (code.endsWith('.US')) {
      return 'USD'
    }
    if (code.endsWith('.HK')) {
      return 'HKD'
    }
    if (code.endsWith('.DC')) {
      return 'USDT'
    }
    return ''
  }

  function portfolioInferSector(stockName: string, info: LegacyPortfolioStockInfo): string {
    if (info[stockName]?.sector) {
      return info[stockName].sector
    }
    if (!portfolioIsOptionName(stockName)) {
      return ''
    }
    const symbol = stockName.split('--', 1)[0].toUpperCase()
    const underlying = Object.values(info).find((item) => {
      return (item.code || '').toUpperCase().startsWith(symbol)
    })
    return underlying?.sector || '期权'
  }

  function portfolioPositionEditCellHTML(position: { account: string, stockName: string, currency: string, quantity: number, currentPrice: number, originalQuantity?: number }) {
    const originalQuantity = position.originalQuantity ?? position.quantity
    const changedClass = Math.abs(position.quantity - originalQuantity) > 0.0000001 ? ' table-warning fw-semibold' : ''
    return `<td class="portfolio-target-quantity text-end${changedClass}" contenteditable="true" data-account="${portfolioEscape(position.account)}" data-stock-name="${portfolioEscape(position.stockName)}" data-currency="${portfolioEscape(position.currency)}" data-current-price="${position.currentPrice}" data-original-quantity="${originalQuantity}">${position.quantity}</td>`
  }

  function portfolioPositionAmountCellHTML(amount = 0) {
    const text = amount > 0 ? String(amount) : ''
    return `<td class="portfolio-target-amount text-end" contenteditable="true">${portfolioEscape(text)}</td>`
  }

  function portfolioEditableCellNumber(cell: HTMLElement): number {
    const value = Number((cell.textContent || '').trim())
    return Number.isFinite(value) ? value : 0
  }

  function updatePortfolioQuantityMarker(cell: HTMLElement) {
    const originalQuantity = Number(cell.dataset.originalQuantity || 0)
    const currentQuantity = portfolioEditableCellNumber(cell)
    const changed = Number.isFinite(currentQuantity) && Math.abs(currentQuantity - originalQuantity) > 0.0000001
    cell.classList.toggle('table-warning', changed)
    cell.classList.toggle('fw-semibold', changed)
  }

  function updatePortfolioAmountMarker(cell: HTMLElement) {
    const amount = portfolioEditableCellNumber(cell)
    const changed = Number.isFinite(amount) && amount > 0
    cell.classList.toggle('table-warning', changed)
    cell.classList.toggle('fw-semibold', changed)
  }

  function updatePortfolioAddActionMode() {
    const action = (document.getElementById('portfolioAddAction') as HTMLSelectElement | null)?.value || 'position'
    renderPortfolioUiState({
      action: action === 'transfer' ? 'transfer' : 'position',
    })
  }

  function setPortfolioCandidateStatus(message: string, isError = false) {
    renderPortfolioUiState({
      candidateStatus: message,
      candidateStatusError: isError,
    })
  }

  async function addPortfolioPositionRow() {
    const action = (document.getElementById('portfolioAddAction') as HTMLSelectElement | null)?.value || 'position'
    if (action === 'transfer') {
      addPortfolioTransferCandidate()
      return
    }
    const stockInfo = await loadPortfolioStockInfo()
    const account = (document.getElementById('portfolioNewAccount') as HTMLSelectElement | null)?.value || ''
    const stockNameInput = document.getElementById('portfolioNewStockName') as HTMLInputElement | null
    const quantityInput = document.getElementById('portfolioNewQuantity') as HTMLInputElement | null
    const amountInput = document.getElementById('portfolioNewAmount') as HTMLInputElement | null
    const stockName = stockNameInput?.value.trim() || ''
    const quantity = portfolioInputNumber(quantityInput)
    const amount = portfolioInputNumber(amountInput)
    if (!account || !stockName) {
      throw new Error('账户和股票不能为空')
    }
    if (amount <= 0) {
      throw new Error('新增持仓必须填写交易金额')
    }
    if (!stockInfo[stockName] && !portfolioIsOptionName(stockName)) {
      throw new Error('新增股票必须先存在于 stock-info.json')
    }
    const existingCell = Array.from(document.querySelectorAll<HTMLElement>('.portfolio-target-quantity')).find((cell) => {
      return cell.dataset.account === account && cell.dataset.stockName === stockName
    })
    if (existingCell) {
      existingCell.textContent = String(quantity)
      updatePortfolioQuantityMarker(existingCell)
      const amountCell = existingCell.closest('tr')?.querySelector<HTMLElement>('.portfolio-target-amount')
      if (amountCell) {
        amountCell.textContent = String(amount)
        updatePortfolioAmountMarker(amountCell)
      }
      setPortfolioCandidateStatus('已更新现有持仓目标数量')
      return
    }
    const currency = portfolioInferCurrency(stockName, stockInfo)
    if (!currency) {
      throw new Error('无法识别新增股票币种')
    }
    const tbody = document.querySelector('#portfolioTable tbody')
    if (!tbody) {
      return
    }
    const row = document.createElement('tr')
    row.className = 'table-warning'
    row.innerHTML = `
      <td>${portfolioEscape(account)}</td>
      <td>${portfolioEscape(portfolioInferSector(stockName, stockInfo))}</td>
      <td>${portfolioEscape(stockName)}</td>
      <td>${portfolioEscape(currency)}</td>
      ${portfolioPositionEditCellHTML({ account, stockName, currency, quantity, currentPrice: 0, originalQuantity: 0 })}
      ${portfolioPositionAmountCellHTML(amount)}
      <td>0.00</td>
      <td>0.00</td>
      <td>0.00</td>
      <td>0.00</td>
      <td>0.00</td>
      <td>0.00</td>
      <td>0.00%</td>
    `
    const summaryRow = tbody.querySelector('tr.table-dark')
    if (summaryRow) {
      tbody.insertBefore(row, summaryRow)
    } else {
      tbody.appendChild(row)
    }
    if (stockNameInput) {
      renderPortfolioUiState({
        stockNameInput: '',
        quantityInput: '',
        amountInput: '',
      })
    }
    setPortfolioCandidateStatus('已新增持仓编辑行')
  }

  function addPortfolioTransferCandidate() {
    const toAccount = (document.getElementById('portfolioNewAccount') as HTMLSelectElement | null)?.value || ''
    const fromAccount = (document.getElementById('portfolioTransferFromAccount') as HTMLSelectElement | null)?.value || ''
    const currency = (document.getElementById('portfolioTransferCurrency') as HTMLSelectElement | null)?.value || 'CNY'
    const amountInput = document.getElementById('portfolioNewQuantity') as HTMLInputElement | null
    const amount = portfolioInputNumber(amountInput)
    if (!toAccount || !fromAccount || toAccount === fromAccount) {
      throw new Error('转入账户和转出账户不能为空且不能相同')
    }
    if (amount <= 0) {
      throw new Error('转账金额必须大于0')
    }
    const tbody = document.querySelector('#portfolioCandidateTable tbody')
    if (!tbody) {
      return
    }
    const today = new Date().toISOString().slice(0, 10)
    tbody.appendChild(createPortfolioCandidateRow({
      id: `draft-transfer-${Date.now()}`,
      status: 'draft',
      type: 'transfer',
      date: today,
      account: toAccount,
      stockName: currency,
      currency,
      quantityDelta: 0,
      amount: 0,
      fee: 0,
      cashEffect: amount,
      relatedAccount: fromAccount,
      remark: `${fromAccount} -> ${toAccount}`,
    }))
    if (amountInput) {
      renderPortfolioUiState({
        quantityInput: '',
      })
    }
    setPortfolioCandidateStatus('已新增账户转账候选记录')
  }

  function collectPortfolioTargets() {
    return Array.from(document.querySelectorAll<HTMLElement>('.portfolio-target-quantity')).map((cell) => {
      const amountCell = cell.closest('tr')?.querySelector<HTMLElement>('.portfolio-target-amount')
      return {
        account: cell.dataset.account || '',
        stockName: cell.dataset.stockName || '',
        currency: cell.dataset.currency || '',
        quantity: portfolioEditableCellNumber(cell),
        currentPrice: Number(cell.dataset.currentPrice || 0),
        amount: amountCell ? portfolioEditableCellNumber(amountCell) : 0,
      }
    }).filter((item) => item.account && item.stockName && Number.isFinite(item.quantity))
  }

  function collectPortfolioTargetCashDeltas() {
    const result = new Map<string, number>()
    Array.from(document.querySelectorAll<HTMLElement>('.portfolio-target-quantity')).forEach((cell) => {
      const stockName = cell.dataset.stockName || ''
      if (!portfolioCashStockNames.has(stockName)) {
        return
      }
      const account = cell.dataset.account || ''
      const currency = cell.dataset.currency || stockName
      const originalQuantity = Number(cell.dataset.originalQuantity || 0)
      const currentQuantity = portfolioEditableCellNumber(cell)
      const delta = portfolioRound2(currentQuantity - originalQuantity)
      if (account && currency && Math.abs(delta) > 0.0000001) {
        result.set(portfolioCashKey(account, currency), delta)
      }
    })
    return result
  }

  async function generatePortfolioTransactionCandidates() {
    setPortfolioCandidateStatus('正在生成候选交易...')
    const targets = collectPortfolioTargets()
    replaceMapItems(runtimeState.portfolioTargetCashDeltas, collectPortfolioTargetCashDeltas())
    const response = await fetch('/api/portfolio/transaction-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: targets }),
    })
    const result = await response.json()
    if (result.code !== 200) {
      throw new Error(result?.msg || '生成候选交易失败')
    }
    renderPortfolioCandidateTable(result.data || [])
    setPortfolioCandidateStatus(`已生成 ${(result.data || []).length} 条候选交易`)
  }

  function renderPortfolioCandidateTable(candidates: PortfolioTransaction[]) {
    const tbody = document.querySelector('#portfolioCandidateTable tbody')
    if (!tbody) {
      return
    }
    tbody.innerHTML = ''
    candidates.forEach((candidate) => {
      tbody.appendChild(createPortfolioCandidateRow(candidate))
    })
  }

  function createPortfolioCandidateRow(candidate: PortfolioTransaction): HTMLTableRowElement {
    const row = document.createElement('tr')
    row.dataset.id = candidate.id || ''
    row.dataset.type = candidate.type
    row.dataset.account = candidate.account
    row.dataset.stockName = candidate.stockName
    row.dataset.currency = candidate.currency
    row.dataset.quantityDelta = String(candidate.quantityDelta || 0)
    row.dataset.relatedAccount = candidate.relatedAccount || ''
    if (candidate.type === 'cash_adjustment' && candidate.remark === '现金差额校准') {
      row.dataset.managedCashAdjustment = '1'
    }
    row.innerHTML = `
      <td><input class="form-control form-control-sm portfolio-candidate-date" type="date" value="${portfolioEscape(candidate.date)}"></td>
      <td>${portfolioCandidateTypeSelectHTML(candidate.type)}</td>
      <td>${portfolioEscape(candidate.account)}</td>
      <td>${portfolioEscape(candidate.stockName)}</td>
      <td>${portfolioEscape(candidate.currency)}</td>
      <td>${candidate.quantityDelta || 0}</td>
      <td><input class="form-control form-control-sm portfolio-candidate-amount" type="number" step="0.01" value="${portfolioCandidateAmountValue(candidate)}"></td>
      <td><input class="form-control form-control-sm portfolio-candidate-fee" type="number" step="0.01" value="${candidate.fee || 0}"></td>
      <td><input class="form-control form-control-sm portfolio-candidate-cash-effect" type="number" step="0.01" value="${candidate.cashEffect || 0}"></td>
      <td><input class="form-control form-control-sm portfolio-candidate-remark" value="${portfolioEscape(candidate.remark || '')}"></td>
    `
    return row
  }

  function portfolioCandidateAmountValue(candidate: PortfolioTransaction): number {
    if ((candidate.type === 'cash_adjustment' || candidate.type === 'income_expense') && !candidate.amount) {
      return candidate.cashEffect || 0
    }
    return candidate.amount || 0
  }

  function portfolioCandidateTypeSelectHTML(type: string): string {
    const types = ['trade', 'cash_adjustment', 'income_expense', 'transfer', 'cash_balance']
    return `<select class="form-select form-select-sm portfolio-candidate-type">${types.map((item) => {
      return `<option value="${item}"${item === type ? ' selected' : ''}>${item}</option>`
    }).join('')}</select>`
  }

  function portfolioCandidateRowType(row: HTMLTableRowElement): string {
    return row.querySelector<HTMLSelectElement>('.portfolio-candidate-type')?.value || row.dataset.type || ''
  }

  function isPortfolioAdjustmentType(type: string): boolean {
    return type === 'cash_adjustment' || type === 'income_expense'
  }

  function isPortfolioAdjustmentRow(row: HTMLTableRowElement): boolean {
    return isPortfolioAdjustmentType(portfolioCandidateRowType(row))
  }

  function syncPortfolioAdjustmentCashEffectFromAmount(row: HTMLTableRowElement) {
    const cashEffectInput = row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect')
    if (cashEffectInput) {
      cashEffectInput.value = String(portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-amount')))
    }
  }

  function syncPortfolioAdjustmentAmountFromCashEffect(row: HTMLTableRowElement) {
    const amountInput = row.querySelector<HTMLInputElement>('.portfolio-candidate-amount')
    if (amountInput) {
      amountInput.value = String(portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect')))
    }
  }

  function updatePortfolioCandidateCashEffect(row: HTMLTableRowElement) {
    if (portfolioCandidateRowType(row) !== 'trade') {
      return
    }
    const quantityDelta = Number(row.dataset.quantityDelta || 0)
    const amount = portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-amount'))
    const fee = portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-fee'))
    const cashEffectInput = row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect')
    if (cashEffectInput) {
      cashEffectInput.value = String(portfolioTradeCashEffect(quantityDelta, amount, fee))
    }
  }

  function updatePortfolioCandidateFeeFromCashEffect(row: HTMLTableRowElement) {
    if (portfolioCandidateRowType(row) !== 'trade') {
      return
    }
    const quantityDelta = Number(row.dataset.quantityDelta || 0)
    const amount = Math.abs(portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-amount')))
    const cashEffect = portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect'))
    const feeInput = row.querySelector<HTMLInputElement>('.portfolio-candidate-fee')
    if (!feeInput) {
      return
    }
    let fee = 0
    if (quantityDelta > 0) {
      fee = Math.abs(cashEffect) - amount
    } else if (quantityDelta < 0) {
      fee = amount - cashEffect
    }
    feeInput.value = String(Math.max(0, portfolioRound2(fee)))
  }

  function portfolioCandidateRowsForAccountCurrency(account: string, currency: string): HTMLTableRowElement[] {
    return Array.from(document.querySelectorAll<HTMLTableRowElement>('#portfolioCandidateTable tbody tr')).filter((row) => {
      return row.dataset.account === account && row.dataset.currency === currency
    })
  }

  function updatePortfolioManagedCashAdjustment(changedRow: HTMLTableRowElement, rows: HTMLTableRowElement[], account: string, currency: string, residual: number) {
    const managedAdjustment = rows.find((row) => row.dataset.managedCashAdjustment === '1')
    if (managedAdjustment) {
      if (Math.abs(residual) <= 0.0000001) {
        managedAdjustment.remove()
        return
      }
      const input = managedAdjustment.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect')
      if (input) {
        input.value = String(residual)
      }
      const amountInput = managedAdjustment.querySelector<HTMLInputElement>('.portfolio-candidate-amount')
      if (amountInput) {
        amountInput.value = String(residual)
      }
      return
    }
    if (Math.abs(residual) <= 0.0000001) {
      return
    }
    const tbody = document.querySelector('#portfolioCandidateTable tbody')
    if (!tbody) {
      return
    }
    const date = changedRow.querySelector<HTMLInputElement>('.portfolio-candidate-date')?.value || new Date().toISOString().slice(0, 10)
    tbody.appendChild(createPortfolioCandidateRow({
      id: `draft-cash-${Date.now()}`,
      status: 'draft',
      type: 'cash_adjustment',
      date,
      account,
      stockName: currency,
      currency,
      quantityDelta: 0,
      amount: residual,
      fee: 0,
      cashEffect: residual,
      remark: '现金差额校准',
    }))
  }

  function allocatePortfolioCandidateFees(tradeRows: HTMLTableRowElement[], targetCashDelta: number): number {
    const amounts = tradeRows.map((row) => Math.abs(portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-amount'))))
    const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0)
    if (totalAmount <= 0) {
      return 0
    }
    const signedAmount = tradeRows.reduce((sum, row, index) => {
      const quantityDelta = Number(row.dataset.quantityDelta || 0)
      return sum + (quantityDelta > 0 ? -amounts[index] : amounts[index])
    }, 0)
    const totalFee = Math.max(0, portfolioRound2(signedAmount - targetCashDelta))
    let allocated = 0
    tradeRows.forEach((row, index) => {
      const fee = index === tradeRows.length - 1 ? portfolioRound2(totalFee - allocated) : portfolioRound2(totalFee * amounts[index] / totalAmount)
      allocated += fee
      const feeInput = row.querySelector<HTMLInputElement>('.portfolio-candidate-fee')
      if (feeInput) {
        feeInput.value = String(fee)
      }
      updatePortfolioCandidateCashEffect(row)
    })
    const tradeCashEffect = tradeRows.reduce((sum, row) => {
      return sum + portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect'))
    }, 0)
    return portfolioRound2(targetCashDelta - tradeCashEffect)
  }

  function rebalancePortfolioCandidateCashAdjustment(changedRow: HTMLTableRowElement): boolean {
    const account = changedRow.dataset.account || ''
    const currency = changedRow.dataset.currency || ''
    const targetCashDelta = runtimeState.portfolioTargetCashDeltas.get(portfolioCashKey(account, currency))
    if (!account || !currency || targetCashDelta === undefined) {
      return false
    }
    const rows = portfolioCandidateRowsForAccountCurrency(account, currency)
    const tradeRows = rows.filter((row) => portfolioCandidateRowType(row) === 'trade')
    if (tradeRows.length > 0) {
      const residual = allocatePortfolioCandidateFees(tradeRows, targetCashDelta)
      updatePortfolioManagedCashAdjustment(changedRow, rows, account, currency, residual)
      return true
    }
    const managedAdjustment = rows.find((row) => row.dataset.managedCashAdjustment === '1')
    const baseCashEffect = rows.reduce((sum, row) => {
      if (row.dataset.managedCashAdjustment === '1') {
        return sum
      }
      return sum + portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect'))
    }, 0)
    const residual = portfolioRound2(targetCashDelta - baseCashEffect)
    if (managedAdjustment) {
      if (Math.abs(residual) <= 0.0000001) {
        managedAdjustment.remove()
        return true
      }
      const input = managedAdjustment.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect')
      if (input) {
        input.value = String(residual)
      }
      return true
    }
    if (Math.abs(residual) <= 0.0000001) {
      return true
    }
    const tbody = document.querySelector('#portfolioCandidateTable tbody')
    if (!tbody) {
      return false
    }
    const date = changedRow.querySelector<HTMLInputElement>('.portfolio-candidate-date')?.value || new Date().toISOString().slice(0, 10)
    tbody.appendChild(createPortfolioCandidateRow({
      id: `draft-cash-${Date.now()}`,
      status: 'draft',
      type: 'cash_adjustment',
      date,
      account,
      stockName: currency,
      currency,
      quantityDelta: 0,
      amount: residual,
      fee: 0,
      cashEffect: residual,
      remark: '现金差额校准',
    }))
    return true
  }

  function updatePortfolioAdjustmentFromTradeRows(changedRow: HTMLTableRowElement): boolean {
    const account = changedRow.dataset.account || ''
    const currency = changedRow.dataset.currency || ''
    const targetCashDelta = runtimeState.portfolioTargetCashDeltas.get(portfolioCashKey(account, currency))
    if (!account || !currency || targetCashDelta === undefined) {
      return false
    }
    const rows = portfolioCandidateRowsForAccountCurrency(account, currency)
    const fixedCashEffect = rows.reduce((sum, row) => {
      if (isPortfolioAdjustmentRow(row) && row.dataset.managedCashAdjustment === '1') {
        return sum
      }
      return sum + portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect'))
    }, 0)
    updatePortfolioManagedCashAdjustment(changedRow, rows, account, currency, portfolioRound2(targetCashDelta - fixedCashEffect))
    return true
  }

  function updatePortfolioFeesFromAdjustmentRows(changedRow: HTMLTableRowElement): boolean {
    const account = changedRow.dataset.account || ''
    const currency = changedRow.dataset.currency || ''
    const targetCashDelta = runtimeState.portfolioTargetCashDeltas.get(portfolioCashKey(account, currency))
    if (!account || !currency || targetCashDelta === undefined) {
      return false
    }
    const rows = portfolioCandidateRowsForAccountCurrency(account, currency)
    const tradeRows = rows.filter((row) => portfolioCandidateRowType(row) === 'trade')
    if (tradeRows.length === 0) {
      return false
    }
    const adjustmentCashEffect = rows.reduce((sum, row) => {
      if (!isPortfolioAdjustmentRow(row)) {
        return sum
      }
      return sum + portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect'))
    }, 0)
    const otherCashEffect = rows.reduce((sum, row) => {
      if (portfolioCandidateRowType(row) === 'trade' || isPortfolioAdjustmentRow(row)) {
        return sum
      }
      return sum + portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect'))
    }, 0)
    const residual = allocatePortfolioCandidateFees(tradeRows, portfolioRound2(targetCashDelta - adjustmentCashEffect - otherCashEffect))
    if (Math.abs(residual) > 0.0000001) {
      updatePortfolioManagedCashAdjustment(changedRow, rows, account, currency, portfolioRound2(adjustmentCashEffect + residual))
    }
    return true
  }

  function collectPortfolioCandidateEntries(): PortfolioTransaction[] {
    return Array.from(document.querySelectorAll<HTMLTableRowElement>('#portfolioCandidateTable tbody tr')).map((row) => {
      return {
        id: row.dataset.id || '',
        status: 'confirmed',
        type: row.querySelector<HTMLSelectElement>('.portfolio-candidate-type')?.value || row.dataset.type || 'trade',
        date: row.querySelector<HTMLInputElement>('.portfolio-candidate-date')?.value || '',
        account: row.dataset.account || '',
        stockName: row.dataset.stockName || '',
        currency: row.dataset.currency || '',
        quantityDelta: Number(row.dataset.quantityDelta || 0),
        amount: portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-amount')),
        fee: portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-fee')),
        cashEffect: portfolioInputNumber(row.querySelector<HTMLInputElement>('.portfolio-candidate-cash-effect')),
        relatedAccount: row.dataset.relatedAccount || '',
        remark: row.querySelector<HTMLInputElement>('.portfolio-candidate-remark')?.value || '',
      }
    }).filter((entry) => entry.date && entry.account && entry.stockName)
  }

  async function confirmPortfolioCandidates() {
    const entries = collectPortfolioCandidateEntries()
    if (entries.length === 0) {
      throw new Error('没有可写入的候选交易')
    }
    setPortfolioCandidateStatus('正在写入交易记录...')
    const response = await fetch('/api/portfolio/transactions/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    })
    const result = await response.json()
    if (result.code !== 200) {
      throw new Error(result?.msg || '写入交易记录失败')
    }
    renderPortfolioCandidateTable([])
    clearAssetDataCache()
    const assetData = await calculateAssetData()
    renderPositionTableWithData(assetData.positions as PortfolioPosition[])
    renderStockPositionTableWithData(assetData.positions as PortfolioPosition[])
    renderSectorTableWithData(assetData.positions as PortfolioPosition[])
    renderAccountTotalTableWithData(assetData.accountTotals as PortfolioAccountTotal[])
    setPortfolioCandidateStatus(`已写入 ${(result.data || []).length} 条交易记录`)
  }

  function setupPortfolioTransactionControls() {
    document.getElementById('portfolioAddAction')?.addEventListener('change', updatePortfolioAddActionMode)
    document.getElementById('portfolioGenerateCandidates')?.addEventListener('click', () => {
      renderPortfolioUiState({ generateCandidatesPending: true })
      generatePortfolioTransactionCandidates().catch((error) => {
        const message = error instanceof Error ? error.message : '生成候选交易失败'
        setPortfolioCandidateStatus(message, true)
      }).finally(() => {
        renderPortfolioUiState({ generateCandidatesPending: false })
      })
    })
    document.getElementById('portfolioAddPosition')?.addEventListener('click', () => {
      renderPortfolioUiState({ addPositionPending: true })
      addPortfolioPositionRow().catch((error) => {
        const message = error instanceof Error ? error.message : '新增持仓失败'
        setPortfolioCandidateStatus(message, true)
      }).finally(() => {
        renderPortfolioUiState({ addPositionPending: false })
      })
    })
    document.getElementById('portfolioConfirmCandidates')?.addEventListener('click', () => {
      renderPortfolioUiState({ confirmCandidatesPending: true })
      confirmPortfolioCandidates().catch((error) => {
        const message = error instanceof Error ? error.message : '写入交易记录失败'
        setPortfolioCandidateStatus(message, true)
      }).finally(() => {
        renderPortfolioUiState({ confirmCandidatesPending: false })
      })
    })
    document.getElementById('portfolioCandidateTable')?.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement
      const row = target.closest('tr') as HTMLTableRowElement | null
      if (!row) {
        return
      }
      if (target.classList.contains('portfolio-candidate-amount')) {
        if (isPortfolioAdjustmentRow(row)) {
          syncPortfolioAdjustmentCashEffectFromAmount(row)
          updatePortfolioFeesFromAdjustmentRows(row)
          return
        }
        if (!rebalancePortfolioCandidateCashAdjustment(row)) {
          updatePortfolioCandidateFeeFromCashEffect(row)
        }
        return
      }
      if (target.classList.contains('portfolio-candidate-fee')) {
        updatePortfolioCandidateCashEffect(row)
        updatePortfolioAdjustmentFromTradeRows(row)
        return
      }
      if (target.classList.contains('portfolio-candidate-cash-effect')) {
        if (isPortfolioAdjustmentRow(row)) {
          syncPortfolioAdjustmentAmountFromCashEffect(row)
          updatePortfolioFeesFromAdjustmentRows(row)
        } else {
          rebalancePortfolioCandidateCashAdjustment(row)
        }
      }
      if (target.classList.contains('portfolio-candidate-type')) {
        row.dataset.type = target.value
        if (!isPortfolioAdjustmentType(target.value)) {
          delete row.dataset.managedCashAdjustment
        } else {
          syncPortfolioAdjustmentCashEffectFromAmount(row)
        }
        rebalancePortfolioCandidateCashAdjustment(row)
      }
    })
    document.getElementById('portfolioTable')?.addEventListener('input', (event) => {
      const target = event.target as HTMLElement
      if (target.classList.contains('portfolio-target-quantity')) {
        updatePortfolioQuantityMarker(target)
      }
      if (target.classList.contains('portfolio-target-amount')) {
        updatePortfolioAmountMarker(target)
      }
    })
  }

  function renderPositionTableWithData(positions: PortfolioPosition[]) {
    const tbody = document.querySelector('#portfolioTable tbody')
    const showZeroQuantityCheckbox = document.getElementById('showZeroQuantity') as HTMLInputElement
    const showZeroQuantity = showZeroQuantityCheckbox?.checked || false
    fillPortfolioAccountOptions(positions)

    if (tbody) {
      tbody.innerHTML = ''

      const filteredPositions = positions.filter((position) => {
        return position.account !== '汇总' && (position.quantity !== 0 || showZeroQuantity)
      })

      const aggregatedPositions = new Map<string, any>()

      filteredPositions.forEach((position) => {
        const key = `${position.account}_${position.stockName}`

        if (aggregatedPositions.has(key)) {
          const existing = aggregatedPositions.get(key)
          const oldQuantity = existing.quantity
          const oldTotalCost = oldQuantity * existing.costPerShare

          existing.quantity += position.quantity
          existing.marketValue += position.marketValue
          existing.rmbValue += position.rmbValue
          existing.exposureRmbValue += position.exposureRmbValue
          existing.currency = position.currency

          const newTotalCost = oldTotalCost + (position.quantity * position.costPerShare)
          existing.costPerShare = existing.quantity > 0 ? newTotalCost / existing.quantity : 0

          if (existing.costPerShare > 0) {
            existing.profitLossRatio = ((existing.currentPrice - existing.costPerShare) / existing.costPerShare) * 100
          }
        } else {
          aggregatedPositions.set(key, {
            account: position.account,
            stockName: position.stockName,
            currency: position.currency,
            quantity: position.quantity,
            marketValue: position.marketValue,
            costPerShare: position.costPerShare,
            currentPrice: position.currentPrice,
            rmbValue: position.rmbValue,
            exposureRmbValue: position.exposureRmbValue,
            profitLossRatio: position.profitLossRatio,
            sector: position.sector || '其他',
          })
        }
      })

      const totalRmbValue = Array.from(aggregatedPositions.values()).reduce((sum, pos) => sum + pos.rmbValue, 0)
      const totalAbsExposureRmbValue = Array.from(aggregatedPositions.values()).reduce((sum, pos) => sum + Math.abs(pos.exposureRmbValue), 0)

      aggregatedPositions.forEach((pos) => {
        pos.proportion = totalRmbValue > 0 ? (pos.rmbValue / totalRmbValue) * 100 : 0
        pos.exposureProportion = totalAbsExposureRmbValue > 0 ? (Math.abs(pos.exposureRmbValue) / totalAbsExposureRmbValue) * 100 : 0
      })

      const sortedAggregatedPositions = Array.from(aggregatedPositions.values()).sort((a, b) => {
        if (a.account !== b.account) {
          return a.account.localeCompare(b.account)
        }
        return a.stockName.localeCompare(b.stockName)
      })

      sortedAggregatedPositions.forEach((position) => {
        const row = document.createElement('tr')

        row.innerHTML = `
          <td>${position.account}</td>
          <td>${position.sector}</td>
          <td>${position.stockName}</td>
          <td>${position.currency}</td>
          ${portfolioPositionEditCellHTML(position)}
          ${portfolioPositionAmountCellHTML(position.targetAmount || 0)}
          <td>${position.marketValue.toFixed(2)}</td>
          <td>${position.costPerShare ? position.costPerShare.toFixed(2) : '0.00'}</td>
          <td>${position.currentPrice.toFixed(2)}</td>
          <td>${position.rmbValue.toFixed(2)}</td>
          <td>${position.proportion.toFixed(2)}</td>
          <td>${position.exposureProportion.toFixed(2)}</td>
          <td>${position.profitLossRatio.toFixed(2)}%</td>
        `

        tbody.appendChild(row)
      })

      const summaryRow = document.createElement('tr')
      summaryRow.className = 'table-dark'

      const totalQuantity = sortedAggregatedPositions.reduce((sum, pos) => sum + pos.quantity, 0)
      const totalMarketValue = sortedAggregatedPositions.reduce((sum, pos) => sum + pos.marketValue, 0)
      const totalRmbValueSummary = sortedAggregatedPositions.reduce((sum, pos) => sum + pos.rmbValue, 0)

      summaryRow.innerHTML = `
        <td>汇总</td>
        <td></td>
        <td></td>
        <td></td>
        <td>${totalQuantity}</td>
        <td></td>
        <td>${totalMarketValue.toFixed(2)}</td>
        <td></td>
        <td></td>
        <td>${totalRmbValueSummary.toFixed(2)}</td>
        <td>100.00</td>
        <td>100.00</td>
        <td></td>
      `

      tbody.appendChild(summaryRow)
    }

    const table = document.getElementById('portfolioTable')
    if (table) {
      bsTable('portfolioTable', {
        data: table.innerHTML,
      })
    }
  }

  function renderStockPositionTableWithData(positions: PortfolioPosition[]) {
    const tbody = document.querySelector('#stockPositionTable tbody')
    const showZeroQuantityCheckbox = document.getElementById('showZeroQuantity') as HTMLInputElement
    const showZeroQuantity = showZeroQuantityCheckbox?.checked || false

    if (tbody) {
      tbody.innerHTML = ''

      const filteredPositions = positions.filter((position) => {
        return position.account !== '汇总' && (position.quantity !== 0 || showZeroQuantity)
      })

      const aggregatedPositions = new Map<string, any>()

      filteredPositions.forEach((position) => {
        const stockName = position.stockName

        if (aggregatedPositions.has(stockName)) {
          const existing = aggregatedPositions.get(stockName)
          const oldQuantity = existing.quantity
          const oldTotalCost = oldQuantity * existing.costPerShare

          existing.quantity += position.quantity
          existing.marketValue += position.marketValue
          existing.rmbValue += position.rmbValue
          existing.exposureRmbValue += position.exposureRmbValue
          existing.currency = position.currency

          const newTotalCost = oldTotalCost + (position.quantity * position.costPerShare)
          existing.costPerShare = existing.quantity > 0 ? newTotalCost / existing.quantity : 0

          if (existing.costPerShare > 0) {
            existing.profitLossRatio = ((existing.currentPrice - existing.costPerShare) / existing.costPerShare) * 100
          }
        } else {
          aggregatedPositions.set(stockName, {
            stockName: position.stockName,
            currency: position.currency,
            quantity: position.quantity,
            marketValue: position.marketValue,
            costPerShare: position.costPerShare,
            currentPrice: position.currentPrice,
            rmbValue: position.rmbValue,
            exposureRmbValue: position.exposureRmbValue,
            profitLossRatio: position.profitLossRatio,
            sector: position.sector || '其他',
          })
        }
      })

      const totalRmbValue = Array.from(aggregatedPositions.values()).reduce((sum, pos) => sum + pos.rmbValue, 0)
      const totalAbsExposureRmbValue = Array.from(aggregatedPositions.values()).reduce((sum, pos) => sum + Math.abs(pos.exposureRmbValue), 0)

      aggregatedPositions.forEach((pos) => {
        pos.proportion = totalRmbValue > 0 ? (pos.rmbValue / totalRmbValue) * 100 : 0
        pos.exposureProportion = totalAbsExposureRmbValue > 0 ? (Math.abs(pos.exposureRmbValue) / totalAbsExposureRmbValue) * 100 : 0
      })

      const sortedAggregatedPositions = Array.from(aggregatedPositions.values()).sort((a, b) => {
        if (a.sector !== b.sector) {
          return a.sector.localeCompare(b.sector)
        }
        return a.stockName.localeCompare(b.stockName)
      })

      sortedAggregatedPositions.forEach((position) => {
        const row = document.createElement('tr')

        row.innerHTML = `
          <td>${position.sector}</td>
          <td>${position.stockName}</td>
          <td>${position.currency}</td>
          <td>${position.quantity}</td>
          <td>${position.marketValue.toFixed(2)}</td>
          <td>${position.costPerShare ? position.costPerShare.toFixed(2) : '0.00'}</td>
          <td>${position.currentPrice.toFixed(2)}</td>
          <td>${position.rmbValue.toFixed(2)}</td>
          <td>${position.proportion.toFixed(2)}</td>
          <td>${position.exposureProportion.toFixed(2)}</td>
          <td>${position.profitLossRatio.toFixed(2)}%</td>
        `

        tbody.appendChild(row)
      })

      const summaryRow = document.createElement('tr')
      summaryRow.className = 'table-dark'

      const totalQuantity = sortedAggregatedPositions.reduce((sum, pos) => sum + pos.quantity, 0)
      const totalMarketValue = sortedAggregatedPositions.reduce((sum, pos) => sum + pos.marketValue, 0)
      const totalRmbValueSummary = sortedAggregatedPositions.reduce((sum, pos) => sum + pos.rmbValue, 0)

      summaryRow.innerHTML = `
        <td>汇总</td>
        <td></td>
        <td></td>
        <td>${totalQuantity}</td>
        <td>${totalMarketValue.toFixed(2)}</td>
        <td></td>
        <td></td>
        <td>${totalRmbValueSummary.toFixed(2)}</td>
        <td>100.00</td>
        <td>100.00</td>
        <td></td>
      `

      tbody.appendChild(summaryRow)
    }

    const table = document.getElementById('stockPositionTable')
    if (table) {
      bsTable('stockPositionTable', {
        data: table.innerHTML,
      })
    }
  }

  function renderSectorTableWithData(positions: PortfolioPosition[]) {
    const tbody = document.querySelector('#sectorTable tbody')

    if (tbody) {
      tbody.innerHTML = ''

      const filteredPositions = positions.filter((position) => {
        return position.account !== '汇总' && position.quantity !== 0
      })

      const aggregatedSectors = new Map<string, { marketValue: number, rmbValue: number }>()

      filteredPositions.forEach((position) => {
        const sector = position.sector || '其他'

        if (aggregatedSectors.has(sector)) {
          const existing = aggregatedSectors.get(sector)!
          existing.marketValue += position.marketValue
          existing.rmbValue += position.rmbValue
        } else {
          aggregatedSectors.set(sector, {
            marketValue: position.marketValue,
            rmbValue: position.rmbValue,
          })
        }
      })

      const totalRmbValue = Array.from(aggregatedSectors.values()).reduce((sum, sector) => sum + sector.rmbValue, 0)

      const sectorStats = Array.from(aggregatedSectors.entries()).map(([sector, data]) => ({
        sector,
        marketValue: data.marketValue,
        rmbValue: data.rmbValue,
        proportion: totalRmbValue > 0 ? (data.rmbValue / totalRmbValue) * 100 : 0,
      }))

      sectorStats.sort((a, b) => b.rmbValue - a.rmbValue)

      sectorStats.forEach((sectorStat) => {
        const row = document.createElement('tr')

        row.innerHTML = `
          <td>${sectorStat.sector}</td>
          <td>${sectorStat.rmbValue.toFixed(2)}</td>
          <td>${sectorStat.proportion.toFixed(2)}</td>
        `

        tbody.appendChild(row)
      })

      const summaryRow = document.createElement('tr')
      summaryRow.className = 'table-dark'

      summaryRow.innerHTML = `
        <td>汇总</td>
        <td>${totalRmbValue.toFixed(2)}</td>
        <td>100.00</td>
      `

      tbody.appendChild(summaryRow)
    }

    const table = document.getElementById('sectorTable')
    if (table) {
      bsTable('sectorTable', {
        data: table.innerHTML,
      })
    }
  }

  function renderAccountTotalTableWithData(accountTotals: PortfolioAccountTotal[]) {
    const tbody = document.querySelector('#accountTotalTable tbody')

    if (tbody) {
      tbody.innerHTML = ''

      accountTotals.forEach((accountTotal) => {
        const row = document.createElement('tr')
        const originalTotalAsset = accountTotal.originalTotalAsset ?? accountTotal.cash + accountTotal.holdings

        if (accountTotal.account === '汇总') {
          row.className = 'table-dark'
        }

        row.innerHTML = `
          <td>${accountTotal.account}</td>
          <td>${accountTotal.currency || ''}</td>
          <td>${accountTotal.cash.toFixed(2)}</td>
          <td>${accountTotal.holdings.toFixed(2)}</td>
          <td>${originalTotalAsset.toFixed(2)}</td>
          <td>${accountTotal.totalAsset.toFixed(2)}</td>
          <td>${accountTotal.proportion.toFixed(2)}</td>
        `

        tbody.appendChild(row)
      })
    }

    const table = document.getElementById('accountTotalTable')
    if (table) {
      bsTable('accountTotalTable', {
        data: table.innerHTML,
      })
    }
  }

  return {
    onPortfolioCodeSelectChange,
    renderPortfolioChart,
    setupPortfolioTransactionControls,
    updatePortfolioAddActionMode,
    loadPortfolioStockInfo,
    fillPortfolioStockOptions,
    setPortfolioCandidateStatus,
    renderPortfolioUiState,
    clearAssetDataCache,
    calculateAssetData,
    fillPortfolioAccountOptionsFromTotals,
    prepareChartData,
    renderPositionTableWithData,
    renderStockPositionTableWithData,
    renderSectorTableWithData,
    renderAccountTotalTableWithData,
  }
}
