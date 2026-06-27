import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type FundInfo = {
  code: string
  name: string
  manager: string
  company: string
  beginDate: string
  updateDate: string
  style: string
  scale: string
}

type FundStateEvent = CustomEvent<{
  info?: FundInfo
  status?: string
}>

const FundPage = defineComponent({
  name: 'FundPage',
  setup() {
    const info = ref<FundInfo | null>(null)
    const statusText = ref('加载中...')

    const onState = (event: Event) => {
      const detail = (event as FundStateEvent).detail
      if (!detail) {
        return
      }
      if (detail.info) {
        info.value = detail.info
      }
      if (typeof detail.status === 'string') {
        statusText.value = detail.status
      }
    }

    onMounted(() => {
      window.addEventListener('licai:fund-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:fund-state', onState)
    })

    const infoTable = () => {
      if (!info.value) {
        return h('tbody', [
          h('tr', [
            h('td', { colSpan: 4, class: 'text-muted text-center' }, '基金信息加载中...')
          ])
        ])
      }
      return h('tbody', [
        h('tr', [
          h('td', { class: 'table-secondary' }, '基金代码'),
          h('td', info.value.code),
          h('td', { class: 'table-secondary' }, '基金名称'),
          h('td', info.value.name),
        ]),
        h('tr', [
          h('td', { class: 'table-secondary' }, '基金经理'),
          h('td', info.value.manager),
          h('td', { class: 'table-secondary' }, '基金公司'),
          h('td', info.value.company),
        ]),
        h('tr', [
          h('td', { class: 'table-secondary' }, '基金成立日期'),
          h('td', info.value.beginDate),
          h('td', { class: 'table-secondary' }, '基金更新日期'),
          h('td', info.value.updateDate),
        ]),
        h('tr', [
          h('td', { class: 'table-secondary' }, '基金类型'),
          h('td', info.value.style),
          h('td', { class: 'table-secondary' }, '基金规模'),
          h('td', info.value.scale),
        ]),
      ])
    }

    return () => h('div', { id: 'container', class: 'py-3' }, [
      h('div', { class: 'container' }, [
        h('table', { id: 'fundInfo', class: 'table table-bordered', width: '100%' }, [infoTable()]),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card-header' }, '说明'),
        h('div', { class: 'card-body' }, [
          h('blockquote', { class: 'blockquote mb-0' }, [
            h('p', '默认的价格K线是以最新单位净值价格前复权之前价格按照分红(或者拆股)再投入的方式进行计算，更符合实际投资收益情况，如果想查看单位净值或者累计净值请进行下面的勾选'),
          ]),
        ]),
      ]),
      h('div', { class: 'row align-items-end' }, [
        h('div', { class: 'col-3' }),
        h('div', { class: 'col-4' }, [
          h('div', { id: 'dateRange', class: 'mb-2' }),
        ]),
        h('div', { class: 'col' }, [
          h('select', {
            id: 'klinePrice',
            class: 'form-select form-select-sm',
          }, [
            h('option', { value: '' }, '股价前复权'),
            h('option', { value: 'normal' }, '股价不复权'),
            h('option', { value: 'after' }, '股价后复权'),
          ]),
        ]),
        h('div', { class: 'col-4 d-flex justify-content-between align-items-center' }, [
          h('span', [
            h('label', { class: 'form-check-label' }, [
              h('input', {
                id: 'positionCheck',
                type: 'checkbox',
                class: 'form-check-input',
              }),
              '重仓股',
            ]),
          ]),
          h('span', { class: 'small text-muted text-end' }, statusText.value),
        ]),
      ]),
      h('div', { id: 'kline', style: 'min-height: 600px; min-width: 300px;' }),
      h('table', { id: 'performance', class: 'table table-bordered table-hover', width: '100%' }),
      h('table', { id: 'regress', class: 'table table-bordered table-hover', width: '100%' }),
      h('table', { id: 'market', class: 'table table-bordered table-hover', width: '100%' }),
    ])
  },
})

const root = document.getElementById('fund-vue-root')
if (root) {
  createApp(FundPage).mount(root)
}

