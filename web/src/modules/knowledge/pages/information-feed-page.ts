type Facet = { id: string; count: number; label?: string }
type FeedFacets = { sources: Facet[]; content_types: Facet[]; companies: Facet[]; categories: Facet[]; industries: Facet[]; statuses?: string[] }
type ForecastMeasurement = { fiscalYear: number; rawValue: number; rawUnit: string; currency: string | null;
  accountingBasis: string; ownershipBasis: string; shareBasis: string }
type FeedRecord = { entity: string; informationType: string; category: string; period: string | null;
  statement: string; forecastMeasurement?: ForecastMeasurement | null }
type FeedItem = { doc_id: string; title: string; url: string | null; source_name: string | null; published_at: string | null;
  summary: string | null; kind: string; story_key: string; tagging_status: string; sources: string[];
  tags: Array<{ tagId: string; weight: number }>; industries: string[]; records: FeedRecord[] }
type FeedPage = { list: FeedItem[]; has_next: boolean; next_cursor: string | null }

const root = document.getElementById('information-feed-root')!
const style = document.createElement('style')
style.textContent = `
.feed-shell{max-width:1020px;margin:auto}.feed-hero{background:linear-gradient(125deg,#0b3b2e,#123a67);color:white;border-radius:1.2rem;padding:2rem;margin-bottom:1.5rem}
.feed-hero h1{font-weight:750}.feed-filter{background:#fff;border:1px solid #dce6e8;border-radius:1rem;padding:1.2rem 1.35rem;margin-bottom:1.3rem;box-shadow:0 8px 26px rgba(12,52,61,.055)}
.feed-filter-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem}.feed-filter-head h2{font-size:1rem;font-weight:750;margin:0;color:#173b39}.feed-filter-head p{font-size:.78rem;color:#71818b;margin:.2rem 0 0}
.feed-filter-reset{border:0;background:none;color:#176d62;font-size:.82rem;font-weight:650;padding:.35rem;white-space:nowrap}.feed-filter-reset:disabled{color:#a7b3b9;cursor:default}
.feed-filter-quick{display:grid;gap:.85rem}.feed-quick-group{display:flex;align-items:flex-start;gap:.7rem}.feed-quick-label{flex:0 0 3.4rem;padding-top:.43rem;color:#697b82;font-size:.8rem;font-weight:650}.feed-quick-options{display:flex;flex-wrap:wrap;gap:.42rem}
.feed-filter-chip{border:1px solid #dce6e8;background:#f7faf9;color:#35535a;border-radius:999px;padding:.36rem .77rem;font-size:.82rem;line-height:1.3;transition:background .15s,border-color .15s,color .15s}.feed-filter-chip:hover{border-color:#8ab9ac;background:#ecf6f2}.feed-filter-chip.is-active{background:#176b5b;border-color:#176b5b;color:white}.feed-filter-chip.is-active:hover{background:#105747}.feed-filter-chip small{opacity:.7;margin-left:.2rem}
.feed-filter-advanced{display:flex;flex-wrap:wrap;gap:.55rem;border-top:1px solid #edf1f2;margin-top:1rem;padding-top:1rem}.feed-filter-menu{position:relative;min-width:145px}.feed-filter-menu[open]{z-index:5}.feed-filter-menu summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:.7rem;padding:.57rem .8rem;border:1px solid #dce6e8;border-radius:.58rem;color:#36515a;font-size:.82rem;background:#fff;min-height:2.35rem}.feed-filter-menu summary::-webkit-details-marker{display:none}.feed-filter-menu summary:hover,.feed-filter-menu[open] summary{border-color:#7db5a8;background:#f8fcfa}.feed-filter-menu summary::after{content:'⌄';font-size:1rem;color:#6b8588;line-height:1}.feed-filter-menu[open] summary::after{transform:rotate(180deg)}.feed-filter-menu-count{background:#dff1eb;color:#126451;border-radius:99px;padding:.08rem .38rem;font-size:.7rem;font-weight:750}
.feed-filter-menu-panel{position:absolute;top:calc(100% + .35rem);left:0;width:270px;max-width:calc(100vw - 2rem);background:#fff;border:1px solid #dce6e8;border-radius:.72rem;box-shadow:0 12px 30px rgba(19,57,61,.16);padding:.65rem}.feed-filter-menu-search{width:100%;border:1px solid #dce6e8;border-radius:.48rem;padding:.48rem .6rem;font-size:.82rem;margin-bottom:.45rem}.feed-filter-menu-options{max-height:225px;overflow:auto}.feed-filter-option{display:flex;align-items:center;gap:.55rem;border-radius:.42rem;padding:.48rem .4rem;color:#344b52;font-size:.82rem;cursor:pointer}.feed-filter-option:hover{background:#f2f8f5}.feed-filter-option input{accent-color:#176b5b;margin:0}.feed-filter-option span{flex:1}.feed-filter-option small{color:#84949a}.feed-filter-empty{font-size:.8rem;color:#89979a;margin:.45rem}.feed-filter-menu-clear{border:0;background:none;color:#176d62;font-size:.78rem;padding:.4rem .25rem .1rem}
.feed-filter-active{display:flex;align-items:center;flex-wrap:wrap;gap:.42rem;border-top:1px solid #edf1f2;margin-top:1rem;padding-top:.85rem}.feed-filter-active-label{font-size:.77rem;color:#73848a;margin-right:.2rem}.feed-active-chip{border:0;border-radius:99px;background:#e8f4f0;color:#176151;padding:.28rem .6rem;font-size:.77rem}.feed-active-chip:hover{background:#d8ece5}.feed-active-chip span{font-size:.9rem;margin-left:.4rem}
.feed-filter [hidden]{display:none!important}
.feed-filter button:focus-visible,.feed-filter summary:focus-visible,.feed-filter input:focus-visible,.feed-card button:focus-visible,.feed-card a:focus-visible{outline:2px solid #15816b;outline-offset:2px}.feed-card{background:white;border:1px solid #e4e9ef;border-radius:.8rem;padding:.85rem 1rem;margin-bottom:.55rem;box-shadow:0 .3rem .8rem rgba(20,35,50,.035)}
.feed-card-header{display:flex;align-items:baseline;justify-content:space-between;gap:.65rem}.feed-meta{flex:none;font-size:.69rem;color:#89959e;font-weight:400;white-space:nowrap;text-align:right}.feed-meta time{margin-left:.4rem}.feed-card h2{flex:1;min-width:0;font-size:1.02rem;line-height:1.4;margin:0;font-weight:700;color:#243643;max-height:2.8em;overflow:hidden}.feed-card.is-expanded h2{max-height:none}
.feed-card p{color:#53616a;font-size:.86rem;margin:.28rem 0 0;line-height:1.45;overflow-wrap:anywhere}.feed-excerpt{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.feed-extra-record{display:none}.feed-card.is-expanded h2,.feed-card.is-expanded .feed-excerpt{display:block}.feed-card.is-expanded .feed-extra-record{display:block}
.feed-card-bottom{display:flex;align-items:center;justify-content:space-between;gap:.45rem;flex-wrap:wrap;margin-top:.48rem}.feed-tags{display:flex;align-items:center;gap:.3rem;min-width:0;flex-wrap:nowrap;overflow:hidden}.feed-card.is-expanded .feed-tags{flex-wrap:wrap;overflow:visible}.feed-tag,.feed-type-tag,.feed-entity-tag{font-size:.69rem;border-radius:99px;padding:.1rem .47rem;white-space:nowrap}.feed-tag{color:#176356;background:#e7f4f0}.feed-type-tag{color:#3c4fa0;background:#edf0ff}.feed-entity-tag{color:#526578;background:#edf2f5}.feed-tag-extra{display:none}.feed-card.is-expanded .feed-tag-extra{display:inline}.feed-card.is-expanded .feed-tags-more{display:none}.feed-card-actions{display:flex;align-items:center;gap:.7rem;margin-left:auto}.feed-expand,.feed-original{font-size:.77rem;color:#176b5b;text-decoration:none;white-space:nowrap}.feed-expand{border:0;background:none;padding:0}.feed-expand:hover,.feed-original:hover{text-decoration:underline}
.feed-structured{margin-top:.7rem;padding:.8rem;background:#f7faf9;border:1px solid #dce9e4;border-radius:.65rem}.feed-structured[hidden]{display:none}.feed-structured-heading{font-size:.83rem;font-weight:750;color:#234b43}.feed-structured-note{font-size:.73rem;color:#73848a;margin:.1rem 0 .65rem!important}.feed-structured-empty{font-size:.82rem;margin:.2rem 0!important}.feed-structured-record{background:#fff;border:1px solid #e3ebe9;border-radius:.55rem;padding:.7rem .8rem}.feed-structured-record+.feed-structured-record{margin-top:.55rem}.feed-structured-record-title{display:flex;align-items:center;gap:.5rem;font-size:.82rem;font-weight:750;color:#294a43;margin-bottom:.5rem}.feed-structured-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.45rem .9rem;margin:0}.feed-structured-grid>div{min-width:0}.feed-structured-grid .feed-structured-wide{grid-column:1/-1}.feed-structured-grid dt{font-size:.7rem;color:#77878c;font-weight:500}.feed-structured-grid dd{font-size:.82rem;color:#2f4349;margin:.08rem 0 0;overflow-wrap:anywhere}.feed-structured-subtitle{font-size:.76rem;font-weight:700;color:#45645c;margin:.65rem 0 .4rem;border-top:1px solid #edf1ef;padding-top:.55rem}
.feed-update{font-size:.69rem;color:#9c5b00;background:#fff2d9;border-radius:99px;padding:.1rem .46rem}.feed-more{display:block;margin:1.5rem auto}
@media(max-width:600px){.feed-hero{padding:1.4rem}.feed-card{padding:.8rem .85rem}.feed-filter{padding:1rem}.feed-quick-group{display:block}.feed-quick-label{display:block;padding:0 0 .35rem}.feed-filter-menu{flex:1 1 calc(50% - .55rem)}.feed-filter-menu-panel{position:static;width:100%;max-width:none;box-shadow:none;margin-top:.3rem}.feed-filter-menu[open]{flex-basis:100%}.feed-structured-grid{grid-template-columns:1fr}}
`
document.head.append(style)

