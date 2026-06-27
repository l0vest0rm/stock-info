type SelectConfig = {
  placeholder?: string
  noSearch?: boolean
  urlParam?: string
  valueTextMap?: (value: string) => string
  delay?: number
  cache?: boolean
  request?: (term: string) => any
  transResults?: (data: any, term: string) => any
}

type AutocompleteConfig = {
  minLength: number
  delay?: number
  cacheSelecNum: number
  request: (term: string) => any
  transResults?: (data: any) => any
  select: (event: Event, item: any) => void
}

type CardsConfig = {
  data?: string | any[][]
  request?: (page: string) => any
  transResults?: (data: any) => any[][]
  afterRender?: () => void
  pageSize?: number
}

type LegacyControlsContext = {
  server: string
  securities: string[][]
  fetchRequest: (request: any) => Promise<any>
  replaceUrlParam: (key: string, value: string) => void
  selectedOptionValues: (element: Element | null) => string[]
  currentPage: () => string
  cacheCodeName: (code: string, name: string, save: boolean) => boolean
  codeNameMap: Record<string, string>
  getUrlParam: (key: string) => string | undefined
}

function pagination(refId: string, page: string | undefined, pageSize: number, data: any, pageClick: (page: string) => void) {
  const curPage = page ? parseInt(page, 10) : 1
  const hasNext = data && data.length >= pageSize
  let html = `<ul class="pagination justify-content-center">
  <li class="page-item${curPage < 11 ? ' disabled' : ''}">
  <a class="page-link" data-page="${curPage < 11 ? 1 : curPage - 10}" href="#"><<</a>
</li>`
  let thisPage = curPage
  let text: string | number = thisPage
  for (let i = 1; i < 11; i += 1) {
    if (curPage < 9) {
      thisPage = i
      text = thisPage
    } else if (i < 4) {
      thisPage = i
      text = thisPage
    } else if (i === 4) {
      thisPage = Math.floor(curPage / 2)
      text = '...'
    } else {
      thisPage = curPage + i - 8
      text = thisPage
    }
    const disabled = thisPage > curPage && !hasNext
    html += `<li class="page-item${curPage === thisPage ? ' active"' : ''}${disabled ? ' disabled' : ''}">
    <a class="page-link" data-page="${thisPage}" href="#">${text}</a>
  </li>`
  }
  html += `<li class="page-item${hasNext ? '' : ' disabled'}">
  <a class="page-link" data-page="${curPage + 10}" href="#">>></a>
</li></ul>`

  if (curPage === 1 && (!data || !data.length)) {
    html = ''
  }

  const navId = `${refId}-nav`
  let nav = document.getElementById(navId)
  if (nav) {
    nav.innerHTML = html
  } else {
    nav = document.createElement('nav')
    nav.id = navId
    nav.innerHTML = html
    const ref = document.getElementById(refId)
    ref?.parentNode?.insertBefore(nav, ref.nextSibling)
  }

  nav.querySelectorAll('a').forEach((elem) => {
    elem.addEventListener('click', () => {
      pageClick((elem as HTMLAnchorElement).dataset.page || '1')
    })
  })
}

