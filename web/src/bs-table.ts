export interface SortableTableConfig {
  request?: (sortBy: string, asc: boolean, page: string) => any
  transResults?: (data: any) => string | any | Promise<any>
  afterRender?: () => void
  data?: string | any[][]
  cell?: (cell: any, rowIdx: number, columnIdx: number) => any
  row?: (row: any, rowIdx: number) => any
  firstAsc?: boolean
  pageSize?: number
}

type FetchRequest = (request: any) => Promise<any>

function pagination(refId: string, page: string | undefined, pageSize: number, data: any, pageClick: (page: string) => void) {
  const curPage = page ? parseInt(page) : 1
  const hasNext = data && data.length >= pageSize
  let html = `<ul class="pagination justify-content-center">
  <li class="page-item${curPage < 11 ? ' disabled' : ''}">
  <a class="page-link" data-page="${curPage < 11 ? 1 : curPage - 10}" href="#"><<</a>
</li>`
  let thisPage = curPage
  let text: any = thisPage
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

  const navid = `${refId}-nav`
  let nav = document.getElementById(navid)
  if (nav) {
    nav.innerHTML = html
  } else {
    nav = document.createElement('nav')
    nav.id = navid
    nav.innerHTML = html
    const ref = document.getElementById(refId) as HTMLElement | null
    ref?.parentNode?.insertBefore(nav, ref.nextSibling)
  }

  nav.querySelectorAll('a').forEach((elem) => elem.addEventListener('click', () => {
    pageClick((elem as HTMLAnchorElement).dataset.page || '1')
  }))
}

export function createBsTable(fetchRequest: FetchRequest) {
  return function bsTable(tableid: string, config: SortableTableConfig) {
    const getCellValue = (tr: any, idx: number) => {
      const cell = tr.children[idx]
      if (!cell) {
        return ''
      }
      const input = cell.querySelector('input')
      if (input) {
        return input.value
      }
      return cell.innerText || cell.textContent
    }

    const comparer = (idx: number, asc: boolean) => (a: any, b: any) => ((v1, v2) =>
      v1 !== '' && v2 !== '' && !isNaN(v1) && !isNaN(v2) ? v1 - v2 : v1.toString().localeCompare(v2)
    )(getCellValue(asc ? a : b, idx), getCellValue(asc ? b : a, idx))

    const clientColumnSort = (table: HTMLTableElement, th: HTMLTableCellElement, asc: boolean) => {
      table.dataset.page = '1'
      const tbody = table.querySelector('tbody') as HTMLTableSectionElement
      Array.from(tbody.querySelectorAll('tr'))
        .sort(comparer(Array.from((th.parentNode as HTMLTableRowElement).children).indexOf(th), asc))
        .forEach((tr) => tbody.appendChild(tr))
      refreshSortFlag(table, th, asc)
    }

    const serverColumnSort = (table: HTMLTableElement, th: HTMLTableCellElement, asc: boolean) => {
      if (!config.request) {
        return
      }
      table.dataset.st = th.dataset.st
      table.dataset.page = '1'
      fetchRequest(config.request(th.dataset.st ? th.dataset.st : '', asc, '1')).then(async (data: any) => {
        const results = config.transResults ? await config.transResults(data) : data
        renderTable(table, results, config)
      })
      refreshSortFlag(table, th, asc)
    }

    const columnSort = config.request ? serverColumnSort : clientColumnSort

    const refreshSortFlag = (table: HTMLTableElement, th: HTMLTableCellElement, asc: boolean) => {
      ;(table as any).asc = asc
      ;(th as any).asc = asc
      table.querySelectorAll('th.sortable').forEach((elem) => {
        elem.classList.remove('asc')
        elem.classList.remove('desc')
        if (elem === th) {
          elem.classList.add(asc ? 'asc' : 'desc')
        } else {
          ;(elem as any).asc = undefined
        }
      })
    }

    const renderTable = (table: HTMLTableElement, rows: any, tableConfig: SortableTableConfig): void => {
      let html = ''
      if (typeof rows === 'string') {
        html = rows
      } else {
        for (let i = 0; i < rows.length; i += 1) {
          let row = rows[i]
          if (tableConfig.row) {
            const data = tableConfig.row(rows[i], i)
            if (data) {
              if (!data.class) {
                html += '<tr>'
              } else if (typeof data.class === 'string') {
                html += `<tr class="${data.class}">`
              } else {
                html += `<tr class="${data.class.join(' ')}">`
              }
              if (data.row) {
                row = data.row
              }
            } else {
              html += '<tr>'
            }
          } else {
            html += '<tr>'
          }

          for (let j = 0; j < row.length; j += 1) {
            let cell = row[j]
            if (tableConfig.cell) {
              const data = tableConfig.cell(row[j], i, j)
              if (data) {
                if (data.cell) {
                  cell = data.cell
                }
                if (!data.class) {
                  html += `<td>${cell}</td>`
                } else if (typeof data.class === 'string') {
                  html += `<td class="${data.class}">${cell}</td>`
                } else {
                  html += `<td class="${data.class.join(' ')}">${cell}</td>`
                }
              } else {
                html += `<td>${cell}</td>`
              }
            } else {
              html += `<td>${cell}</td>`
            }
          }
          html += '</tr>'
        }
      }

      if (html.indexOf('<thead') > -1) {
        table.innerHTML = html
      } else {
        const withTbody = html.indexOf('<tbody') > -1
        let tbody = table.querySelector('tbody')
        if (!tbody) {
          tbody = document.createElement('tbody')
          table.append(tbody)
        }
        if (withTbody) {
          tbody.outerHTML = html
        } else {
          tbody.innerHTML = html
        }
      }

      if (tableConfig.pageSize) {
        pagination(tableid, table.dataset.page, tableConfig.pageSize, rows, (page) => {
          if (tableConfig.request) {
            table.dataset.page = page
            fetchRequest(tableConfig.request(table.dataset.st || '', (table as any).asc, page)).then(async (data: any) => {
              const results = tableConfig.transResults ? await tableConfig.transResults(data) : data
              renderTable(table, results, tableConfig)
            })
          }
        })
      }

      if (tableConfig.afterRender) {
        tableConfig.afterRender()
      }
    }

    const table = document.getElementById(tableid) as HTMLTableElement
    table.dataset.page = '1'
    if (config.request) {
      let dt: string | undefined
      let asc = true
      if (table.querySelector('th.sortable.asc')) {
        const th = table.querySelector('th.sortable.asc') as HTMLTableCellElement
        dt = th.dataset.st
        asc = true
      } else if (table.querySelector('th.sortable.desc')) {
        const th = table.querySelector('th.sortable.desc') as HTMLTableCellElement
        dt = th.dataset.st
        asc = false
      }
      table.dataset.st = dt
      fetchRequest(config.request(dt ? dt : '', asc, '1')).then(async (data: any) => {
        const results = config.transResults ? await config.transResults(data) : data
        renderTable(table, results, config)
      })
    } else {
      renderTable(table, config.data, config)
      if (table.querySelector('th.sortable.asc')) {
        columnSort(table, table.querySelector('th.sortable.asc') as HTMLTableCellElement, true)
      } else if (table.querySelector('th.sortable.desc')) {
        columnSort(table, table.querySelector('th.sortable.desc') as HTMLTableCellElement, false)
      }
    }

    table.querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => {
      if ((th as any).asc === undefined) {
        ;(th as any).asc = !config.firstAsc
      }
      columnSort(table, th as HTMLTableCellElement, !(th as any).asc)
    }))
  }
}
