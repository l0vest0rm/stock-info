import { createApp, defineComponent, h } from 'vue'
import navigation from './config/navigation.json'

type NavItem = {
  href: string
  text: string
}

type NavigationConfig = {
  nav: NavItem[]
  companiesNav: NavItem[]
  companyNav: NavItem[]
  fundNav: NavItem[]
  indexNav: NavItem[]
}

const navConfig = navigation as NavigationConfig

function currentPage(): string {
  const parts = window.location.pathname.split('/')
  return parts[parts.length - 1] || 'home.html'
}

function pageFromElement(element: HTMLElement): string {
  return element.dataset.page || currentPage()
}

function subnavItems(kind: string): NavItem[] {
  const filterLocalOnly = (items: NavItem[]) => items.filter((item) => {
    if (item.href === 'company-option.html') {
      return isLocalHost()
    }
    return true
  })
  switch (kind) {
    case 'companies':
      return navConfig.companiesNav
    case 'company':
      return filterLocalOnly(navConfig.companyNav)
    case 'fund':
      return navConfig.fundNav
    case 'index':
      return navConfig.indexNav
    default:
      return []
  }
}

function isLocalHost(): boolean {
  return window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '0.0.0.0'
}

function topNavClass(page: string, href: string): string {
  const stateClass = page === href ? 'text-secondary active' : 'text-white'
  return `nav-link px-2 ${stateClass}`
}

function subnavClass(page: string, href: string): string {
  const stateClass = page === href ? 'btn-success active' : 'btn-outline-success'
  return `btn btn-sm ${stateClass}`
}

function renderSubnavLinks(kind: string, page: string) {
  return subnavItems(kind).map((item) => h('a', {
    key: item.href,
    href: item.href,
    name: 'codeSpec',
    class: subnavClass(page, item.href),
    'aria-current': page === item.href ? 'true' : undefined,
  }, item.text))
}

const AppTopNav = defineComponent({
  name: 'AppTopNav',
  props: {
    page: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    return () => h('header', { class: 'p-0 bg-dark text-white' }, [
      h('div', { class: 'container' }, [
        h('div', { class: 'd-flex flex-wrap align-items-center justify-content-center' }, [
          h('a', { href: '/', class: 'd-flex align-items-center mb-4 mb-lg-0 text-white text-decoration-none' }, [
            h('span', { class: 'fs-4' }, '理财人licairen.vip  |'),
          ]),
          h('ul', { class: 'nav col-12 col-lg-auto me-lg-auto mb-2 justify-content-center mb-md-0' },
            navConfig.nav.map((item) => h('li', { key: item.href }, [
              h('a', {
                href: item.href,
                class: topNavClass(props.page, item.href),
                'aria-current': props.page === item.href ? 'true' : undefined,
              }, item.text),
            ])),
          ),
          h('form', { class: 'col-12 col-lg-auto mb-3 mb-lg-0 me-lg-3' }, [
            h('input', {
              id: 'autocomplete',
              type: 'search',
              autocomplete: 'off',
              class: 'form-control form-control-sm form-control-dark',
              placeholder: 'Search...',
            }),
          ]),
        ]),
      ]),
    ])
  },
})

const SubNav = defineComponent({
  name: 'SubNav',
  props: {
    kind: {
      type: String,
      required: true,
    },
    page: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    return () => {
      const nested = props.kind === 'fund' || props.kind === 'index'
      const buttonGroup = h('div', { class: 'btn-group', role: 'group' }, renderSubnavLinks(props.kind, props.page))
      if (nested) {
        return h('div', { id: 'container', class: 'py-2' }, [
          h('div', { class: 'text-center' }, [buttonGroup]),
        ])
      }
      return h('div', { class: 'container text-center my-2' }, [buttonGroup])
    }
  },
})

const CompanyInfoBar = defineComponent({
  name: 'CompanyInfoBar',
  setup() {
    return () => h('div', { class: 'text-center border my-2' }, [
      h('span', { class: 'px-1 fs-5 fw-medium', id: 'codeName' }),
      h('span', { class: 'px-1' }, ['股价: ', h('span', { id: 'currentPrice' })]),
      h('span', { class: 'px-1' }, ['涨跌: ', h('span', { id: 'priceChange' })]),
      h('span', { class: 'px-1' }, ['今年涨跌: ', h('span', { id: 'ytdPriceChange' })]),
      h('span', { class: 'px-1' }, ['去年至今: ', h('span', { id: 'last2NowPriceChange' })]),
      h('span', { class: 'px-1' }, ['市值: ', h('span', { id: 'marketCap' }), '(亿)']),
      h('span', { id: 'stockValuation' }),
      h('span', { class: 'px-1', id: 'yield' }),
    ])
  },
})

const AppFooter = defineComponent({
  name: 'AppFooter',
  setup() {
    return () => h('div', { class: 'container' }, [
      h('footer', { class: 'row row-cols-5 py-5 my-5 border-top' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col-3' }, [
          h('a', { href: 'https://beian.miit.gov.cn/', target: '_blank' }, '京ICP备20020159号-1'),
        ]),
        h('div', { class: 'col' }, [
          h('h5', 'Section'),
          h('ul', { class: 'nav flex-column' }, [
            h('li', { class: 'nav-item mb-2' }, [
              h('a', { href: '#', class: 'nav-link p-0 text-muted' }, 'Home'),
            ]),
          ]),
        ]),
      ]),
    ])
  },
})

function mountLayout() {
  const topNav = document.getElementById('app-top-nav')
  if (topNav) {
    createApp(AppTopNav, { page: pageFromElement(topNav) }).mount(topNav)
  }

  document.querySelectorAll<HTMLElement>('[data-layout-subnav]').forEach((element) => {
    createApp(SubNav, { kind: element.dataset.layoutSubnav || '', page: pageFromElement(element) }).mount(element)
  })

  document.querySelectorAll<HTMLElement>('[data-layout-company-info]').forEach((element) => {
    createApp(CompanyInfoBar).mount(element)
  })

  const footer = document.getElementById('app-footer')
  if (footer) {
    createApp(AppFooter).mount(footer)
  }
}

mountLayout()
