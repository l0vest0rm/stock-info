import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'

type SearchResult = {
  code: string
  market: string
  type: string
  name: string
}

const homePageStyle = `
.home-hero {
  background:
    radial-gradient(circle at top right, rgba(246, 211, 101, 0.24), transparent 24rem),
    linear-gradient(140deg, #0b3b2e 0%, #123a67 100%);
  border-radius: 1.5rem;
  color: #f7f3e8;
  overflow: hidden;
  position: relative;
}

.home-hero::after {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), transparent 60%);
  content: "";
  inset: 0;
  pointer-events: none;
  position: absolute;
}

.home-chip {
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  color: inherit;
  display: inline-flex;
  font-size: .9rem;
  gap: .35rem;
  margin: 0 .5rem .5rem 0;
  padding: .5rem .9rem;
  text-decoration: none;
}

.home-chip:hover,
.home-chip:focus {
  background: rgba(255, 255, 255, 0.18);
  color: inherit;
}

.home-search-shell {
  background: rgba(247, 243, 232, 0.96);
  border-radius: 1.25rem;
  box-shadow: 0 1rem 2rem rgba(4, 18, 29, 0.22);
  color: #17202a;
}

.home-search-shell .form-control,
.home-search-shell .btn {
  min-height: 3rem;
}

.home-section-title {
  color: #123a67;
  font-size: 1.55rem;
  font-weight: 700;
}

.home-section-copy {
  color: #52606d;
  max-width: 42rem;
}

.home-card {
  background: #fff;
  border: 1px solid #e6ecf2;
  border-radius: 1rem;
  box-shadow: 0 .75rem 1.5rem rgba(16, 24, 40, 0.06);
  color: inherit;
  display: block;
  height: 100%;
  padding: 1.25rem;
  text-decoration: none;
  transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
}

.home-card:hover,
.home-card:focus {
  border-color: #9dd9d2;
  box-shadow: 0 1rem 2rem rgba(16, 24, 40, 0.1);
  color: inherit;
  transform: translateY(-2px);
}

.home-card-kicker {
  color: #7c8b99;
  font-size: .82rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.home-card h3 {
  color: #123a67;
  font-size: 1.2rem;
  margin: .5rem 0;
}

.home-card p {
  color: #51606f;
  margin: 0;
}

.home-bullet-list {
  color: #334155;
  margin: 0;
  padding-left: 1.1rem;
}

.home-bullet-list li + li {
  margin-top: .45rem;
}

.home-example-link {
  color: #0f766e;
  font-weight: 600;
  text-decoration: none;
}

.home-example-link:hover,
.home-example-link:focus {
  text-decoration: underline;
}

.home-search-result {
  border-bottom: 1px solid #edf2f7;
  color: inherit;
  display: block;
  padding: .85rem 1rem;
  text-decoration: none;
}

.home-search-result:last-child {
  border-bottom: 0;
}

.home-search-result:hover,
.home-search-result:focus {
  background: #f8fafc;
  color: inherit;
}

.home-search-result-code {
  color: #0f766e;
  font-size: .9rem;
  font-weight: 700;
}

.home-search-result-meta {
  color: #64748b;
  font-size: .85rem;
}

.home-note {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 1rem;
}

@media (max-width: 767.98px) {
  .home-hero {
    border-radius: 1rem;
  }
}
`

const primaryCards = [
  {
    href: 'companies-filter.html',
    kicker: 'Company Research',
    title: '公司研究',
    copy: '从筛选、涨跌、机构持仓到单公司财务、公告、研报，形成完整研究路径。',
  },
  {
    href: 'funds.html',
    kicker: 'Fund Research',
    title: '基金研究',
    copy: '覆盖基金排名、持仓、成分股与净值表现，适合快速比较不同产品。',
  },
  {
    href: 'research-news.html',
    kicker: 'Research Feed',
    title: '研报资讯',
    copy: '把更值得看的公司研报、行业报告和资讯聚合在一个入口里。',
  },
  {
    href: '13f.html',
    kicker: 'Global Allocation',
    title: '13F 持仓',
    copy: '跟踪海外机构的季度持仓变化，补充观察重要资金动向。',
  },
]

const workflowCards = [
  {
    href: 'companies-holding.html',
    title: '从机构持仓找线索',
    copy: '看哪些公司被更多机构持续持有，再进入公司详情交叉验证基本面。',
  },
  {
    href: 'sector-flow.html',
    title: '从板块资金流看风格',
    copy: '先观察资金偏好切换，再回到公司筛选找更具体的候选标的。',
  },
  {
    href: 'index.html',
    title: '用指数走势做对比基准',
    copy: '把单个公司或基金和主要指数做区间对比，避免脱离市场环境看表现。',
  },
]

const exampleSearches = [
  { label: '贵州茅台', query: '600519' },
  { label: '招商银行', query: '600036' },
  { label: '纳斯达克100 ETF', query: '513100' },
  { label: '腾讯控股', query: '00700' },
]

