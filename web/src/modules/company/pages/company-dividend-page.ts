import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompanyBonusRow = {
  noticeDate: string
  plan: string
  progress: string
  recordDate: string
  divDate: string
  recordPrice: string
  recordYield: string
  latestYield: string
  bonusTotal: string
}

type CompanyShareAdditionalRow = {
  noticeDate: string
  issueNum: string
  netRaiseFunds: string
  issuePrice: string
  issueWay: string
  recordDate: string
  noticeDateClose: string
  recordDateClose: string
}

type CompanyDividendStateEvent = CustomEvent<{
  bonusRows?: CompanyBonusRow[]
  shareAdditionalRows?: CompanyShareAdditionalRow[]
}>

const CompanyDividendPage = defineComponent({
  name: 'CompanyDividendPage',
  setup() {
    const bonusRows = ref<CompanyBonusRow[]>([])
    const shareAdditionalRows = ref<CompanyShareAdditionalRow[]>([])

    const onState = (event: Event) => {
      const detail = (event as CompanyDividendStateEvent).detail
      if (!detail) {
        return
      }
      if (Array.isArray(detail.bonusRows)) {
        bonusRows.value = detail.bonusRows
      }
      if (Array.isArray(detail.shareAdditionalRows)) {
        shareAdditionalRows.value = detail.shareAdditionalRows
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-dividend-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-dividend-state', onState)
    })

    return () => h('div', { class: 'company-dividend-page' }, [
      h('table', { id: 'bonusTable', class: 'table table-bordered table-hover' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', '公告日期'),
            h('th', '分红方案'),
            h('th', '方案进度'),
            h('th', '股权登记日'),
            h('th', '除权除息日'),
            h('th', '登记日股价'),
            h('th', '登记日股息率%'),
            h('th', '最新价股息率%'),
            h('th', '分红总额(亿元)'),
          ]),
        ]),
        h('tbody', bonusRows.value.map((row) => h('tr', [
          h('td', row.noticeDate),
          h('td', row.plan),
          h('td', row.progress),
          h('td', row.recordDate),
          h('td', row.divDate),
          h('td', row.recordPrice),
          h('td', row.recordYield),
          h('td', row.latestYield),
          h('td', row.bonusTotal),
        ]))),
      ]),
      h('h5', { class: 'ms-3' }, '增发明细'),
      h('table', { id: 'shareAdditionalTable', class: 'table table-bordered table-hover' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', '增发时间'),
            h('th', '实际增发数量(亿股)'),
            h('th', '实际募集净额(亿元)'),
            h('th', '增发价格(元/股)'),
            h('th', '发行方式'),
            h('th', '股权登记日'),
            h('th', '增发日收盘价'),
            h('th', '登记日收盘价'),
          ]),
        ]),
        h('tbody', shareAdditionalRows.value.map((row) => h('tr', [
          h('td', row.noticeDate),
          h('td', row.issueNum),
          h('td', row.netRaiseFunds),
          h('td', row.issuePrice),
          h('td', row.issueWay),
          h('td', row.recordDate),
          h('td', row.noticeDateClose),
          h('td', row.recordDateClose),
        ]))),
      ]),
    ])
  },
})

const root = document.getElementById('company-dividend-vue-root')
if (root) {
  createApp(CompanyDividendPage).mount(root)
}