const shell = el('div', 'feed-shell')
root.append(shell)
const hero = el('section', 'feed-hero')
hero.append(el('h1', '', '资讯'), el('p', 'mb-0', '按时间阅读来源表述的独有信息与后续进展；仅自动提取最近 48 小时的资讯，提取记录未经独立核实。'))
shell.append(hero)
const filterPanel = el('section', 'feed-filter')
const filterHead = el('div', 'feed-filter-head')
const filterHeading = el('div')
filterHeading.append(el('h2', '', '筛选资讯'), el('p', '', '快速定位你关心的来源和信息'))
const resetButton = el('button', 'feed-filter-reset', '清除筛选') as HTMLButtonElement
resetButton.type = 'button'
filterHead.append(filterHeading, resetButton)
const quickFilters = el('div', 'feed-filter-quick')
const advancedFilters = el('div', 'feed-filter-advanced')
const activeFilters = el('div', 'feed-filter-active')
activeFilters.hidden = true
filterPanel.append(filterHead, quickFilters, advancedFilters, activeFilters)
shell.append(filterPanel)
const statusLine = el('p', 'text-muted small')
statusLine.setAttribute('role', 'status')
shell.append(statusLine)
const list = el('div', 'feed-list')
shell.append(list)
const more = el('button', 'btn btn-outline-secondary feed-more', '加载更多') as HTMLButtonElement
more.hidden = true
shell.append(more)

