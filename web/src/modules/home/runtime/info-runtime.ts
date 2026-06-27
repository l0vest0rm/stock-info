type InfoRuntimeContext = {
  getCodeNameMap: () => Record<string, string>
  getReportsMap: () => Record<string, any[]>
  readSelectedOptionValues: (element: Element | null) => string[]
  setSelectedCodes: (codes: string[]) => void
  fetch2FormatFinanceData: (codes: string[], callback: (codes: string[]) => void) => void
  codeSelectInit: (cats: string[], id: string, placeholder: string, disabled: boolean) => void
  bsRadioButtons: (id: string) => void
}

export function createInfoInitializer(context: InfoRuntimeContext) {
  const {
    getCodeNameMap,
    getReportsMap,
    readSelectedOptionValues,
    setSelectedCodes,
    fetch2FormatFinanceData,
    codeSelectInit,
    bsRadioButtons,
  } = context

  function date2reportForamt(date: string, yearly: boolean): string {
    if (yearly) {
      return date.substring(0, 4)
    }
    return date.substring(0, 7)
  }

  function emitInfoState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:info-state', { detail: patch || {} }))
  }

  function mapInfoRows(rows: any[]): any[] {
    return rows.map((row, index) => ({
      company: String(row?.[0] ?? ''),
      item: String(row?.[1] ?? ''),
      date: String(row?.[2] ?? ''),
      value: String(row?.[3] ?? ''),
      rowKey: `${String(row?.[0] ?? '')}-${String(row?.[1] ?? '')}-${String(row?.[2] ?? '')}-${index}`,
    }))
  }

  function genInfoTable(codes: string[]) {
    const seasons = parseInt((document.getElementById('seasons') as HTMLInputElement | null)?.value || '0')
    const yearly = ((document.getElementById('compareType') as HTMLElement | null)?.dataset.id || '') === 'yearly'
    const keys = [
      ['totalOperateIncome', '营收', 1e8],
      ['parentNetprofit', '净利润', 1e8],
      ['deductParentNetprofit', '扣非净利润', 1e8],
    ]
    const rows: any[] = []
    const codeNameMap = getCodeNameMap()
    const reportsMap = getReportsMap()
    for (const code of codes) {
      for (let i = 0; i < seasons; i++) {
        for (const key of keys) {
          rows.push([
            codeNameMap[code],
            key[1],
            date2reportForamt(reportsMap[code][i].reportDate, yearly),
            (reportsMap[code][i][key[0]] / key[2]).toFixed(2),
          ])
        }
      }
    }
    emitInfoState({
      rows: mapInfoRows(rows),
      status: rows.length > 0 ? '' : '暂无数据',
    })
  }

  function onInfoCodeSelectChange() {
    const selectedCodes = readSelectedOptionValues(document.getElementById('codes'))
    setSelectedCodes(selectedCodes)
    if (selectedCodes.length === 0) {
      emitInfoState({
        rows: [],
        status: '请选择股票',
      })
      console.log('codes none')
      return
    }

    emitInfoState({
      rows: [],
      status: '加载中...',
    })
    fetch2FormatFinanceData(selectedCodes, genInfoTable)
  }

  function initInfo() {
    emitInfoState({
      rows: [],
      status: '请选择股票',
    })
    codeSelectInit(['SH', 'SZ', 'HK', 'US', 'KS'], 'codes', '股票对比', false)
    document.getElementById('codes')?.addEventListener('change', onInfoCodeSelectChange)
    document.getElementById('compareType')?.addEventListener('bs.change', onInfoCodeSelectChange)
    document.getElementById('seasons')?.addEventListener('change', onInfoCodeSelectChange)
    onInfoCodeSelectChange()
    bsRadioButtons('compareType')
  }

  return initInfo
}
