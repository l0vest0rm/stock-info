import { queryString } from '../../format'

type Callback = (data: unknown) => void
type CodesCallback = (codes: string[]) => void

type DataServicesContext = {
  cache: Record<string, unknown>
  codeNameMap: Record<string, string>
  klineCodes: string[]
  markPoints: unknown[]
  server: string
  usCodeMap: Record<string, string>
  fetchRequest: (request: string | { url: string, cacheKey?: string, cacheTtl?: number, params?: Record<string, unknown>, silent?: boolean }) => Promise<unknown>
}

export function createLegacyDataServices(context: DataServicesContext) {
  const { cache, codeNameMap, klineCodes, markPoints, server, usCodeMap, fetchRequest } = context
  const klineInflight = new Map<string, Promise<unknown>>()

  function fetchCodesData(codes: string[], fn: (code: string, succ: (code: string) => void) => void, callback: CodesCallback): void {
    const should = codes.length
    let done = 0
    const success = function (_code: string): void {
      done += 1
      if (done === should) {
        callback(codes)
      }
    }

    for (const code of codes) {
      fn(code, success)
    }
  }

  function fetchFinanceIncome(code: string, callback: (code: string) => void): void {
    const cacheKey = `${code}-fsi`
    if (cache[cacheKey] !== undefined) {
      callback(code)
      return
    }

    void fetchRequest({
      url: `${server}/api/finance/income`,
      params: { code },
      silent: true,
    }).then((data: unknown) => {
      if (data) {
        cache[cacheKey] = data
        callback(code)
      }
    })
  }

  function fetchFinanceBalance(code: string, callback: (code: string) => void): void {
    const cacheKey = `${code}-fsb`
    if (cache[cacheKey] !== undefined) {
      callback(code)
      return
    }

    void fetchRequest({
      url: `${server}/api/finance/balance`,
      params: { code },
    }).then((data: unknown) => {
      if (data) {
        cache[cacheKey] = data
        callback(code)
      }
    })
  }

  function fetchFinanceCashflow(code: string, callback: (code: string) => void): void {
    const cacheKey = `${code}-fsc`
    if (cache[cacheKey] !== undefined) {
      callback(code)
      return
    }

    void fetchRequest({
      url: `${server}/api/finance/cashflow`,
      params: { code },
    }).then((data: unknown) => {
      if (data) {
        cache[cacheKey] = data
        callback(code)
      }
    })
  }

  async function fetchKline(code: string, fq?: string): Promise<unknown> {
    const cacheKey = `${code}${fq}`
    if (cache[cacheKey]) {
      return cache[cacheKey]
    }
    const existing = klineInflight.get(cacheKey)
    if (existing) {
      return existing
    }
    const request = fetchRequest({
      url: `${server}/api/kline`,
      cacheKey,
      cacheTtl: 86400,
      silent: true,
      params: {
        code,
        fq: fq || '',
      },
    }).then((data) => {
      if (data && typeof data === 'object' && 'error' in data) {
        delete cache[cacheKey]
        console.warn(`Kline unavailable for ${code}:`, data)
        return undefined
      }
      cache[cacheKey] = data
      return data
    }).finally(() => {
      klineInflight.delete(cacheKey)
    })
    klineInflight.set(cacheKey, request)
    return request
  }

  async function fetchKlines(codes: string[], fq: string, callback: CodesCallback) {
    const requestedCodes = Array.isArray(codes) ? codes.slice() : []
    const should = requestedCodes.length
    let done = 0
    const success = function () {
      done += 1
      if (done === should) {
        callback(requestedCodes)
      }
    }

    if (should === 0) {
      callback(requestedCodes)
      return
    }

    let nextIndex = 0
    const workers = Array.from({ length: Math.min(3, should) }, async () => {
      while (nextIndex < should) {
        const code = requestedCodes[nextIndex]
        nextIndex += 1
        await fetchKline(code, fq)
        success()
      }
    })
    await Promise.all(workers)
  }

  function fetchFundPosition(code: string, num: number, callback: (code: string) => void) {
    const cacheKey = `${code}-fp`
    fetchRequest({
      url: `${server}/api/fund/position?code=${code}&num=${num}`,
      cacheKey,
      cacheTtl: 360000,
    }).then(() => {
      callback(code)
    })
  }

  function fetchShareChanges(codes: string[], callback: CodesCallback) {
    const should = codes.length
    let done = 0
    const success = function (_data: any) {
      done += 1
      if (done === should) {
        callback(codes)
      }
    }

    for (const code of codes) {
      fetchShareChange(code, success)
    }
  }

  function fetchShareChange(code: string, callback: Callback) {
    const cacheKey = `${code}-sc`
    if (cache[cacheKey]) {
      callback(cache[cacheKey])
      return
    }

    fetchRequest({
      url: '/api/finance/sharechange',
      params: { code },
    }).then((data: any) => {
      if (data) {
        cache[cacheKey] = data
        callback(data)
      } else {
        console.error('fetchShareChange error:', data)
        callback([])
      }
    })
  }

  function fetchDividendYields(codes: string[], callback: CodesCallback) {
    const should = codes.length
    let done = 0
    const success = function () {
      done += 1
      if (done === should) {
        callback(codes)
      }
    }

    for (const code of codes) {
      fetchDividendYield(code, success)
    }
  }

  function fetchShareAdditional(code: string, callback: Callback) {
    const cacheKey = `${code}-sa`
    fetchRequest({
      url: `${server}/api/finance/shareadditional?code=${code}`,
      cacheKey,
      cacheTtl: 360000,
    }).then((data: any) => {
      callback(Array.isArray(data) ? data : data?.data)
    })
  }

  function fetchShareBonus(code: string, callback: Callback) {
    const cacheKey = `${code}-bs`
    fetch(`/api/finance/sharebonus?code=${code}`)
      .then((response) => response.json())
      .then((data: any) => {
        if (data.data) {
          cache[cacheKey] = data.data
        }
        callback(data.data)
      })
  }

  function fetchDividendYield(code: string, callback: Callback) {
    const cacheKey = `${code}-dy`
    fetchRequest({
      url: `${server}/api/finance/dividendyield`,
      cacheKey,
      cacheTtl: 360000,
      params: { code },
    }).then((data: any) => {
      if (data?.series) {
        cache[`${code}-bs`] = data.series
        codeNameMap[`${code}-bs`] = `${codeNameMap[code]}-股息率%`
        klineCodes.push(`${code}-bs`)
      }
      if (Array.isArray(data?.events)) {
        for (const item of data.events) {
          if (item?.ts) {
            ;(markPoints as any[]).push({ name: `分红-${codeNameMap[code]}: ${item.plan}`, x: item.ts, color: 'red' })
          }
        }
      }
      callback(data)
    })
  }

  function fetchReportUrl(qtype: string, code: number, callback: (url: string | null) => void) {
    const cacheKey = `${qtype}-${code}-ru`
    fetchRequest({
      url: `${server}/api/report/url?qtype=${qtype}&code=${code}`,
      cacheKey,
      cacheTtl: 360000,
    }).then((data: any) => {
      callback(data)
    })
  }

  function fetchCompanyInfo(code: string, callback: Callback) {
    const cacheKey = `${code}-ci`
    fetchRequest({
      url: `${server}/api/company/info?code=${code}`,
      cacheKey,
      cacheTtl: 360000,
    }).then((data: any) => {
      const info = data.data
      if (!codeNameMap[code] && info?.shortName) {
        codeNameMap[code] = info.shortName
        localStorage.setItem('codeNameMap', JSON.stringify(codeNameMap))
      }
      if (!usCodeMap[code] && info?.secCode) {
        usCodeMap[code] = info.secCode
      }
      callback(info)
    })
  }

  function fetchCompanyFreeHolders(code: string, callback: (code: string) => void) {
    if (!code) {
      console.log('错误的公司代码', code)
      return
    }
    const cacheKey = `${code}-cfh`
    fetch(`/api/finance/freeholders?code=${code}`)
      .then((response) => response.json())
      .then((data: any) => {
        if (data.code === 200 && data.data) {
          cache[cacheKey] = data.data
        }
        callback(code)
      })
      .catch((error) => {
        console.error('fetchCompanyFreeHolders error:', error)
        callback(code)
      })
  }

  function fetchCompanyOrgHolders(code: string, reportDate: string, callback: (code: string, reportDate: string) => void) {
    if (!code || !reportDate) {
      console.log('错误的公司代码或报告日期', code, reportDate)
      return
    }
    const cacheKey = `${code}-${reportDate}-coh`
    fetch(`/api/finance/orgholders?code=${code}&reportDate=${reportDate}`)
      .then((response) => response.json())
      .then((data: any) => {
        if (data.code === 200 && data.data) {
          cache[cacheKey] = data.data
        }
        callback(code, reportDate)
      })
      .catch((error) => {
        console.error('fetchCompanyOrgHolders error:', error)
        callback(code, reportDate)
      })
  }

  function fetchFundInfo(code: string, callback: (code: string) => void) {
    const cacheKey = `${code}-fi`
    fetchRequest({
      url: `${server}/api/fund/info?code=${code}`,
      cacheKey,
      cacheTtl: 360000,
    }).then(() => {
      callback(code)
    })
  }

  function fetchCodeNames(codes: string[], callback: Callback) {
    if (codes.length < 1) {
      callback({})
      return
    }

    codes.sort()
    fetchRequest({
      url: `${server}/api/code/name?${queryString({ code: codes.join(',') })}`,
      cacheKey: `fetchCodeNames${codes.join(',')}`,
      cacheTtl: 360000,
    }).then((data: any) => {
      let hasNew = false
      for (const code in data) {
        if (data[code]) {
          hasNew = true
          codeNameMap[code] = data[code]
        }
      }
      if (hasNew) {
        localStorage.setItem('codeNameMap', JSON.stringify(codeNameMap))
      }
      callback(data)
    })
  }

  return {
    fetchCodesData,
    fetchFinanceIncome,
    fetchFinanceBalance,
    fetchFinanceCashflow,
    fetchKline,
    fetchKlines,
    fetchFundPosition,
    fetchShareChanges,
    fetchShareChange,
    fetchDividendYields,
    fetchShareAdditional,
    fetchShareBonus,
    fetchDividendYield,
    fetchReportUrl,
    fetchCompanyInfo,
    fetchCompanyFreeHolders,
    fetchCompanyOrgHolders,
    fetchFundInfo,
    fetchCodeNames,
  }
}