const selected = new Map<string, Set<string>>()
let facets: FeedFacets = { sources: [], content_types: [], companies: [], categories: [], industries: [] }
let cursor: string | null = null
let generation = 0

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

async function getData<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  const payload = await response.json()
  if (!response.ok || payload.code !== 200) throw new Error(payload.msg || `HTTP ${response.status}`)
  return payload.data as T
}

const filterOptions = new Map<string, Facet[]>()
const filterNames = new Map<string, string>()

function valuesFor(name: string) { return selected.get(name) || new Set<string>() }

function setFilter(name: string, value: string, single = false) {
  const values = new Set(valuesFor(name))
  if (!value) values.clear()
  else if (single) { values.clear(); values.add(value) }
  else if (values.has(value)) values.delete(value)
  else values.add(value)
  if (values.size) selected.set(name, values)
  else selected.delete(name)
  refreshFilterUI()
  cursor = null
  list.replaceChildren()
  void load(false)
}

function quickGroup(name: string, label: string, options: Facet[]) {
  filterOptions.set(name, options)
  filterNames.set(name, label)
  const group = el('div', 'feed-quick-group')
  group.append(el('span', 'feed-quick-label', label))
  const choices = el('div', 'feed-quick-options')
  for (const option of [{ id: '', label: '全部', count: 0 }, ...options]) {
    const button = el('button', 'feed-filter-chip') as HTMLButtonElement
    button.type = 'button'
    button.dataset.filterGroup = name
    button.dataset.filterValue = option.id
    button.append(document.createTextNode(option.label || option.id))
    if (option.id) button.append(el('small', '', String(option.count)))
    button.addEventListener('click', () => setFilter(name, option.id))
    choices.append(button)
  }
  group.append(choices)
  quickFilters.append(group)
}