function labelForMarket(result: SearchResult) {
  const market = String(result.market || '').trim()
  switch (market) {
    case 'cn-sh':
      return 'A股·沪市'
    case 'cn-sz':
      return 'A股·深市'
    case 'cn-bj':
      return 'A股·北交所'
    case 'hk':
      return '港股'
    case 'fund':
      return '基金'
    default:
      return market || '全球市场'
  }
}

function routeForResult(result: SearchResult) {
  const code = String(result.code || '').trim()
  if (!code) {
    return '#'
  }
  if (String(result.type || '').toLowerCase() === 'fund' || code.endsWith('.OF')) {
    return `fund.html?code=${encodeURIComponent(code.endsWith('.OF') ? code : `${code}.OF`)}`
  }
  return `company.html?code=${encodeURIComponent(code)}`
}

const HomePage = defineComponent({
  name: 'HomePage',
  setup() {
    const query = ref('')
    const searching = ref(false)
    const status = ref('输入股票代码、公司名称或基金名称后可直接跳转。')
    const suggestions = ref<SearchResult[]>([])
    let currentRequestId = 0
    let searchTimer = 0

    const searchNow = async (raw: string) => {
      const trimmed = raw.trim()
      currentRequestId += 1
      const requestId = currentRequestId
      if (!trimmed) {
        suggestions.value = []
        searching.value = false
        status.value = '输入股票代码、公司名称或基金名称后可直接跳转。'
        return
      }
      searching.value = true
      status.value = '搜索中...'
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`)
        const payload = await response.json()
        if (requestId !== currentRequestId) {
          return
        }
        const rows = Array.isArray(payload?.data) ? payload.data as SearchResult[] : []
        suggestions.value = rows
        status.value = rows.length > 0 ? `找到 ${rows.length} 个结果` : '没有找到匹配结果'
      } catch (error) {
        if (requestId !== currentRequestId) {
          return
        }
        suggestions.value = []
        status.value = error instanceof Error ? error.message : '搜索失败，请稍后重试'
      } finally {
        if (requestId === currentRequestId) {
          searching.value = false
        }
      }
    }

    watch(query, (value) => {
      window.clearTimeout(searchTimer)
      searchTimer = window.setTimeout(() => {
        void searchNow(value)
      }, 220)
    })

    onMounted(() => {
      const q = new URLSearchParams(window.location.search).get('q')?.trim() || ''
      if (q) {
        query.value = q
      }
    })

    onBeforeUnmount(() => {
      window.clearTimeout(searchTimer)
    })

    const openFirstResult = () => {
      const first = suggestions.value[0]
      if (!first) {
        status.value = '请先从下方结果中选择证券。'
        return
      }
      window.location.href = routeForResult(first)
    }

    const onSubmit = (event: Event) => {
      event.preventDefault()
      openFirstResult()
    }

    return () => h('div', { class: 'container py-4 py-lg-5' }, [
      h('style', homePageStyle),
      h('section', { class: 'home-hero p-4 p-lg-5 mb-4 mb-lg-5' }, [
        h('div', { class: 'row align-items-center g-4 position-relative', style: 'z-index: 1;' }, [
          h('div', { class: 'col-lg-7' }, [
            h('div', { class: 'small text-uppercase fw-bold mb-3', style: 'letter-spacing: .12em;' }, 'Investment Research Hub'),
            h('h1', { class: 'display-5 fw-bold mb-3' }, '把股票、基金、研报资讯放到同一条研究路径里。'),
            h('p', { class: 'lead mb-4', style: 'max-width: 42rem;' }, '先找候选标的，再看机构、财务、资讯和持仓变化。首页不做花架子，直接把最常用的入口和高价值内容放在一起。'),
            h('div', { class: 'mb-3' }, exampleSearches.map((item) => h('button', {
              key: item.query,
              class: 'home-chip border-0',
              type: 'button',
              onClick: () => {
                query.value = item.query
              },
            }, item.label))),
            h('div', { class: 'small text-white-50' }, '覆盖股票、基金、研报资讯、13F 持仓与多维筛选能力。'),
          ]),
          h('div', { class: 'col-lg-5' }, [
            h('div', { class: 'home-search-shell p-3 p-lg-4' }, [
              h('form', { onSubmit }, [
                h('label', { for: 'homeSearchInput', class: 'form-label fw-semibold' }, '输入股票代码、公司名称或基金名称'),
                h('div', { class: 'd-flex gap-2 flex-column flex-sm-row' }, [
                  h('input', {
                    id: 'homeSearchInput',
                    class: 'form-control form-control-lg',
                    type: 'search',
                    placeholder: '例如 600519、招商银行、513100',
                    value: query.value,
                    onInput: (event: Event) => {
                      query.value = (event.target as HTMLInputElement).value
                    },
                  }),
                  h('button', { class: 'btn btn-success btn-lg px-4', type: 'submit', disabled: searching.value }, searching.value ? '搜索中' : '进入详情'),
                ]),
              ]),
              h('div', { class: 'small text-muted mt-3' }, status.value),
              suggestions.value.length > 0
                ? h('div', { class: 'mt-3 border rounded-4 overflow-hidden bg-white' }, suggestions.value.map((item) => h('a', {
                  key: item.code,
                  href: routeForResult(item),
                  class: 'home-search-result',
                }, [
                  h('div', { class: 'd-flex justify-content-between gap-3' }, [
                    h('div', [
                      h('div', { class: 'fw-semibold' }, item.name),
                      h('div', { class: 'home-search-result-meta mt-1' }, labelForMarket(item)),
                    ]),
                    h('div', { class: 'home-search-result-code' }, item.code),
                  ]),
                ])))
                : null,
            ]),
          ]),
        ]),
      ]),
      h('section', { class: 'mb-4 mb-lg-5' }, [
        h('div', { class: 'd-flex flex-column flex-lg-row justify-content-between align-items-lg-end gap-3 mb-3' }, [
          h('div', [
            h('h2', { class: 'home-section-title mb-2' }, '四个主入口'),
            h('p', { class: 'home-section-copy mb-0' }, '按真实研究流程组织，而不是把所有页面平铺成导航列表。'),
          ]),
          h('a', { href: 'research-news.html', class: 'home-example-link' }, '先看研报资讯'),
        ]),
        h('div', { class: 'row g-3 g-lg-4' }, primaryCards.map((card) => h('div', { key: card.href, class: 'col-md-6 col-xl-3' }, [
          h('a', { href: card.href, class: 'home-card' }, [
            h('div', { class: 'home-card-kicker' }, card.kicker),
            h('h3', card.title),
            h('p', card.copy),
          ]),
        ]))),
      ]),
      h('section', { class: 'mb-4 mb-lg-5' }, [
        h('div', { class: 'row g-3 g-lg-4' }, [
          h('div', { class: 'col-lg-7' }, [
            h('div', { class: 'home-card' }, [
              h('div', { class: 'home-card-kicker' }, 'Recommended Workflow'),
              h('h3', '更适合真实使用的研究顺序'),
              h('ol', { class: 'home-bullet-list mt-3' }, [
                h('li', '先用公司筛选或基金筛选找到候选标的。'),
                h('li', '再看机构持仓、板块资金流和指数对比，判断它处在什么市场环境。'),
                h('li', '最后回到单公司、单基金或研报资讯页做更细的确认。'),
              ]),
            ]),
          ]),
          h('div', { class: 'col-lg-5' }, [
            h('div', { class: 'home-note p-4 h-100' }, [
              h('div', { class: 'home-card-kicker mb-2' }, 'What This Site Is Good At'),
              h('ul', { class: 'home-bullet-list' }, [
                h('li', '把股票、基金和内容研究放到同一个站内闭环。'),
                h('li', '公司页覆盖股价、财务、公告、研报、资讯。'),
                h('li', '研报资讯页适合作为“每天先看什么”的入口。'),
              ]),
            ]),
          ]),
        ]),
      ]),
      h('section', { class: 'mb-4 mb-lg-5' }, [
        h('h2', { class: 'home-section-title mb-2' }, '常用能力'),
        h('p', { class: 'home-section-copy mb-3' }, '不是所有能力都适合放进首屏，但应该让用户一眼找到下一步。'),
        h('div', { class: 'row g-3' }, workflowCards.map((card) => h('div', { key: card.href, class: 'col-md-4' }, [
          h('a', { href: card.href, class: 'home-card' }, [
            h('h3', card.title),
            h('p', card.copy),
          ]),
        ]))),
      ]),
      h('section', { class: 'home-note p-4 p-lg-5' }, [
        h('div', { class: 'row g-4' }, [
          h('div', { class: 'col-lg-7' }, [
            h('h2', { class: 'home-section-title mb-2' }, '关于数据与使用方式'),
            h('p', { class: 'mb-2 text-secondary' }, '本站更适合做研究入口和信息聚合，不替代完整交易终端。'),
            h('ul', { class: 'home-bullet-list' }, [
              h('li', '数据覆盖股票、基金、研报资讯与13F等公开信息。'),
              h('li', '更适合先收敛范围，再对个股或基金做深入查看。'),
              h('li', '内容仅供研究参考，不构成投资建议。'),
            ]),
          ]),
          h('div', { class: 'col-lg-5' }, [
            h('div', { class: 'small text-uppercase fw-semibold text-secondary mb-2' }, 'Quick Links'),
            h('div', { class: 'd-flex flex-column gap-2' }, [
              h('a', { href: 'company.html?code=600519.SH', class: 'home-example-link' }, '示例公司：贵州茅台'),
              h('a', { href: 'fund.html?code=513100.OF', class: 'home-example-link' }, '示例基金：纳指 ETF'),
              h('a', { href: 'research-news.html', class: 'home-example-link' }, '去看今日研报资讯'),
            ]),
          ]),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('home-vue-root')
if (root) {
  createApp(HomePage).mount(root)
}
