export type LegacyReportsMap = Record<string, any[]>

export type LegacyRuntimeState = {
  cache: Record<string, unknown>
  code: string
  klineCodes: string[]
  selectedCodes: string[]
  markPoints: unknown[]
  codeNameMap: Record<string, string>
  reportsMap: LegacyReportsMap
  securities: string[][]
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
