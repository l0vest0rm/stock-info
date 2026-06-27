import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type RestrictionRow = {
  liftDate: string
  liftNumWan: string
  totalSharesRatio: string
  unlimitedASharesRatio: string
  liftType: string
}

type ShareStructureRow = {
  changeDate: string
  totalShares: string
  changeShares: string
  changeRatio: string
  changeReason: string
  limitedShares: string
  limitedStateLegal: string
  limitedOthers: string
  limitedDomesticNostate: string
  limitedDomesticNatural: string
  unlimitedShares: string
  listedAShares: string
}

type CompanySharesStateEvent = CustomEvent<{
  restrictionRows?: RestrictionRow[]
  shareStructureRows?: ShareStructureRow[]
}>

const RestrictionTable = defineComponent({
  name: 'CompanySharesRestrictionTable',
  setup() {
    const rows = ref<RestrictionRow[]>([])

    const onState = (event: Event) => {
      const detail = (event as CompanySharesStateEvent).detail
      if (Array.isArray(detail?.restrictionRows)) {
        rows.value = detail.restrictionRows
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-shares-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-shares-state', onState)
    })

    return () => h('div', [
      h('h5', { class: 'ms-3' }, '限售解禁'),
      h('table', { id: 'restrictionTable', class: 'table table-bordered table-hover' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', '解禁时间'),
            h('th', '解禁数量(万股)'),
            h('th', '解禁股占总股本比例%'),
            h('th', '解禁股占流动股本比例%'),
            h('th', '股票类型'),
          ]),
        ]),
        h('tbody', rows.value.map((row) => h('tr', { key: `${row.liftDate}-${row.liftType}-${row.liftNumWan}` }, [
          h('td', row.liftDate),
          h('td', row.liftNumWan),
          h('td', row.totalSharesRatio),
          h('td', row.unlimitedASharesRatio),
          h('td', row.liftType),
        ]))),
      ]),
    ])
  },
})

const ShareStructureTable = defineComponent({
  name: 'CompanySharesStructureTable',
  setup() {
    const rows = ref<ShareStructureRow[]>([])

    const onState = (event: Event) => {
      const detail = (event as CompanySharesStateEvent).detail
      if (Array.isArray(detail?.shareStructureRows)) {
        rows.value = detail.shareStructureRows
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-shares-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-shares-state', onState)
    })

    return () => h('table', { id: 'shareTable', class: 'table table-bordered table-hover' }, [
      h('thead', { class: 'table-info' }, [
        h('tr', [
          h('th', '日期(万股)'),
          h('th', '总股本'),
          h('th', '总股本变动'),
          h('th', '总股本变动%'),
          h('th', '变动原因'),
          h('th', '流通受限股份'),
          h('th', '国有法人持股(受限)'),
          h('th', '其他内资持股(受限)'),
          h('th', '境内法人持股(受限)'),
          h('th', '境内自然人持股(受限)'),
          h('th', '已流通股份'),
          h('th', '已上市流通A股'),
        ]),
      ]),
      h('tbody', rows.value.map((row) => h('tr', { key: `${row.changeDate}-${row.totalShares}-${row.changeShares}` }, [
        h('td', row.changeDate),
        h('td', row.totalShares),
        h('td', row.changeShares),
        h('td', row.changeRatio),
        h('td', row.changeReason),
        h('td', row.limitedShares),
        h('td', row.limitedStateLegal),
        h('td', row.limitedOthers),
        h('td', row.limitedDomesticNostate),
        h('td', row.limitedDomesticNatural),
        h('td', row.unlimitedShares),
        h('td', row.listedAShares),
      ]))),
    ])
  },
})

const restrictionRoot = document.getElementById('company-shares-restriction-vue-root')
if (restrictionRoot) {
  createApp(RestrictionTable).mount(restrictionRoot)
}

const structureRoot = document.getElementById('company-shares-structure-vue-root')
if (structureRoot) {
  createApp(ShareStructureTable).mount(structureRoot)
}

