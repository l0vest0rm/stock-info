import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type ThirteenFManagerRow = {
  id: string
  englishName: string
  chineseName: string
  scale: string
}

type ThirteenFStateEvent = CustomEvent<{
  status?: string
  rows?: ThirteenFManagerRow[]
}>

const ThirteenFPage = defineComponent({
  name: 'ThirteenFPage',
  setup() {
    const statusText = ref('加载中...')
    const rows = ref<ThirteenFManagerRow[]>([])

    const onState = (event: Event) => {
      const detail = (event as ThirteenFStateEvent).detail
      if (!detail) {
        return
      }
      if (typeof detail.status === 'string') {
        statusText.value = detail.status
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
    }

    onMounted(() => {
      window.addEventListener('licai:13f-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:13f-state', onState)
    })

    return () => h('div', { id: 'container', class: 'mt-5 mx-5' }, [
      h('div', { class: 'd-flex align-items-center justify-content-between mb-3' }, [
        h('h5', { class: 'mb-0' }, '13F 机构列表'),
        h('span', { id: 'thirteenFStatus', class: 'text-muted small' }, statusText.value),
      ]),
      h('table', { id: 'managementTable', class: 'table table-bordered table-hover' }, [
        h('thead', { class: 'table-success theadFix' }, [
          h('tr', [
            h('th', '序号'),
            h('th', '英文名'),
            h('th', '中文名'),
            h('th', '管理规模'),
          ]),
        ]),
        h('tbody', rows.value.length > 0
          ? rows.value.map((row, index) => h('tr', { key: row.id || `${row.englishName}-${index}` }, [
            h('td', index + 1),
            h('td', [h('a', { href: `13f-position.html?id=${encodeURIComponent(row.id)}&name=${encodeURIComponent(row.chineseName)}` }, row.englishName)]),
            h('td', row.chineseName),
            h('td', row.scale),
          ]))
          : [h('tr', [h('td', { colSpan: 4, class: 'text-muted text-center' }, '暂无数据')])]),
      ]),
    ])
  },
})

const root = document.getElementById('thirteenf-vue-root')
if (root) {
  createApp(ThirteenFPage).mount(root)
}

