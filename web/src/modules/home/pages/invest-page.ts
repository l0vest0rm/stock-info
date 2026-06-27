import { createApp, defineComponent, h } from 'vue'

const InvestPage = defineComponent({
  name: 'InvestPage',
  setup() {
    return () => h('div', { id: 'container', class: 'py-3' }, [
      h('table', { id: 'investAccountTable', class: 'table table-bordered table-hover table-sm', 'data-search': 'true', 'data-sticky-header': 'true' }, [
        h('thead', { class: 'table-dark' }, [
          h('tr', [
            h('th', { scope: 'col' }, '#'),
            h('th', '账号'),
            h('th', { 'data-sortable': 'true' }, '币种'),
            h('th', { 'data-sortable': 'true' }, '总投入(CNY)'),
            h('th', '当前现金'),
            h('th', '当前权益'),
            h('th', '当前总资产'),
            h('th', { 'data-sortable': 'true' }, '当前总资产(CNY)'),
            h('th', { 'data-sortable': 'true' }, '盈亏金额(CNY)'),
            h('th', { 'data-sortable': 'true' }, '盈亏(%)'),
          ]),
        ]),
      ]),
      h('table', { id: 'positionTable', class: 'table table-bordered table-hover table-sm', 'data-search': 'true', 'data-sticky-header': 'true' }, [
        h('thead', { class: 'table-dark' }, [
          h('tr', [
            h('th', { scope: 'col' }, '#'),
            h('th', { scope: 'col', 'data-sortable': 'true' }, '账号'),
            h('th', { scope: 'col', 'data-sortable': 'true' }, '币种'),
            h('th', { scope: 'col', 'data-sortable': 'true' }, '分类'),
            h('th', { scope: 'col' }, '代码'),
            h('th', { scope: 'col' }, '名称'),
            h('th', { scope: 'col' }, '持仓数量'),
            h('th', { scope: 'col' }, '当前价格'),
            h('th', { scope: 'col' }, '当前市值'),
            h('th', { scope: 'col', 'data-sortable': 'true' }, '当前市值(CNY)'),
            h('th', { scope: 'col', 'data-sortable': 'true' }, '持仓占比(%)'),
          ]),
        ]),
      ]),
      h('div', { id: 'positionPie', style: 'min-height: 600px; min-width: 300px;' }),
      h('div', { id: 'catPie', style: 'min-height: 600px; min-width: 300px;' }),
    ])
  },
})

const investRoot = document.getElementById('invest-vue-root')
if (investRoot) {
  createApp(InvestPage).mount(investRoot)
}

