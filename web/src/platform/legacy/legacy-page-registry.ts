export type PageInitializer = () => void | Promise<void>

type LegacyPageRegistryContext = Record<string, any>

const initStaticPage: PageInitializer = () => {}

let analysisTaskQueuePromise: Promise<any> | null = null

async function getAnalysisTaskQueue(context: LegacyPageRegistryContext) {
  if (!analysisTaskQueuePromise) {
    analysisTaskQueuePromise = (async () => {
      const { AnalysisTaskQueue, installAnalysisTaskQueueStyles } = await import('../../analysis-task-queue')
      installAnalysisTaskQueueStyles()
      return new AnalysisTaskQueue({
        server: context.server,
        reportAnalysisCacheVersion: context.reportAnalysisCacheVersion,
      })
    })()
  }
  return analysisTaskQueuePromise
}

function createCompanyPagesContext(context: LegacyPageRegistryContext) {
  return {
    server: context.server,
    reportAnalysisCacheVersion: context.reportAnalysisCacheVersion,
    analysisTaskQueue: context.analysisTaskQueue,
    alert: context.alert,
    echarts: context.echarts,
    fetchRequest: context.fetchRequest,
    fetchCodeNames: context.fetchCodeNames,
    fetchFinanceIncome: context.fetchFinanceIncome,
    fetchReportUrl: context.fetchReportUrl,
    fetchCodesData: context.fetchCodesData,
    fetchShareChange: context.fetchShareChange,
    toDateString: context.toDateString,
    toTimestamp: context.toTimestamp,
    rerenderMyChart: context.rerenderMyChart,
    dateRangeInit: context.dateRangeInit,
    codeSelectInit: context.codeSelectInit,
    klineOptionsInit: context.klineOptionsInit,
    marketProcess: context.marketProcess,
    onKlineCodeSelectChange: context.onKlineCodeSelectChange,
    klinePriceChange: context.klinePriceChange,
    marklineFinanceReportDate: context.marklineFinanceReportDate,
    onRatioCheckChange: context.onRatioCheckChange,
    onAlignStartCheckChange: context.onAlignStartCheckChange,
    bsRadioButtons: context.bsRadioButtons,
    genFinanceChart: context.genFinanceChart,
    financeCharTableOnChange: context.financeCharTableOnChange,
    onFinanceCodeSelectChange: context.onFinanceCodeSelectChange,
    getSelectedCodes: context.getSelectedCodes,
    getCode: context.getCode,
    getCache: context.getCache,
    getKlineCodes: context.getKlineCodes,
    getCodeNameMap: context.getCodeNameMap,
    coreKeys: context.coreKeys,
    incomeKeys: context.incomeKeys,
    balanceKeys: context.balanceKeys,
    cashflowKeys: context.cashflowKeys,
  }
}

function createFundPagesContext(context: LegacyPageRegistryContext) {
  return {
    server: context.server,
    echarts: context.echarts,
    fetchRequest: context.fetchRequest,
    fetchFundPosition: context.fetchFundPosition,
    fetchFundInfo: context.fetchFundInfo,
    renderFundInfoTable: context.renderFundInfoTable,
    fetchCodesData: context.fetchCodesData,
    fetchCompanyInfo: context.fetchCompanyInfo,
    fillSelectOptions: context.fillSelectOptions,
    fetchKlines: context.fetchKlines,
    rerenderMyChart: context.rerenderMyChart,
    bsTable: context.bsTable,
    toTimestamp: context.toTimestamp,
    findTsIndex: context.findTsIndex,
    dateRangeInit: context.dateRangeInit,
    klinePriceChange: context.klinePriceChange,
    positionCheckOnChange: context.positionCheckOnChange,
    emitFundState: context.emitFundState,
    genFullCode: context.genFullCode,
    getCode: context.getCode,
    getCache: context.getCache,
    getCodeNameMap: context.getCodeNameMap,
    getSelectedCodes: context.getSelectedCodes,
    setSelectedCodes: context.setSelectedCodes,
    setKlineCodes: context.setKlineCodes,
  }
}