function advancedGroup(name: string, label: string, options: Facet[], single = false) {
  filterOptions.set(name, options)
  filterNames.set(name, label)
  const menu = document.createElement('details')
  menu.className = 'feed-filter-menu'
  menu.dataset.filterGroup = name
  const summary = document.createElement('summary')
  summary.append(el('span', '', label), el('span', 'feed-filter-menu-count'))
  menu.append(summary)
  const panel = el('div', 'feed-filter-menu-panel')
  if (options.length > 7) {
    const search = document.createElement('input')
    search.type = 'search'
    search.className = 'feed-filter-menu-search'
    search.placeholder = `搜索${label}`
    search.setAttribute('aria-label', `搜索${label}`)
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase()
      for (const item of optionList.querySelectorAll<HTMLElement>('.feed-filter-option')) {
        item.hidden = !item.textContent?.toLowerCase().includes(query)
      }
    })
    panel.append(search)
  }
  const optionList = el('div', 'feed-filter-menu-options')
  if (!options.length) optionList.append(el('p', 'feed-filter-empty', '暂无可选项'))
  for (const option of single ? [{ id: '', label: '全部状态', count: 0 }, ...options] : options) {
    const row = document.createElement('label')
    row.className = 'feed-filter-option'
    const input = document.createElement('input')
    input.type = single ? 'radio' : 'checkbox'
    input.name = `feed-${name}`
    input.value = option.id
    input.dataset.filterGroup = name
    input.dataset.filterValue = option.id
    input.addEventListener('change', () => { if (!single || input.checked) setFilter(name, option.id, single) })
    row.append(input, el('span', '', option.label || option.id))
    if (!single) row.append(el('small', '', String(option.count)))
    optionList.append(row)
  }
  panel.append(optionList)
  if (!single && options.length) {
    const clear = el('button', 'feed-filter-menu-clear', '清空此项') as HTMLButtonElement
    clear.type = 'button'
    clear.addEventListener('click', () => setFilter(name, ''))
    panel.append(clear)
  }
  menu.append(panel)
  advancedFilters.append(menu)
}

function refreshFilterUI() {
  for (const button of quickFilters.querySelectorAll<HTMLButtonElement>('button[data-filter-group]')) {
    const values = valuesFor(button.dataset.filterGroup || '')
    const value = button.dataset.filterValue || ''
    const active = value ? values.has(value) : values.size === 0
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', String(active))
  }
  for (const menu of advancedFilters.querySelectorAll<HTMLDetailsElement>('.feed-filter-menu')) {
    const values = valuesFor(menu.dataset.filterGroup || '')
    const count = menu.querySelector<HTMLElement>('.feed-filter-menu-count')!
    count.textContent = values.size ? String(values.size) : ''
    count.hidden = !values.size
    for (const input of menu.querySelectorAll<HTMLInputElement>('input[data-filter-value]')) {
      input.checked = input.value ? values.has(input.value) : values.size === 0 && input.type === 'radio'
    }
  }
  activeFilters.replaceChildren()
  let count = 0
  for (const [name, values] of selected) {
    for (const value of values) {
      count += 1
      const option = filterOptions.get(name)?.find((item) => item.id === value)
      const button = el('button', 'feed-active-chip') as HTMLButtonElement
      button.type = 'button'
      button.setAttribute('aria-label', `移除${filterNames.get(name)}：${option?.label || value}`)
      button.append(document.createTextNode(`${filterNames.get(name)}：${option?.label || value}`), el('span', '', '×'))
      button.addEventListener('click', () => setFilter(name, value))
      activeFilters.append(button)
    }
  }
  if (count) activeFilters.prepend(el('span', 'feed-filter-active-label', `已选 ${count} 项`))
  activeFilters.hidden = count === 0
  resetButton.disabled = count === 0
}

