import type { PortfolioRuntime } from './portfolio-runtime'

type PortfolioPagesRuntimeContext = {
  dateRangeInit: () => void
  codeSelectInit: (cats: string[], id: string, placeholder: string, disabled: boolean) => void
  portfolioRuntime: PortfolioRuntime
  alert: (message: string, type?: string) => void
}

export function createPortfolioInitializer(context: PortfolioPagesRuntimeContext) {
  const { dateRangeInit, codeSelectInit, portfolioRuntime, alert } = context
  const {
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
    renderPositionTableWithData,
    renderStockPositionTableWithData,
    renderSectorTableWithData,
    renderAccountTotalTableWithData,
  } = portfolioRuntime

  return async function initPortfolio() {
    dateRangeInit()
    codeSelectInit([], 'codes', '对比...', false)
    document.getElementById('codes')!.addEventListener('change', onPortfolioCodeSelectChange)
    setupPortfolioTransactionControls()
    updatePortfolioAddActionMode()
    loadPortfolioStockInfo().then(fillPortfolioStockOptions).catch((error) => {
      const message = error instanceof Error ? error.message : '加载股票信息失败'
      setPortfolioCandidateStatus(message, true)
    })

    const showZeroQuantityCheckbox = document.getElementById('showZeroQuantity') as HTMLInputElement | null
    if (showZeroQuantityCheckbox) {
      renderPortfolioUiState({ showZeroQuantity: showZeroQuantityCheckbox.checked })
      showZeroQuantityCheckbox.addEventListener('change', async () => {
        renderPortfolioUiState({ showZeroQuantity: showZeroQuantityCheckbox.checked })
        try {
          clearAssetDataCache()
          const assetData = await calculateAssetData()
          renderPositionTableWithData(assetData.positions)
          renderStockPositionTableWithData(assetData.positions)
          renderSectorTableWithData(assetData.positions)
          renderAccountTotalTableWithData(assetData.accountTotals)
        } catch (error) {
          const message = error instanceof Error ? error.message : '资产计算失败'
          alert(message, 'danger')
        }
      })
    }

    clearAssetDataCache()

    try {
      const assetData = await calculateAssetData()
      fillPortfolioAccountOptionsFromTotals(assetData.accountTotals)
      renderPortfolioChart(assetData)
      renderPositionTableWithData(assetData.positions)
      renderStockPositionTableWithData(assetData.positions)
      renderSectorTableWithData(assetData.positions)
      renderAccountTotalTableWithData(assetData.accountTotals)
    } catch (error) {
      const message = error instanceof Error ? error.message : '资产计算失败'
      alert(message, 'danger')
    }
  }
}
