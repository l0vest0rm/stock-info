type StockTablePagesRuntimeContext = {
  loadEtfCodes: () => Promise<void>
  getEtfCodes: () => Array<{ code: string }>
  fetchKlines: (codes: string[], fq: string, callback: (codes: string[]) => void) => void
  genratePerformanceTable: (codes: string[]) => void
}

export function createStockTableInitializer(context: StockTablePagesRuntimeContext) {
  const { loadEtfCodes, getEtfCodes, fetchKlines, genratePerformanceTable } = context

  return async function initStockTable() {
    await loadEtfCodes()
    const etfCodeStrings = getEtfCodes().map((etf) => etf.code)
    fetchKlines(etfCodeStrings, '', (codes: string[]) => {
      genratePerformanceTable(codes)
    })
  }
}
