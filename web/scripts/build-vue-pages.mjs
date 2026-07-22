import fs from 'node:fs'
import { resolve } from 'node:path'
import { build, defineConfig } from 'vite'

const pageEntries = [
  {
    entry: 'src/modules/company/pages/company-option-theta-page.ts',
    globalName: 'LicaiCompanyOptionThetaPage',
    fileName: 'js/company-option-theta-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-option-page.ts',
    globalName: 'LicaiCompanyOptionPage',
    fileName: 'js/company-option-page.js',
  },
  {
    entry: 'src/modules/home/pages/home-page.ts',
    globalName: 'LicaiHomePage',
    fileName: 'js/home-page.js',
  },
  {
    entry: 'src/modules/index/pages/index-page.ts',
    globalName: 'LicaiIndexPage',
    fileName: 'js/index-page.js',
  },
  {
    entry: 'src/modules/index/pages/index-position-page.ts',
    globalName: 'LicaiIndexPositionPage',
    fileName: 'js/index-position-page.js',
  },
  {
    entry: 'src/modules/home/pages/invest-page.ts',
    globalName: 'LicaiInvestPage',
    fileName: 'js/invest-page.js',
  },
  {
    entry: 'src/modules/home/pages/login-page.ts',
    globalName: 'LicaiLoginPage',
    fileName: 'js/login-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-report-predict-page.ts',
    globalName: 'LicaiCompanyReportPredictPage',
    fileName: 'js/company-report-predict-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-page.ts',
    globalName: 'LicaiCompanyPage',
    fileName: 'js/company-page.js',
  },
  {
    entry: 'src/modules/knowledge/pages/knowledge-news-page.ts',
    globalName: 'LicaiKnowledgeNewsPage',
    fileName: 'js/knowledge-news-page.js',
  },
  {
    entry: 'src/modules/knowledge/pages/knowledge-config-page.ts',
    globalName: 'LicaiKnowledgeConfigPage',
    fileName: 'js/knowledge-config-page.js',
  },
  {
    entry: 'src/modules/portfolio/pages/portfolio-page.ts',
    globalName: 'LicaiPortfolioPage',
    fileName: 'js/portfolio-page.js',
  },
  {
    entry: 'src/modules/companies/pages/companies-follow-page.ts',
    globalName: 'LicaiCompaniesFollowPage',
    fileName: 'js/companies-follow-page.js',
  },
  {
    entry: 'src/modules/companies/pages/companies-holding-page.ts',
    globalName: 'LicaiCompaniesHoldingPage',
    fileName: 'js/companies-holding-page.js',
  },
  {
    entry: 'src/modules/companies/pages/companies-filter-page.ts',
    globalName: 'LicaiCompaniesFilterPage',
    fileName: 'js/companies-filter-page.js',
  },
  {
    entry: 'src/modules/companies/pages/companies-change-page.ts',
    globalName: 'LicaiCompaniesChangePage',
    fileName: 'js/companies-change-page.js',
  },
  {
    entry: 'src/modules/market/pages/sector-flow-page.ts',
    globalName: 'LicaiSectorFlowPage',
    fileName: 'js/sector-flow-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-holders-page.ts',
    globalName: 'LicaiCompanyHoldersPage',
    fileName: 'js/company-holders-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-dividend-page.ts',
    globalName: 'LicaiCompanyDividendPage',
    fileName: 'js/company-dividend-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-notice-page.ts',
    globalName: 'LicaiCompanyNoticePage',
    fileName: 'js/company-notice-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-shares-page.ts',
    globalName: 'LicaiCompanySharesPage',
    fileName: 'js/company-shares-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-report-page.ts',
    globalName: 'LicaiCompanyReportPage',
    fileName: 'js/company-report-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-news-page.ts',
    globalName: 'LicaiCompanyNewsPage',
    fileName: 'js/company-news-page.js',
  },
  {
    entry: 'src/modules/company/pages/company-finance-page.ts',
    globalName: 'LicaiCompanyFinancePage',
    fileName: 'js/company-finance-page.js',
  },
  {
    entry: 'src/modules/fund/pages/fund-position-page.ts',
    globalName: 'LicaiFundPositionPage',
    fileName: 'js/fund-position-page.js',
  },
  {
    entry: 'src/modules/fund/pages/fund-notice-page.ts',
    globalName: 'LicaiFundNoticePage',
    fileName: 'js/fund-notice-page.js',
  },
  {
    entry: 'src/modules/fund/pages/fund-page.ts',
    globalName: 'LicaiFundPage',
    fileName: 'js/fund-page.js',
  },
  {
    entry: 'src/modules/fund/pages/funds-page.ts',
    globalName: 'LicaiFundsPage',
    fileName: 'js/funds-page.js',
  },
  {
    entry: 'src/modules/home/pages/info-page.ts',
    globalName: 'LicaiInfoPage',
    fileName: 'js/info-page.js',
  },
  {
    entry: 'src/modules/market/pages/stock-table-page.ts',
    globalName: 'LicaiStockTablePage',
    fileName: 'js/stock-table-page.js',
  },
  {
    entry: 'src/modules/thirteenf/pages/thirteenf-page.ts',
    globalName: 'LicaiThirteenFPage',
    fileName: 'js/thirteenf-page.js',
  },
  {
    entry: 'src/modules/thirteenf/pages/thirteenf-position-page.ts',
    globalName: 'LicaiThirteenFPositionPage',
    fileName: 'js/thirteenf-position-page.js',
  },
]

const expectedFiles = new Set()
for (const page of pageEntries) {
  expectedFiles.add(page.fileName)
  expectedFiles.add(`${page.fileName}.map`)
}

const distJsDir = resolve('dist/js')
if (fs.existsSync(distJsDir)) {
  for (const item of fs.readdirSync(distJsDir, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.includes('-page.js')) {
      continue
    }
    const relativeName = `js/${item.name}`
    if (!expectedFiles.has(relativeName)) {
      fs.rmSync(resolve(distJsDir, item.name), { force: true })
    }
  }
}

for (const page of pageEntries) {
  await build(defineConfig({
    configFile: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    publicDir: false,
    build: {
      emptyOutDir: false,
      lib: {
        entry: resolve(page.entry),
        formats: ['iife'],
        name: page.globalName,
        fileName: () => page.fileName,
      },
      outDir: 'dist',
      sourcemap: true,
      target: 'es2017',
    },
  }))
}
