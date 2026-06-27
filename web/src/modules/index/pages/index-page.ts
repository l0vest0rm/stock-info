import { createApp, defineComponent, h } from 'vue'

const IndexPage = defineComponent({
  name: 'IndexPage',
  setup() {
    return () => h('div', { id: 'container', class: 'py-3' }, [
      h('div', { class: 'row' }, [
        h('div', { class: 'col-3' }, [
          h('div', { id: 'dateRange', class: 'mb-2' }),
        ]),
        h('div', { class: 'col-5' }, [
          h('div', { class: 'btn-group', role: 'group' }, [
            h('div', [
              h('select', { id: 'klinePrice', class: 'form-select form-select-sm' }, [
                h('option', { value: '' }, '股价前复权'),
                h('option', { value: 'normal' }, '股价不复权'),
                h('option', { value: 'after' }, '股价后复权'),
              ]),
            ]),
            h('input', { id: 'alignStart', type: 'checkbox', class: 'btn-check', autocomplete: 'off' }),
            h('label', { class: 'btn btn-sm btn-outline-primary', for: 'alignStart' }, '对齐开始'),
            h('input', { id: 'ratio', type: 'checkbox', class: 'btn-check', autocomplete: 'off' }),
            h('label', { class: 'btn btn-sm btn-outline-primary', for: 'ratio' }, '比率'),
          ]),
        ]),
        h('div', { class: 'col-4' }, [
          h('select', { id: 'codes', class: 'form-select', multiple: true }),
        ]),
      ]),
      h('div', { id: 'kline', style: 'min-height: 600px; min-width: 300px;' }),
    ])
  },
})

const indexRoot = document.getElementById('index-vue-root')
if (indexRoot) {
  createApp(IndexPage).mount(indexRoot)
}

