import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompanyReportPredictCell = {
  id: string
  value: string
}

type CompanyReportPredictRow = {
  cells: CompanyReportPredictCell[]
  key: string
  label: string
}

type CompanyReportPredictStateEvent = CustomEvent<{
  rows?: CompanyReportPredictRow[]
}>

const CompanyReportPredictPage = defineComponent({
  name: 'CompanyReportPredictPage',
  setup() {
    const rows = ref<CompanyReportPredictRow[]>([])

    const onState = (event: Event) => {
      const detail = (event as CompanyReportPredictStateEvent).detail
      if (!detail) {
        return
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-report-predict-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-report-predict-state', onState)
    })

    const years = () => rows.value.length > 0
      ? rows.value[0].cells.map((cell) => cell.id.substring(3))
      : []

    return () => h('table', { id: 'companyReportPredict', class: 'table table-sm table-bordered table-hover' }, [
      h('thead', { class: 'table-info' }, [
        h('tr', [
          h('th', { scope: 'col' }, '项目'),
          ...years().map((year) => h('th', { key: year, scope: 'col' }, year)),
        ]),
      ]),
      h('tbody', rows.value.map((row) => h('tr', { key: row.key }, [
        h('td', row.label),
        ...row.cells.map((cell) => h('td', { key: cell.id }, [
          h('input', {
            id: cell.id,
            name: 'subject',
            class: 'form-control form-control-sm',
            type: 'text',
            value: cell.value,
          }),
        ])),
      ]))),
    ])
  },
})

const root = document.getElementById('company-report-predict-vue-root')
if (root) {
  createApp(CompanyReportPredictPage).mount(root)
}