function renderFilters() {
  quickFilters.replaceChildren()
  advancedFilters.replaceChildren()
  filterOptions.clear()
  filterNames.clear()
  quickGroup('source', '来源', facets.sources.map(item => ({ ...item,
    label: ({ cls_telegraph: '财联社', tencent_stock_news: '腾讯自选股' } as Record<string,string>)[item.id] || item.id })))
  quickGroup('content_type', '类型', facets.content_types.map(item => ({ ...item,
    label: ({ news: '新闻', flash: '快讯', announcement: '公告', text_report: '文本研报' } as Record<string,string>)[item.id] || item.id })))
  advancedGroup('company', '公司', facets.companies)
  advancedGroup('category', '信息类别', facets.categories.map(item => ({ ...item, id: item.id.replace(/^category:/, '') })))
  advancedGroup('industry', '行业', facets.industries)
  if (facets.statuses) advancedGroup('status', '提取状态', [
    { id: 'unclassified', label: '无可提取信息', count: 0 },
    { id: 'pending', label: '待提取', count: 0 },
    { id: 'failed', label: '提取失败', count: 0 },
    { id: 'complete', label: '已提取', count: 0 },
    { id: 'expired', label: '超过48小时未提取', count: 0 },
  ], true)
  refreshFilterUI()
}

document.addEventListener('click', (event) => {
  for (const menu of advancedFilters.querySelectorAll<HTMLDetailsElement>('.feed-filter-menu[open]')) {
    if (!menu.contains(event.target as Node)) menu.open = false
  }
})

resetButton.addEventListener('click', () => {
  selected.clear()
  refreshFilterUI()
  cursor = null
  list.replaceChildren()
  void load(false)
})

function queryString() {
  const params = new URLSearchParams()
  for (const [name, values] of selected) if (values.size) params.set(name, [...values].join(','))
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

function tagLabel(id: string) {
  return facets.categories.find(item => item.id === id)?.label
    || facets.companies.find(item => item.id === id)?.label || id.replace(/^(company|category):/, '')
}

function recordTypeLabel(type: string) {
  return ({ fact: '来源事实', guidance: '官方指引', forecast: '第三方预测', opinion: '观点', event: '事件', relationship: '关系' } as Record<string, string>)[type] || type
}

function formatFeedTime(value: string) {
  const date = new Date(value)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }
  if (!sameDay) { options.month = 'numeric'; options.day = 'numeric' }
  if (date.getFullYear() !== today.getFullYear()) options.year = 'numeric'
  return date.toLocaleString('zh-CN', options)
}

function formatPeriod(value: string) {
  const match = /^(\d{4})(FY|H[12]|Q[1-4])$/.exec(value)
  if (!match) return value
  const suffix = ({ FY: '全年', H1: '上半年', H2: '下半年', Q1: '第一季度', Q2: '第二季度', Q3: '第三季度', Q4: '第四季度' } as Record<string, string>)[match[2]]
  return `${match[1]}年${suffix}`
}

function structuredField(label: string, value: string, wide = false) {
  const field = el('div', wide ? 'feed-structured-wide' : '')
  field.append(el('dt', '', label), el('dd', '', value))
  return field
}

function formatForecastAmount(measurement: ForecastMeasurement) {
  if (measurement.rawUnit === 'percent') return `${measurement.rawValue}%`
  const currency = ({ CNY: '元', USD: '美元', HKD: '港元', EUR: '欧元' } as Record<string, string>)[measurement.currency || '']
    || (measurement.currency ? `${measurement.currency}货币单位` : '货币单位')
  const unit = ({ currency: currency, ten_thousand_currency: `万${currency}`, million_currency: `百万${currency}`,
    hundred_million_currency: `亿${currency}`, billion_currency: `十亿${currency}`, currency_per_share: `${currency}/股` } as Record<string, string>)[measurement.rawUnit]
    || measurement.rawUnit
  return `${measurement.rawValue} ${unit}`
}

