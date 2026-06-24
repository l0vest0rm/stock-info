type IndexRuntimeContext = {
  dateRangeInit: () => void
  codeSelectInit: (codes: any[], selectId: string, title: string, allowCreate: boolean) => void
  selectedOptionValues: (element: Element | null) => string[]
  getSelectedCodes: () => string[]
  setSelectedCodes: (codes: string[]) => void
  fetchKlines: (codes: string[], fq: string, callback: (codes: string[]) => void) => void
  setKlineCodes: (codes: string[]) => void
  getCodeNameMap: () => Record<string, string>
  rerenderMyChart: () => void
  onRatioCheckChange: (checked: boolean) => void
  onAlignStartCheckChange: (checked: boolean) => void
}

export function createIndexInitializer(context: IndexRuntimeContext) {
  const refreshIndexKlineChart = (): void => {
    const selected = context.selectedOptionValues(document.getElementById('codes'))
    const codes = Array.isArray(selected) && selected.length > 0
      ? selected
      : context.getSelectedCodes().slice()
    if (codes.length === 0) {
      return
    }
    context.setSelectedCodes(codes)
    const fq = (document.getElementById('klinePrice') as HTMLInputElement | null)?.value || ''
    context.fetchKlines(codes, fq, () => {
      const nextKlineCodes: string[] = []
      const codeNameMap = context.getCodeNameMap()
      for (const item of codes) {
        nextKlineCodes.push(item + fq)
        if (codeNameMap[item] && !codeNameMap[item + fq]) {
          codeNameMap[item + fq] = codeNameMap[item]
        }
      }
      context.setKlineCodes(nextKlineCodes)
      context.rerenderMyChart()
    })
  }

  return function initIndex(): void {
    context.dateRangeInit()
    context.codeSelectInit([], 'codes', '指数对比', false)
    document.getElementById('codes')?.addEventListener('change', refreshIndexKlineChart)
    document.getElementById('klinePrice')?.addEventListener('change', refreshIndexKlineChart)
    document.getElementById('ratio')?.addEventListener('change', (event: Event) => {
      context.onRatioCheckChange((event.target as HTMLInputElement).checked)
    })
    document.getElementById('alignStart')?.addEventListener('change', (event: Event) => {
      context.onAlignStartCheckChange((event.target as HTMLInputElement).checked)
    })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        refreshIndexKlineChart()
      })
    })
  }
}
