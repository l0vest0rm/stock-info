import financeMappings from '../../shared/finance-mappings.json'

type FinanceKeyRow = string[]

interface FinanceMappings {
  marketMap: Record<string, number>
  usCodeMap: Record<string, string>
  bankCodes: string[]
  ignoreKeys: string[]
  coreKeys: FinanceKeyRow[]
  incomeKeys: FinanceKeyRow[]
  balanceKeys: FinanceKeyRow[]
  cashflowKeys: FinanceKeyRow[]
}

const financeConstants = financeMappings as FinanceMappings

export const marketMap = financeConstants.marketMap
export const usCodeMap = financeConstants.usCodeMap
export const bankCodes = financeConstants.bankCodes
export const ignoreKeys = financeConstants.ignoreKeys
export const coreKeys = financeConstants.coreKeys
export const incomeKeys = financeConstants.incomeKeys
export const balanceKeys = financeConstants.balanceKeys
export const cashflowKeys = financeConstants.cashflowKeys

export function isCodeBank(code: string): boolean {
  return bankCodes.includes(code)
}

export function isAstockCompany(code: string): boolean {
  return code.endsWith('.SZ') || code.endsWith('.SH') || code.endsWith('.BJ')
}

export function isHkCompany(code: string): boolean {
  return code.endsWith('.HK')
}

export function isUsCompany(code: string): boolean {
  return code.endsWith('.US') || code.endsWith('.O') || code.endsWith('.N')
}

export function genReportDates(years: number): string[] {
  const date = new Date()
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const dates: string[] = []
  for (let i = 0; i < years; i++) {
    if (i > 0) {
      dates.push(`${year - i}-12-31`)
    }
    if (i !== 0 || month > 9) {
      dates.push(`${year - i}-09-30`)
    }
    if (i !== 0 || month > 6) {
      dates.push(`${year - i}-06-30`)
    }
    if (i !== 0 || month > 3) {
      dates.push(`${year - i}-03-31`)
    }
  }
  return dates
}

export function genReportDatesUS(years: number, seasonOnly: boolean): string[] {
  const seasonMap: string[][] = [
    ['Q1', 'Q1'],
    ['Q2', 'Q6'],
    ['Q3', 'Q9'],
    ['Q4', 'FY'],
  ]
  const idx = seasonOnly ? 0 : 1
  const date = new Date()
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const dates: string[] = []
  for (let i = 0; i < years; i++) {
    if (i > 0) {
      dates.push(`${year - i}/${seasonMap[3][idx]}`)
    }
    if (i !== 0 || month > 9) {
      dates.push(`${year - i}/${seasonMap[2][idx]}`)
    }
    if (i !== 0 || month > 6) {
      dates.push(`${year - i}/${seasonMap[1][idx]}`)
    }
    if (i !== 0 || month > 3) {
      dates.push(`${year - i}/${seasonMap[0][idx]}`)
    }
  }
  return dates
}

export function calcFinanceCacheTtl(code: string): number {
  let startTs = 0, endTs = 0
  if (code.endsWith('.SZ') || code.endsWith('.SH') || code.endsWith('.BJ') || code.endsWith('.ZF') || code.endsWith('.SF')
    || code.endsWith('.ZI') || code.endsWith('.SI') || code.endsWith('.HI')) {
    startTs = (7 * 60 + 10) * 60
    endTs = 60 * 60
  } else if (code.endsWith('.HK')) {
    startTs = (8 * 60 + 10) * 60
    endTs = 60 * 60
  } else if (code.endsWith('.US') || code.endsWith('.O') || code.endsWith('.N') || code.endsWith('.AF')) {
    startTs = (21 * 60 + 10) * 60
    endTs = (14 * 60 + 30) * 60
  } else if (code.endsWith('.OF')) {
    startTs = (7 * 60 + 10) * 60
    endTs = (15 * 60 + 59) * 60
  } else {
    throw Error(`calcFinanceCacheTtl unknown code:${code}`)
  }
  return calcCacheTtl(startTs, endTs, 1800)
}

function calcCacheTtl(startTs: number, endTs: number, minTtl: number): number {
  let ts = Date.now()
  ts = Math.floor(ts / 1000)
  ts = ts - Math.floor(ts / (3600 * 24)) * 3600 * 24

  const d = new Date()
  if (d.getDay() === 6 && d.getHours() > 5) {
    return 3600 * 24
  } else if (d.getDay() === 0) {
    return startTs - ts + 3600 * 24
  }

  let ttl = 0
  if (startTs < endTs) {
    if (ts >= startTs && ts < endTs) {
      return minTtl
    }
  } else {
    if (ts >= startTs || ts < endTs) {
      return minTtl
    }
  }

  ttl = startTs - ts
  if (ttl < 0) {
    ttl += 3600 * 24
  }

  if (ttl < minTtl) {
    ttl = minTtl
  }

  return ttl
}