function renderStructuredResult(item: FeedItem) {
  const panel = el('section', 'feed-structured')
  panel.id = `feed-structured-${item.doc_id}`
  panel.setAttribute('aria-label', `提取详情：${item.title}`)
  panel.hidden = true
  panel.append(el('div', 'feed-structured-heading', `提取记录 · ${item.records.length} 条`),
    el('p', 'feed-structured-note', '结构化摘录仅反映来源表述，未经独立核实。'))
  if (!item.records.length) {
    panel.append(el('p', 'feed-structured-empty', '模型已完成提取，但没有匹配当前类别目录的记录。'))
    return panel
  }
  const basisLabels: Record<string, string> = { gaap: 'GAAP', non_gaap: '非 GAAP', adjusted: '调整后', unspecified: '未注明' }
  const ownershipLabels: Record<string, string> = { attributable_to_parent: '归属于母公司', consolidated: '合并口径',
    common_shareholders: '归属于普通股股东', unspecified: '未注明' }
  const shareLabels: Record<string, string> = { basic: '基本', diluted: '摊薄', unspecified: '未注明' }
  for (const [index, record] of item.records.entries()) {
    const section = el('section', 'feed-structured-record')
    section.append(el('div', 'feed-structured-record-title', `记录 ${index + 1}`))
    const fields = el('dl', 'feed-structured-grid')
    fields.append(structuredField('主体', record.entity), structuredField('信息类别', tagLabel(`category:${record.category}`)),
      structuredField('信息类型', recordTypeLabel(record.informationType)))
    if (record.period) fields.append(structuredField('对应期间', formatPeriod(record.period)))
    fields.append(structuredField('信息陈述', record.statement, true))
    section.append(fields)
    const measurement = record.forecastMeasurement
    if (measurement) {
      section.append(el('div', 'feed-structured-subtitle', '第三方预测数值'))
      const forecast = el('dl', 'feed-structured-grid')
      forecast.append(structuredField('预测财年', `${measurement.fiscalYear}年`), structuredField('原文数值', formatForecastAmount(measurement)),
        structuredField('会计口径', basisLabels[measurement.accountingBasis] || measurement.accountingBasis),
        structuredField('归属口径', ownershipLabels[measurement.ownershipBasis] || measurement.ownershipBasis),
        structuredField('每股口径', shareLabels[measurement.shareBasis] || measurement.shareBasis))
      section.append(forecast)
    } else if (record.informationType === 'forecast') {
      section.append(el('p', 'feed-structured-note', '未形成可结构化的单一预测数值。'))
    }
    panel.append(section)
  }
  return panel
}

