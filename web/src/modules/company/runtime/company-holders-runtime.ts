type CompanyHoldersRuntimeContext = {
  getCode: () => string
  fetchCompanyFreeHolders: (code: string, callback: (code: string) => void) => void
  fetchCompanyOrgHolders: (code: string, reportDate: string, callback: (code: string, reportDate: string) => void) => void
  getCache: () => Record<string, unknown>
}

export function createCompanyHoldersInitializer(context: CompanyHoldersRuntimeContext) {
  const { fetchCompanyFreeHolders, fetchCompanyOrgHolders, getCache } = context
  let companyHoldersEventsBound = false

  function currentCode(): string {
    return context.getCode()
  }

  function emitCompanyHoldersState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:company-holders-state', { detail: patch || {} }))
  }

  function normalizeCompanyHolderFundCode(value: string): string {
    if (value.endsWith('.SZ')) {
      return value.split('.')[0] + '.ZF'
    }
    if (value.endsWith('.SH')) {
      return value.split('.')[0] + '.SF'
    }
    return value
  }

  function mapCompanyFreeHolderRows(holderMap: any): any[] {
    const rows: any[] = []
    let idx = 0
    for (const name in holderMap) {
      idx += 1
      const holder = holderMap[name]
      const ratioCurrent = Number(holder[3] || 0)
      const ratioPrevious = Number(holder[4] || 0)
      const sharesCurrent = Number(holder[6] || 0)
      const sharesPrevious = Number(holder[7] || 0)
      const ratioDiff = ratioCurrent - ratioPrevious
      const sharesDiffPct = sharesPrevious > 0 ? sharesCurrent * 100 / sharesPrevious - 100 : 100
      rows.push({
        rank: idx,
        holderName: String(holder[0] || ''),
        holderType: String(holder[1] || ''),
        shareType: String(holder[2] || ''),
        ratioCurrent: ratioCurrent.toFixed(2),
        ratioPrevious: ratioPrevious.toFixed(2),
        ratioDiff: ratioDiff.toFixed(2),
        sharesCurrent: String(sharesCurrent),
        sharesPrevious: String(sharesPrevious),
        sharesDiffPct: sharesDiffPct.toFixed(2),
      })
    }
    return rows
  }

  function mapCompanyOrgHolderRows(holderMap: any): any[] {
    const rows: any[] = []
    let idx = 0
    for (const name in holderMap) {
      idx += 1
      const holder = holderMap[name]
      const sharesCurrent = Number(holder[2] || 0)
      const sharesPrevious = Number(holder[3] || 0)
      const sharesDiffPct = sharesPrevious > 0 ? sharesCurrent * 100 / sharesPrevious - 100 : 100
      const ratioCurrent = Number(holder[5] || 0)
      const ratioPrevious = Number(holder[6] || 0)
      const ratioDiff = ratioCurrent - ratioPrevious
      const netValueCurrent = Number(holder[8] || 0)
      const netValuePrevious = Number(holder[9] || 0)
      const netValueDiff = netValueCurrent - netValuePrevious
      const fundCode = normalizeCompanyHolderFundCode(String(holder[0] || ''))
      rows.push({
        rank: idx,
        fundCode,
        fundHref: fundCode ? `fund.html?code=${fundCode}` : '',
        name: String(holder[1] || ''),
        sharesCurrent: String(sharesCurrent),
        sharesPrevious: String(sharesPrevious),
        sharesDiffPct: sharesDiffPct.toFixed(2),
        ratioCurrent: ratioCurrent.toFixed(2),
        ratioPrevious: ratioPrevious.toFixed(2),
        ratioDiff: ratioDiff.toFixed(2),
        netValueCurrent: netValueCurrent.toFixed(2),
        netValuePrevious: netValuePrevious.toFixed(2),
        netValueDiff: netValueDiff.toFixed(2),
      })
    }
    return rows
  }

  function companyFreeHoldersTable(r1: string, r2: string) {
    const code = currentCode()
    fetchCompanyFreeHolders(code, (loadedCode) => {
      const data = getCache()[`${loadedCode}-cfh`] as any[]
      if (!data || data.length === 0) {
        return
      }
      const holderMap: any = {}
      const total = ['总计', '', '', 0, 0, 0, 0, 0, 0]
      for (const item of data) {
        const rd = item.END_DATE.substring(0, 10)
        const key = item.HOLDER_NAME
        if (rd === r1) {
          if (!holderMap[key]) {
            holderMap[key] = []
            holderMap[key][0] = item.HOLDER_NAME
            holderMap[key][1] = item.HOLDER_TYPE
            holderMap[key][2] = item.SHARES_TYPE
          }
          holderMap[key][3] = item.FREE_HOLDNUM_RATIO
          holderMap[key][6] = item.HOLD_NUM
          total[3] += holderMap[key][3]
          total[6] += holderMap[key][6]
        }
        if (rd === r2) {
          if (!holderMap[key]) {
            holderMap[key] = []
            holderMap[key][0] = item.HOLDER_NAME
            holderMap[key][1] = item.HOLDER_TYPE
            holderMap[key][2] = item.SHARES_TYPE
          }
          holderMap[key][4] = item.FREE_HOLDNUM_RATIO
          holderMap[key][7] = item.HOLD_NUM
          total[4] += holderMap[key][4]
          total[7] += holderMap[key][7]
        }
      }
      holderMap.total = total
      emitCompanyHoldersState({ freeRows: mapCompanyFreeHolderRows(holderMap) })
    })
  }

  function companyOrgoldersTable(r1: string, r2: string) {
    const code = currentCode()
    const should = 2
    let done = 0
    const success = () => {
      done += 1
      if (done !== should) {
        return
      }
      const holderMap: any = {}
      for (const rd of [r1, r2]) {
        const data = getCache()[`${code}-${rd}-coh`] as any[]
        if (!data) {
          continue
        }
        for (const item of data) {
          const key = item.FUND_DERIVECODE
          if (rd === r1) {
            if (!holderMap[key]) {
              holderMap[key] = []
              holderMap[key][0] = item.FUND_DERIVECODE
              holderMap[key][1] = item.HOLDER_NAME
            }
            holderMap[key][2] = item.TOTAL_SHARES
            holderMap[key][5] = item.TOTALSHARES_RATIO
            holderMap[key][8] = item.NETVALUE_RATIO
          }
          if (rd === r2) {
            if (!holderMap[key]) {
              holderMap[key] = []
              holderMap[key][0] = item.FUND_DERIVECODE
              holderMap[key][1] = item.HOLDER_NAME
            }
            holderMap[key][3] = item.TOTAL_SHARES
            holderMap[key][6] = item.TOTALSHARES_RATIO
            holderMap[key][9] = item.NETVALUE_RATIO
          }
        }
      }
      emitCompanyHoldersState({ orgRows: mapCompanyOrgHolderRows(holderMap) })
    }

    fetchCompanyOrgHolders(code, r1, success)
    fetchCompanyOrgHolders(code, r2, success)
  }

  function companyHoldersCompare() {
    const r1 = (document.getElementById('reportDate1') as HTMLSelectElement | null)?.value || ''
    const r2 = (document.getElementById('reportDate2') as HTMLSelectElement | null)?.value || ''
    emitCompanyHoldersState({
      selectedReportDate1: r1,
      selectedReportDate2: r2,
    })
    companyFreeHoldersTable(r1, r2)
    companyOrgoldersTable(r1, r2)
  }

  function initCompanyHolders() {
    const code = currentCode()
    fetchCompanyFreeHolders(code, (loadedCode) => {
      const data = getCache()[`${loadedCode}-cfh`] as any[]
      if (!data || data.length === 0) {
        return
      }
      const options: Array<{ value: string, text: string }> = []
      const reportDateMap: Record<string, number> = {}
      for (let i = 0; i < data.length; i += 1) {
        const reportDate = data[i].END_DATE.substring(0, 10)
        if (reportDateMap[reportDate]) {
          continue
        }
        reportDateMap[reportDate] = 1
        options.push({ value: reportDate, text: reportDate })
      }
      emitCompanyHoldersState({
        reportDateOptions: options.map((option) => ({
          value: String(option.value),
          text: String(option.text),
        })),
        selectedReportDate1: String(options[0]?.value || ''),
        selectedReportDate2: String(options[1]?.value || options[0]?.value || ''),
      })
      requestAnimationFrame(() => {
        if (!companyHoldersEventsBound) {
          companyHoldersEventsBound = true
          document.querySelectorAll("select[name='reportDate']").forEach((elem) => {
            elem.addEventListener('change', companyHoldersCompare)
          })
        }
        companyHoldersCompare()
      })
    })
  }

  return initCompanyHolders
}
