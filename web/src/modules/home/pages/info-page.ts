import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type InfoRow = {
  company: string
  item: string
  date: string
  value: string
  rowKey: string
}

type InfoStateEvent = CustomEvent<{
  rows?: InfoRow[]
  status?: string
}>

const InfoPage = defineComponent({
  name: 'InfoPage',
  setup() {
    const rows = ref<InfoRow[]>([])
    const status = ref('请选择股票')

    const onState = (event: Event) => {
      const detail = (event as InfoStateEvent).detail
      if (!detail) {
        return
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
      if (typeof detail.status === 'string') {
        status.value = detail.status
      }
    }

    onMounted(() => {
      window.addEventListener('licai:info-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:info-state', onState)
    })

    return () => h('div', { class: 'info-page mt-3' }, [
      rows.value.length > 0
        ? h('table', { id: 'infoTable', class: 'table table-bordered table-hover' }, [
            h('thead', { class: 'table-info' }, [
              h('tr', [
                h('th', '公司'),
                h('th', '项目'),
                h('th', '日期'),
                h('th', '值'),
              ]),
            ]),
            h('tbody', rows.value.map((row) => h('tr', { key: row.rowKey }, [
              h('td', row.company),
              h('td', row.item),
              h('td', row.date),
              h('td', row.value),
            ]))),
          ])
        : h('div', { class: 'small text-muted py-3' }, status.value || '暂无数据'),
    ])
  },
})

const root = document.getElementById('info-vue-root')
if (root) {
  createApp(InfoPage).mount(root)
}