function renderItem(item: FeedItem) {
  const card = el('article', 'feed-card')
  const header = el('div', 'feed-card-header')
  const heading = el('h2', '', item.title)
  const meta = el('span', 'feed-meta')
  meta.append(el('span', '', item.source_name || item.sources.join('、') || '未知来源'))
  if (item.published_at) {
    const time = el('time', '', formatFeedTime(item.published_at))
    time.setAttribute('datetime', item.published_at)
    time.title = new Date(item.published_at).toLocaleString('zh-CN')
    meta.append(time)
  }
  header.append(heading, meta)
  card.append(header)
  if (item.records?.length) {
    for (const [index, record] of item.records.entries()) {
      const paragraph = el('p', index ? 'feed-extra-record' : 'feed-excerpt')
      paragraph.textContent = record.statement
      card.append(paragraph)
    }
  } else if (item.summary) card.append(el('p', 'feed-excerpt', item.summary))
  const bottom = el('div', 'feed-card-bottom')
  const tags = el('div', 'feed-tags')
  if (item.kind === 'update') tags.append(el('span', 'feed-update', '更新'))
  if (item.tagging_status === 'expired') tags.append(el('span', 'feed-update', '超过48小时未提取'))
  else if (item.tagging_status === 'failed') tags.append(el('span', 'feed-update', '提取失败，等待重试'))
  else if (item.tagging_status === 'processing') tags.append(el('span', 'feed-update', '提取中'))
  else if (item.tagging_status !== 'complete') tags.append(el('span', 'feed-update', '待提取'))
  else if (!item.records?.length) tags.append(el('span', 'feed-update', '无可提取信息'))
  const categories = item.tags.filter((tag) => tag.tagId.startsWith('category:')).map((tag) => tagLabel(tag.tagId))
  const types = [...new Set(item.records.map((record) => recordTypeLabel(record.informationType)))]
  const others = [...item.tags.filter((tag) => !tag.tagId.startsWith('category:')).map((tag) => tagLabel(tag.tagId)), ...item.industries]
  if (categories[0]) tags.append(el('span', 'feed-tag', categories[0]))
  if (types[0]) tags.append(el('span', 'feed-type-tag', types[0]))
  const extras = [
    ...categories.slice(1).map((label) => ({ label, className: 'feed-tag' })),
    ...types.slice(1).map((label) => ({ label, className: 'feed-type-tag' })),
    ...others.map((label) => ({ label, className: 'feed-entity-tag' })),
  ]
  for (const extra of extras) tags.append(el('span', `${extra.className} feed-tag-extra`, extra.label))
  if (extras.length) tags.append(el('span', 'feed-entity-tag feed-tags-more', `+${extras.length}`))
  if (tags.childNodes.length) bottom.append(tags)
  const actions = el('div', 'feed-card-actions')
  let structuredPanel: HTMLElement | null = null
  if (Array.isArray(facets.statuses) && item.tagging_status === 'complete') {
    const panel = renderStructuredResult(item)
    structuredPanel = panel
    const details = el('button', 'feed-expand', '提取详情') as HTMLButtonElement
    details.type = 'button'
    details.setAttribute('aria-controls', panel.id)
    details.setAttribute('aria-expanded', 'false')
    details.setAttribute('aria-label', `查看提取详情：${item.title}`)
    details.addEventListener('click', () => {
      panel.hidden = !panel.hidden
      details.setAttribute('aria-expanded', String(!panel.hidden))
      details.textContent = panel.hidden ? '提取详情' : '收起详情'
      details.setAttribute('aria-label', `${panel.hidden ? '查看' : '收起'}提取详情：${item.title}`)
    })
    actions.append(details)
  }
  if (item.records?.length || item.summary) {
    const expand = el('button', 'feed-expand', '展开') as HTMLButtonElement
    expand.type = 'button'
    expand.setAttribute('aria-expanded', 'false')
    expand.setAttribute('aria-label', `展开：${item.title}`)
    expand.addEventListener('click', () => {
      const expanded = card.classList.toggle('is-expanded')
      expand.textContent = expanded ? '收起' : '展开'
      expand.setAttribute('aria-expanded', String(expanded))
      expand.setAttribute('aria-label', `${expanded ? '收起' : '展开'}：${item.title}`)
    })
    actions.append(expand)
  }
  if (item.url) {
    const link = el('a', 'feed-original', '原文 ↗') as HTMLAnchorElement
    link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'
    actions.append(link)
  }
  if (actions.childNodes.length) bottom.append(actions)
  if (bottom.childNodes.length) card.append(bottom)
  if (structuredPanel) card.append(structuredPanel)
  if (item.kind === 'update') {
    const details = el('details', 'mt-2') as HTMLDetailsElement
    details.append(el('summary', 'small text-secondary', '查看此前进展'))
    details.addEventListener('toggle', () => {
      if (!details.open || details.dataset.loaded) return
      details.dataset.loaded = 'true'
      void getData<{ list: FeedItem[] }>(`/api/knowledge/feed/story?key=${encodeURIComponent(item.story_key)}`)
        .then(data => {
          for (const previous of data.list.filter(entry => entry.doc_id !== item.doc_id)) {
            const block = el('div', 'border-start ps-3 my-2')
            block.append(el('strong', 'small', previous.title), el('p', 'small mb-0', previous.summary || ''))
            details.append(block)
          }
        }).catch(error => { details.append(el('p', 'small text-danger', error instanceof Error ? error.message : String(error))) })
    })
    card.append(details)
  }
  return card
}

async function load(append: boolean) {
  const current = ++generation
  statusLine.textContent = '正在加载资讯…'
  more.disabled = true
  try {
    const page = await getData<FeedPage>(`/api/knowledge/feed?${queryString()}`)
    if (current !== generation) return
    if (!append) list.replaceChildren()
    for (const item of page.list) list.append(renderItem(item))
    cursor = page.next_cursor
    more.hidden = !page.has_next
    statusLine.textContent = list.childElementCount ? '' : '暂无符合条件的资讯。'
  } catch (error) { statusLine.textContent = error instanceof Error ? error.message : String(error) }
  finally { if (current === generation) more.disabled = false }
}

more.addEventListener('click', () => void load(true))
void (async () => {
  try { facets = await getData<FeedFacets>('/api/knowledge/feed/facets'); renderFilters(); await load(false) }
  catch (error) { statusLine.textContent = error instanceof Error ? error.message : String(error) }
})()
