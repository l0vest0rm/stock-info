export type CompanyReportRow = {
  rank: number
  publishDate: string
  title: string
  provenance: string
  reportHref: string
  reportLocked: boolean
  docId: string
  revenue2025: string
  revenueGrowth2025: string
  profit2025: string
  profitMargin2025: string
  growth2025: string
  profitEstimated2025: boolean
  pe2025: string
  revenue2026: string
  revenueGrowth2026: string
  profit2026: string
  profitMargin2026: string
  growth2026: string
  profitEstimated2026: boolean
  pe2026: string
  revenue2027: string
  revenueGrowth2027: string
  profit2027: string
  profitMargin2027: string
  growth2027: string
  profitEstimated2027: boolean
  pe2027: string
  revenue2028: string
  revenueGrowth2028: string
  profit2028: string
  profitMargin2028: string
  growth2028: string
  profitEstimated2028: boolean
  pe2028: string
  valuation: string
  targetPrice: string
  orgName: string
  pages: string
  llmRawResponse?: unknown | null
}


export type CompanyReportStatePatch = {
  rows?: CompanyReportRow[]
  currentPage?: number
  hasNext?: boolean
  status?: string
  error?: boolean
  discoveryEnabled?: boolean
  discoveryTaskName?: string | null
  discoveryStatus?: string
  discoveryMessage?: string
  discoveryBusy?: boolean
  discoveryCreatedAt?: number | null
  discoveryStartedAt?: number | null
  discoveryCompletedAt?: number | null
  discoveryUpdatedAt?: number | null
  discoveryLastSuccessfulAt?: number | null
  discoveryModel?: string | null
}
