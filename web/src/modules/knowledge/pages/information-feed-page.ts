type Facet = { id: string; count: number; label?: string }
type FeedFacets = { sources: Facet[]; content_types: Facet[]; companies: Facet[]; topics: Facet[]; industries: Facet[]; statuses?: string[] }
type FeedItem = { doc_id: string; title: string; url: string | null; source_name: string | null; published_at: string | null;
  summary: string | null; kind: string; story_key: string; tagging_status: string; sources: string[];
  tags: Array<{ tagId: string; weight: number }>; industries: string[] }
type FeedPage = { list: FeedItem[]; has_next: boolean; next_cursor: string | null }

const root = document.getElementById('information-feed-root')!
const style = document.createElement('style')
style.textContent = `
.feed-shell{max-width:1020px;margin:auto}.feed-hero{background:linear-gradient(125deg,#0b3b2e,#123a67);color:white;border-radius:1.2rem;padding:2rem;margin-bottom:1.5rem}
.feed-hero h1{font-weight:750}.feed-filter{background:#f7f9fc;border:1px solid #e1e8ee;border-radius:1rem;padding:1rem;margin-bottom:1.3rem}
.feed-filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.8rem}.feed-filter label{display:block;font-size:.82rem;font-weight:700;color:#455468;margin-bottom:.25rem}
.feed-filter select{width:100%;min-height:2.5rem;border:1px solid #cad5e0;border-radius:.55rem;background:white;padding:.3rem}
.feed-filter select[multiple]{height:6rem}.feed-card{background:white;border:1px solid #e4e9ef;border-radius:1rem;padding:1.2rem 1.35rem;margin-bottom:.85rem;box-shadow:0 .4rem 1rem rgba(20,35,50,.045)}
.feed-meta{font-size:.83rem;color:#637388;display:flex;gap:.7rem;flex-wrap:wrap}.feed-card h2{font-size:1.16rem;line-height:1.5;margin:.45rem 0;font-weight:700}
.feed-card p{color:#3f4b58;margin:.35rem 0 .7rem;line-height:1.65;overflow-wrap:anywhere}.feed-tags{display:flex;gap:.4rem;flex-wrap:wrap}.feed-tag{font-size:.75rem;color:#176356;background:#e7f4f0;border-radius:99px;padding:.15rem .55rem}
.feed-update{font-size:.72rem;color:#9c5b00;background:#fff2d9;border-radius:99px;padding:.15rem .55rem}.feed-original{font-size:.82rem}.feed-more{display:block;margin:1.5rem auto}
@media(max-width:600px){.feed-hero{padding:1.4rem}.feed-card{padding:1rem}.feed-filter-grid{grid-template-columns:1fr 1fr}}
`
document.head.append(style)

const shell = el('div', 'feed-shell')
root.append(shell)
const hero = el('section', 'feed-hero')
hero.append(el('h1', '', '资讯'), el('p', 'mb-0', '按时间阅读独有信息与后续进展，可按来源、公司、主题和行业筛选。'))
shell.append(hero)
const filterPanel = el('section', 'feed-filter')
const grid = el('div', 'feed-filter-grid')
filterPanel.append(grid)
shell.append(filterPanel)
const statusLine = el('p', 'text-muted small')
statusLine.setAttribute('role', 'status')
shell.append(statusLine)
const list = el('div', 'feed-list')
shell.append(list)
const more = el('button', 'btn btn-outline-secondary feed-more', '加载更多') as HTMLButtonElement
more.hidden = true
shell.append(more)

const selectors = new Map<string, HTMLSelectElement>()
let facets: FeedFacets = { sources: [], content_types: [], companies: [], topics: [], industries: [] }
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

function addSelector(name: string, label: string, options: Facet[], multiple = false) {
  const wrapper = el('div')
  const labelNode = el('label', '', label) as HTMLLabelElement
  const select = document.createElement('select')
  select.name = name
  select.id = `feed-${name}`
  select.multiple = multiple
  labelNode.htmlFor = select.id
  if (!multiple) select.append(new Option('全部', ''))
  for (const option of options) select.append(new Option(`${option.label || option.id} (${option.count})`, option.id))
  select.addEventListener('change', () => { cursor = null; list.replaceChildren(); void load(false) })
  selectors.set(name, select)
  wrapper.append(labelNode, select)
  grid.append(wrapper)
}

function renderFilters() {
  grid.replaceChildren()
  selectors.clear()
  addSelector('source', '来源（可多选）', facets.sources.map(item => ({ ...item,
    label: ({ cls_telegraph: '财联社', tencent_stock_news: '腾讯自选股' } as Record<string,string>)[item.id] || item.id })), true)
  addSelector('content_type', '类型（可多选）', facets.content_types.map(item => ({ ...item, label: ({ news: '新闻', flash: '快讯', announcement: '公告', text_report: '文本研报' } as Record<string,string>)[item.id] || item.id })), true)
  addSelector('company', '公司（可多选）', facets.companies, true)
  addSelector('topic', '主题（可多选）', facets.topics, true)
  addSelector('industry', '行业（可多选）', facets.industries, true)
  if (facets.statuses) addSelector('status', '分类状态', [
    { id: 'unclassified', label: '未分类', count: 0 },
    { id: 'pending', label: '待打标', count: 0 },
    { id: 'failed', label: '打标失败', count: 0 },
    { id: 'complete', label: '已打标', count: 0 },
  ])
}

function queryString() {
  const params = new URLSearchParams()
  for (const [name, select] of selectors) {
    const values = [...select.selectedOptions].map(option => option.value).filter(Boolean)
    if (values.length) params.set(name, values.join(','))
  }
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

function tagLabel(id: string) {
  return facets.topics.find(item => item.id === id)?.label || id.replace(/^(company|topic):/, '')
}

function renderItem(item: FeedItem) {
  const card = el('article', 'feed-card')
  const meta = el('div', 'feed-meta')
  meta.append(el('span', '', item.source_name || item.sources.join('、') || '未知来源'))
  if (item.published_at) meta.append(el('time', '', new Date(item.published_at).toLocaleString('zh-CN')))
  if (item.kind === 'update') meta.append(el('span', 'feed-update', '更新'))
  if (item.tagging_status !== 'complete') meta.append(el('span', 'feed-update', '未分类'))
  card.append(meta, el('h2', '', item.title))
  if (item.summary) card.append(el('p', '', item.summary))
  const tags = el('div', 'feed-tags')
  for (const tag of item.tags) tags.append(el('span', 'feed-tag', tagLabel(tag.tagId)))
  for (const industry of item.industries) tags.append(el('span', 'feed-tag', industry))
  if (tags.childNodes.length) card.append(tags)
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
  if (item.url) {
    const link = el('a', 'feed-original mt-2 d-inline-block', '阅读来源原文 ↗') as HTMLAnchorElement
    link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'
    card.append(link)
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