async function createPortfolioPageInitializer(context: LegacyPageRegistryContext): Promise<PageInitializer> {
  const [{ createPortfolioInitializer }, { createPortfolioRuntime }] = await Promise.all([
    import('../../modules/portfolio/runtime/portfolio-page-runtime'),
    import('../../modules/portfolio/runtime/portfolio-runtime'),
  ])
  const portfolioRuntime = createPortfolioRuntime({
    runtimeState: context.runtimeState,
    selectedOptionValues: context.selectedOptionValues,
    fetchKlines: context.fetchKlines,
    rerenderMyChart: context.rerenderMyChart,
    bsTable: context.bsTable,
  })
  return createPortfolioInitializer({
    dateRangeInit: context.dateRangeInit,
    codeSelectInit: context.codeSelectInit,
    portfolioRuntime,
    alert: context.alert,
  })
}

async function createKnowledgeNewsPageInitializer(context: LegacyPageRegistryContext): Promise<PageInitializer> {
  const { createKnowledgeNewsInitializer } = await import('../../modules/knowledge/runtime/knowledge-news-runtime')
  return createKnowledgeNewsInitializer({
    server: context.server,
    fetchRequest: context.fetchRequest,
    escapeHtml: context.escapeHtml,
  })
}

export async function loadLegacyPageInitializer(page: string, context: LegacyPageRegistryContext): Promise<PageInitializer | null> {
  switch (page) {
    case '':
    case 'index.html': {
      const { createIndexInitializer } = await import('../../modules/index/runtime/index-runtime')
      return createIndexInitializer({
        dateRangeInit: context.dateRangeInit,
        codeSelectInit: context.codeSelectInit,
        selectedOptionValues: context.selectedOptionValues,
        getSelectedCodes: context.getSelectedCodes,
        setSelectedCodes: context.setSelectedCodes,
        fetchKlines: context.fetchKlines,
        setKlineCodes: context.setKlineCodes,
        getCodeNameMap: context.getCodeNameMap,
        rerenderMyChart: context.rerenderMyChart,
        onRatioCheckChange: context.onRatioCheckChange,
        onAlignStartCheckChange: context.onAlignStartCheckChange,
      })
    }
    case '13f.html': {
      const { createThirteenFInitializer } = await import('../../modules/thirteenf/runtime/thirteenf-runtime')
      return createThirteenFInitializer({
        server: context.server,
        fetchRequest: context.fetchRequest,
      })
    }
    case '13f-position.html': {
      const { createThirteenFPositionInitializer } = await import('../../modules/thirteenf/runtime/thirteenf-position-runtime')
      return createThirteenFPositionInitializer({
        server: context.server,
        fetchRequest: context.fetchRequest,
        fetchKline: context.fetchKline,
        fetchCodeNames: context.fetchCodeNames,
        bsTable: context.bsTable,
        genSimpleBarLineChart: context.genSimpleBarLineChart,
        getCodeNameMap: context.getCodeNameMap,
        echarts: context.echarts,
      })
    }
    case 'companies-filter.html': {
      const { createCompaniesFilterInitializer } = await import('../../modules/companies/runtime/companies-filter-runtime')
      return createCompaniesFilterInitializer({
        server: context.server,
        fetchRequest: context.fetchRequest,
        bsSelect: context.bsSelect,
        selectedOptionValues: context.selectedOptionValues,
        hash: context.hash,
        generateMarketDataMap: context.generateMarketDataMap,
        fetchKlines: context.fetchKlines,
        follow: context.follow,
        unFollow: context.unFollow,
        cacheCodeName: context.cacheCodeName,
        fetchKline: context.fetchKline,
        generateMarketTable: context.generateMarketTable,
      })
    }
    case 'companies-change.html': {
      const { createCompaniesChangeInitializer } = await import('../../modules/companies/runtime/companies-change-runtime')
      return createCompaniesChangeInitializer({
        fetchRequest: context.fetchRequest,
      })
    }
    case 'sector-flow.html': {
      const { createSectorFlowInitializer } = await import('../../modules/market/runtime/sector-flow-runtime')
      return createSectorFlowInitializer({
        fetchRequest: context.fetchRequest,
      })
    }
    case 'companies-follow.html': {
      const { createCompaniesFollowInitializer } = await import('../../modules/companies/runtime/companies-follow-runtime')
      return createCompaniesFollowInitializer({
        server: context.server,
        query: context.query,
        fetchRequest: context.fetchRequest,
        cache: context.cache,
        codeNameMap: context.getCodeNameMap(),
        fetchCodeNames: context.fetchCodeNames,
        fetchKlines: context.fetchKlines,
        fetchCodesData: context.fetchCodesData,
        fetchFinanceIncome: context.fetchFinanceIncome,
        selectedOptionValues: context.selectedOptionValues,
        replaceUrlParam: context.replaceUrlParam,
        codeSelectInit: context.codeSelectInit,
      })
    }
    case 'companies-holding.html': {
      const { createCompaniesHoldingInitializer } = await import('../../modules/companies/runtime/companies-holding-runtime')
      return createCompaniesHoldingInitializer({
        fetchRequest: context.fetchRequest,
        query: context.query,
      })
    }
    case 'company-dividend.html': {
      const { createCompanyDividendInitializer } = await import('../../modules/company/runtime/company-dividend-runtime')
      return createCompanyDividendInitializer({
        getCode: context.getCode,
        server: context.server,
        fetchRequest: context.fetchRequest,
        fetchKline: context.fetchKline,
        fetchShareAdditional: context.fetchShareAdditional,
        findTsIndex: context.findTsIndex,
        toTimestamp: context.toTimestamp,
      })
    }
    case 'company-holders.html': {
      const { createCompanyHoldersInitializer } = await import('../../modules/company/runtime/company-holders-runtime')
      return createCompanyHoldersInitializer({
        getCode: context.getCode,
        fetchCompanyFreeHolders: context.fetchCompanyFreeHolders,
        fetchCompanyOrgHolders: context.fetchCompanyOrgHolders,
        getCache: context.getCache,
      })
    }
    case 'company-notice.html': {
      const { createCompanyNoticeInitializer } = await import('../../modules/company/runtime/company-notice-runtime')
      return createCompanyNoticeInitializer({
        getCode: context.getCode,
        server: context.server,
        fetchRequest: context.fetchRequest,
        queryString: context.queryString,
        alert: context.alert,
      })
    }
    case 'company-option.html': {
      const { createCompanyOptionInitializer } = await import('../../modules/company/runtime/company-option-runtime')
      return createCompanyOptionInitializer({
        getCode: context.getCode,
        query: context.query,
        server: context.server,
        fetchRequest: context.fetchRequest,
        escapeHtml: context.escapeHtml,
        zeroPad: context.zeroPad,
        echartsColor: context.echartsColor,
        echarts: context.echarts,
      })
    }
    case 'company-option-theta.html': {
      const { createCompanyOptionThetaInitializer } = await import('../../modules/company/runtime/company-option-theta-runtime')
      return createCompanyOptionThetaInitializer({
        getCode: context.getCode,
        server: context.server,
        fetchRequest: context.fetchRequest,
        echartsColor: context.echartsColor,
      })
    }
    case 'company-report-predict.html': {
      const { createCompanyReportPredictInitializer } = await import('../../modules/company/runtime/company-report-predict-runtime')
      return createCompanyReportPredictInitializer({
        server: context.server,
        fetchRequest: context.fetchRequest,
        fetchReportUrl: context.fetchReportUrl,
        toDateString: context.toDateString,
        selectChangeValue: context.selectChangeValue,
        alert: context.alert,
      })
    }
    case 'company-finance.html': {
      const { createCompanyFinanceInitializer } = await import('../../modules/company/runtime/company-pages-runtime')
      return createCompanyFinanceInitializer({
        financeCharTableOnChange: context.financeCharTableOnChange,
        onFinanceCodeSelectChange: context.onFinanceCodeSelectChange,
        codeSelectInit: context.codeSelectInit,
        bsRadioButtons: context.bsRadioButtons,
        genFinanceChart: context.genFinanceChart,
        getSelectedCodes: context.getSelectedCodes,
        coreKeys: context.coreKeys,
        incomeKeys: context.incomeKeys,
        balanceKeys: context.balanceKeys,
        cashflowKeys: context.cashflowKeys,
      })
    }
    case 'company-news.html':
    case 'company-report.html':
    case 'company-shares.html':
    case 'company.html': {
      const analysisTaskQueue = await getAnalysisTaskQueue(context)
      const {
        createCompanyInitializer,
        createCompanyNewsInitializer,
        createCompanyReportInitializer,
        createCompanySharesInitializer,
      } = await import('../../modules/company/runtime/company-pages-runtime')
      const companyPagesContext = createCompanyPagesContext({
        ...context,
        analysisTaskQueue,
      })
      if (page === 'company-news.html') {
        return createCompanyNewsInitializer(companyPagesContext)
      }
      if (page === 'company-report.html') {
        return createCompanyReportInitializer(companyPagesContext)
      }
      if (page === 'company-shares.html') {
        return createCompanySharesInitializer(companyPagesContext)
      }
      return createCompanyInitializer(companyPagesContext)
    }
    case 'funds.html': {
      const { createFundsInitializer } = await import('../../modules/fund/runtime/funds-runtime')
      return createFundsInitializer({
        fetchRequest: context.fetchRequest,
      })
    }
    case 'fund.html':
    case 'fund-position.html':
    case 'fund-notice.html':
    case 'index-position.html': {
      if (page === 'fund-notice.html') {
        const { createFundNoticeInitializer } = await import('../../modules/fund/runtime/fund-notice-runtime')
        return createFundNoticeInitializer({
          server: context.server,
          fetchRequest: context.fetchRequest,
          getCode: context.getCode,
        })
      }
      const {
        createFundInitializer,
        createFundPositionInitializer,
        createIndexPositionInitializer,
      } = await import('../../modules/fund/runtime/fund-pages-runtime')
      const fundPagesContext = createFundPagesContext(context)
      if (page === 'fund-position.html') {
        return createFundPositionInitializer(fundPagesContext)
      }
      if (page === 'index-position.html') {
        return createIndexPositionInitializer(fundPagesContext)
      }
      return createFundInitializer(fundPagesContext)
    }
    case 'home.html':
    case 'invest.html':
    case 'login.html':
      return initStaticPage
    case 'info.html': {
      const { createInfoInitializer } = await import('../../modules/home/runtime/info-runtime')
      return createInfoInitializer({
        getCodeNameMap: context.getCodeNameMap,
        getReportsMap: context.getReportsMap,
        readSelectedOptionValues: context.selectedOptionValues,
        setSelectedCodes: context.setSelectedCodes,
        fetch2FormatFinanceData: context.fetch2FormatFinanceData,
        codeSelectInit: context.codeSelectInit,
        bsRadioButtons: context.bsRadioButtons,
      })
    }
    case 'knowledge-config.html': {
      const { createKnowledgeConfigInitializer } = await import('../../modules/knowledge/runtime/knowledge-config-runtime')
      return createKnowledgeConfigInitializer({
        server: context.server,
        fetchRequest: context.fetchRequest,
        parseResponseData: context.parseResponseData,
        escapeHtml: context.escapeHtml,
        alert: context.alert,
      })
    }
    case 'portfolio.html':
      return createPortfolioPageInitializer(context)
    case 'research-news.html':
      return createKnowledgeNewsPageInitializer(context)
    case 'stock-table.html': {
      const { createStockTableInitializer } = await import('../../modules/market/runtime/stock-table-runtime')
      return createStockTableInitializer({
        loadEtfCodes: context.loadEtfCodes,
        getEtfCodes: context.getEtfCodes,
        fetchKlines: context.fetchKlines,
        genratePerformanceTable: context.genratePerformanceTable,
      })
    }
    default:
      return null
  }
}