export function createLegacyControls(context: LegacyControlsContext) {
  const { server, securities, fetchRequest, replaceUrlParam, selectedOptionValues, currentPage, cacheCodeName, codeNameMap, getUrlParam } = context

  function getSearchResultCodeText(code: string): string {
    if (codeNameMap[code]) {
      return `${codeNameMap[code]}(${code})`
    }
    return code
  }

  function cacheCodeNameMap(data: any[]) {
    let needSave = false
    for (const x of data) {
      if (cacheCodeName(x.id, x.name, false)) {
        needSave = true
      }
    }
    if (needSave) {
      localStorage.setItem('codeNameMap', JSON.stringify(codeNameMap))
    }
  }

  function securitiesFilter(cats: string[], targetSecurities: any) {
    const result: any = []
    for (const item of targetSecurities) {
      let is = false
      if (cats.length === 0) {
        is = true
      } else {
        for (const cat of cats) {
          if (item[0].endsWith(cat)) {
            is = true
          }
        }
      }
      if (is) {
        result.push({ id: item[0], name: item[1] })
      }
    }
    return result
  }

  function bsAutocomplete(id: string, config: AutocompleteConfig) {
    const recentKey = `${id}-recentClick`
    let recents: any = []
    if (config.cacheSelecNum) {
      const str = localStorage.getItem(recentKey)
      if (str) {
        recents = JSON.parse(str)
      }
    }

    if (!config.delay) {
      config.delay = 250
    }
    const input = document.getElementById(id) as HTMLInputElement
    const list = document.createElement('div')
    list.classList.add('list-group', 'list-autocomplete', 'position-absolute', 'start-0', 'end-0', 'top-100', 'z-3', 'mt-1', 'shadow')
    list.style.maxHeight = '24rem'
    list.style.overflowY = 'auto'
    input.parentNode?.insertBefore(list, input.nextSibling)
    let tid: number
    ;['input', 'click'].forEach((type) => {
      input.addEventListener(type, (e) => {
        e.stopPropagation()
        if (tid) {
          clearTimeout(tid)
        }
        tid = window.setTimeout(() => {
          const term = input.value.trim()
          if (term.trim().length < config.minLength) {
            if (config.cacheSelecNum && recents.length) {
              response(recents)
            }
          } else {
            fetchRequest(config.request(term)).then((data: any) => {
              response(config.transResults ? config.transResults(data) : data)
            })
          }
        }, (config as any).dealy || config.delay)
      })
    })

    document.addEventListener('click', () => {
      list.classList.add('d-none')
    })

    const response = (result: any) => {
      let html = ''
      for (const item of result) {
        html += `<a href="#" class="list-group-item list-group-item-action" data-id="${item.id}">${item.name}</a>`
      }
      list.innerHTML = html
      list.classList.remove('d-none')
      list.querySelectorAll('.list-group-item').forEach((elem) => {
        elem.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (config.cacheSelecNum) {
            recents.unshift({ id: (elem as HTMLElement).dataset.id, name: (elem as HTMLElement).textContent })
            recents = recents.filter((v1: any, i: number) => i === recents.findIndex((v2: any) => v2.id === v1.id))
            if (recents.length > config.cacheSelecNum) {
              recents = recents.slice(0, config.cacheSelecNum)
            }
            localStorage.setItem(recentKey, JSON.stringify(recents))
          }
          config.select(e, { id: (elem as HTMLElement).dataset.id, name: (elem as HTMLElement).textContent })
        })
      })
    }
  }

  function codeSearchInit() {
    bsAutocomplete('autocomplete', {
      minLength: 2,
      cacheSelecNum: 20,
      request: (term: string) => {
        if (term) {
          return {
            url: `${server}/api/suggest`,
            cacheKey: `autocomplete-${term}`,
            cacheTtl: 360000,
            params: { q: term },
          }
        }
        return securitiesFilter([], securities)
      },
      transResults: (data: any) => {
        const result: any = []
        cacheCodeNameMap(data)
        for (const item of data) {
          result.push({ id: item.id, name: getSearchResultCodeText(item.id) })
        }
        return result
      },
      select: (_event, item) => {
        const code: string = item.id
        const parts = code.split('.')
        const encodedCode = encodeURIComponent(code)
        let href = ''
        switch (parts[1]) {
          case 'SZ':
          case 'SH':
          case 'BJ':
          case 'HK':
          case 'KS':
          case 'US':
            href = currentPage().startsWith('company') ? `${currentPage()}?code=${encodedCode}` : `company.html?code=${encodedCode}`
            break
          case 'OF':
          case 'SF':
          case 'ZF':
            href = `fund.html?code=${encodedCode}`
            break
          case 'ZI':
          case 'SI':
          case 'HI':
            href = `index.html?code=${encodedCode}`
            break
          default:
            break
        }
        if (href !== '') {
          window.location.href = href
        }
      },
    })
  }

  function bsSelect(id: string, config: SelectConfig) {
    if (!config.placeholder) {
      config.placeholder = ''
    }
    if (!config.delay) {
      config.delay = 200
    }
    const localCache: any = {}
    const select = document.getElementById(id) as HTMLSelectElement
    const multiple = select.hasAttribute('multiple')
    select.classList.add('d-none')
    const dropdownId = `${id}-dropdown`
    const oldDropdown = document.getElementById(dropdownId)
    oldDropdown?.parentNode?.removeChild(oldDropdown)
    const dropdown = document.createElement('div')
    dropdown.id = dropdownId
    dropdown.classList.add('dropdown')
    let html = `<a class="btn btn-sm border border-info dropdown-toggle text-start text-wrap" href="#" role="button">
  ${config.placeholder}
</a>
<ul class="dropdown-menu">
`
    select.querySelectorAll('option').forEach((option) => {
      html += `<li><a class="dropdown-item" data-id="${option.value}" href="#">${option.textContent}</a></li>`
    })
    dropdown.innerHTML = html
    select.parentNode?.insertBefore(dropdown, select.nextSibling)
    const btn = dropdown.querySelector('.dropdown-toggle') as HTMLButtonElement
    const ul = dropdown.querySelector('ul') as HTMLUListElement
    const input = document.createElement('input')
    input.setAttribute('type', 'text')
    input.classList.add('form-control', 'form-control-sm', 'mx-auto', 'w-90')
    if (config.noSearch) {
      input.classList.add('d-none')
    }
    ul.insertBefore(input, ul.firstChild)
    let shown = false
    const showDropdown = () => {
      ul.classList.add('show')
      shown = true
      input.focus()
    }

    const selectChanged = () => {
      if (config.urlParam) {
        replaceUrlParam(config.urlParam, selectedOptionValues(select).join(','))
      }
      select.dispatchEvent(new Event('change'))
    }

    const appendSelectedItem = (option: HTMLOptionElement) => {
      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.classList.add('btn-close')
      const span = document.createElement('span')
      span.classList.add('select-item', 'text-nowrap')
      span.textContent = option.textContent
      span.dataset.id = option.value
      span.appendChild(closeBtn)
      btn.appendChild(span)
      closeBtn.addEventListener('click', () => {
        shown = false
        btn.removeChild(span)
        if (!btn.firstChild) {
          btn.textContent = config.placeholder || ''
        }
        option.removeAttribute('selected')
        selectChanged()
      })
    }

    const itemSelect = (itemId: string, text: string | null) => {
      let option: HTMLOptionElement | undefined
      select.querySelectorAll('option').forEach((elem) => {
        if (elem.value === itemId) {
          option = elem
          text = elem.textContent
        }
      })

      if (option && option.hasAttribute('selected')) {
        return
      }
      if (!text) {
        text = config.valueTextMap ? config.valueTextMap(itemId) : itemId
      }

      if (!btn.querySelector('span')) {
        btn.textContent = ''
      }
      if (multiple) {
        if (option) {
          option.setAttribute('selected', '')
        } else {
          option = document.createElement('option')
          option.value = itemId
          option.textContent = text
          option.setAttribute('selected', '')
          select.appendChild(option)
        }
        appendSelectedItem(option)
      } else {
        btn.textContent = text
        select.innerHTML = `<option value=${itemId} selected>${text}</option>`
      }
      selectChanged()
    }

    const addDropdownItemClickEvent = () => {
      ul.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', () => {
          itemSelect((a as HTMLElement).dataset.id || '', a.textContent)
        })
      })
    }

    const response = (key: string, result: any) => {
      if (config.cache) {
        localCache[key] = result
      }
      const value = input.value
      const selectedOptions: string[] = []
      select.querySelectorAll('option').forEach((option) => {
        if (option.hasAttribute('selected')) {
          selectedOptions.push(option.value)
        }
      })
      ul.querySelectorAll('li').forEach((li) => {
        ul.removeChild(li)
      })
      for (const item of result) {
        if (value && item.name.indexOf(value) < 0) {
          continue
        }
        const a = document.createElement('a')
        a.classList.add('dropdown-item')
        if (selectedOptions.includes(`${item.id}`)) {
          a.classList.add('active')
        } else {
          a.classList.remove('active')
        }
        a.setAttribute('href', '#')
        a.dataset.id = item.id
        a.appendChild(document.createTextNode(item.name))
        const li = document.createElement('li')
        li.appendChild(a)
        ul.appendChild(li)
      }
      addDropdownItemClickEvent()
      showDropdown()
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (shown) {
        ul.classList.remove('show')
        input.value = ''
        shown = false
      } else if (config.request) {
        const key = `${id}-`
        if (config.cache && localCache[key]) {
          response(key, localCache[key])
        } else {
          fetchRequest(config.request('')).then((data: any) => {
            response(key, config.transResults ? config.transResults(data, '') : data)
          })
        }
      } else {
        const selectedOptions: string[] = []
        select.querySelectorAll('option').forEach((option) => {
          if (option.hasAttribute('selected')) {
            selectedOptions.push(option.value)
          }
        })
        ul.querySelectorAll('a').forEach((a: any) => {
          a.classList.remove('d-none')
          if (selectedOptions.includes(a.dataset.id)) {
            a.classList.add('active')
          } else {
            a.classList.remove('active')
          }
        })
        showDropdown()
      }
    })

    document.addEventListener('click', () => {
      ul.classList.remove('show')
      input.value = ''
      shown = false
    })

    let tid: number
    input.addEventListener('input', () => {
      if (tid) {
        clearTimeout(tid)
      }
      tid = window.setTimeout(() => {
        const value = input.value.trim()
        if (config.request) {
          const key = `${id}-${value}`
          if (localCache[key]) {
            response(key, localCache[key])
          } else {
            fetchRequest(config.request(value)).then((data: any) => {
              response(key, config.transResults ? config.transResults(data, value) : data)
            })
          }
        } else {
          ul.querySelectorAll('a').forEach((a) => {
            if (value && (a.textContent || '').indexOf(value) < 0) {
              a.classList.add('d-none')
            } else {
              a.classList.remove('d-none')
            }
          })
        }
      }, config.delay)
    })

    select.addEventListener('bs.change', () => {
      btn.textContent = ''
      select.querySelectorAll('option').forEach((option) => {
        if (option.hasAttribute('selected')) {
          if (multiple) {
            let found = false
            btn.querySelectorAll('span').forEach((span) => {
              if ((span as HTMLElement).dataset.id === option.value) {
                found = true
              }
            })
            if (!found) {
              appendSelectedItem(option)
            }
          } else {
            btn.textContent = option.textContent
          }
        }
      })
      if (!btn.firstChild) {
        btn.textContent = config.placeholder || ''
      }
      selectChanged()
    })

    addDropdownItemClickEvent()
    if (config.urlParam) {
      const paramStr: string | null = getUrlParam(config.urlParam)
      if (paramStr) {
        const ids = paramStr.split(',')
        for (const itemId of ids) {
          itemSelect(itemId, null)
        }
      }
    }
  }

  function codeSelectInit(cats: string[], id: string, placeholder: string, _disabled: boolean) {
    bsSelect(id, {
      placeholder,
      cache: true,
      urlParam: 'code',
      request: (term: string) => {
        if (!term || cats.includes('DC')) {
          return securitiesFilter(cats, securities)
        }
        return {
          url: `${server}/api/suggest`,
          params: { q: term },
        }
      },
      valueTextMap: (value: string) => getSearchResultCodeText(value),
      transResults: (data: any) => {
        const result: any = []
        cacheCodeNameMap(data)
        for (const item of data) {
          result.push({ id: item.id, name: getSearchResultCodeText(item.id) })
        }
        return result
      },
    })
  }

  function bsRadioButtons(id: string) {
    const parent = document.getElementById(id) as any
    parent.dataset.id = parent.querySelector('.active').dataset.id
    parent.querySelectorAll('.btn').forEach((btn: any) => {
      btn.addEventListener('click', () => {
        parent.querySelectorAll('.btn').forEach((theBtn: any) => {
          if (btn === theBtn) {
            btn.classList.add('active')
            parent.dataset.id = btn.dataset.id
            parent.dispatchEvent(new Event('bs.change'))
          } else {
            theBtn.classList.remove('active')
          }
        })
      })
    })
  }

  function bsCards(id: string, config: CardsConfig) {
    const list = document.getElementById(id) as HTMLElement
    const renderCards = (targetList: HTMLElement, rows: any, targetConfig: CardsConfig): void => {
      let html = ''
      for (const item of rows) {
        html += `<a href="${item.url}" class="list-group-item list-group-item-action" target="_blank">
      <div class="d-flex w-100 justify-content-between">
        <h5 class="mb-1">${item.title}</h5>
        <small>${item.date || ''}</small>
      </div>
      <p class="mb-1">${item.content}</p>
      </a><hr>`
      }
      targetList.innerHTML = html
      if (targetConfig.pageSize) {
        pagination(id, targetList.dataset.page, targetConfig.pageSize, rows, (page) => {
          if (targetConfig.request) {
            targetList.dataset.page = page
            fetchRequest(targetConfig.request(targetList.dataset.page)).then((data: any) => {
              renderCards(targetList, targetConfig.transResults ? targetConfig.transResults(data) : data, targetConfig)
            })
          }
        })
      }
      if (targetConfig.afterRender) {
        targetConfig.afterRender()
      }
    }

    list.dataset.page = '1'
    if (config.request) {
      fetchRequest(config.request('1')).then((data: any) => {
        renderCards(list, config.transResults ? config.transResults(data) : data, config)
      })
    } else {
      renderCards(list, config.data, config)
    }
  }

  return {
    cacheCodeNameMap,
    bsSelect,
    bsRadioButtons,
    bsCards,
    codeSearchInit,
    codeSelectInit,
  }
}
