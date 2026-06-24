type DateRangeHelpersContext = {
  getUrlParam: (key: string) => string
  replaceUrlParam: (key: string, value: string) => void
  renderLineChart: (startTs: number, endTs: number) => void
  toDateString: (value: number | Date) => string
}

interface DateRangeConfig {
  ranges?: string[][]
}

function parseDateRangeTs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined
  }
  const ts = Number(value)
  if (Number.isFinite(ts) && ts > 0) {
    return ts
  }
  const parsed = new Date(value).getTime()
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return undefined
}

export function createDateRangeHelpers(context: DateRangeHelpersContext) {
  const { getUrlParam, replaceUrlParam, renderLineChart, toDateString } = context

  function changeDateRangeStart(id: string, sd: string | number) {
    const startInput = document.getElementById(`${id}-start`) as HTMLInputElement
    startInput.value = typeof sd === 'string' ? sd : toDateString(sd)
    startInput.dispatchEvent(new Event('change'))
  }

  function bsInputCalenderInit(input: HTMLInputElement) {
    const calender = input.nextElementSibling as HTMLElement
    const weekDays = ['一', '二', '三', '四', '五', '六', '日']
    let showCalender = false
    const renderCalender = (d: Date) => {
      let html = `<div>
    <a class="btn btn-sm nav-month mx-1">&lt;</a>
    <span class="dropdown">
      <button class="btn btn-sm btn-outline-info dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
      ${d.getFullYear()}年
      </button>
      <ul class="dropdown-menu">`

      for (let k = new Date().getFullYear(); k > 2004; k -= 1) {
        html += `<li><button class="dropdown-item year-item" type="button" data-year="${k}">${k}年</button></li>`
      }
      html += ` </ul>
    </span>
    <span class="dropdown">
      <button class="btn btn-sm btn-outline-info dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
      ${d.getMonth() + 1}月
      </button>
      <ul class="dropdown-menu">`
      for (let k = 0; k < 12; k += 1) {
        html += `<li><button class="dropdown-item month-item" type="button" data-month="${k}">${k + 1}月</button></li>`
      }
      html += `</ul>
    </span>
    <a class="btn btn-sm nav-month mx-1">&gt;</a>
    </div>`

      const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      let start = new Date(d.getFullYear(), d.getMonth(), 1).getDay()
      if (start === 0) {
        start = 7
      }
      html += '<table class="table table-sm table-borderless"><thead>'
      for (let i = 0; i < 7; i += 1) {
        let finish = false
        if (i === 1) {
          html += '<tbody>'
        }
        html += '<tr>'
        for (let j = 0; j < 7; j += 1) {
          const day = (i - 1) * 7 + j - start + 2
          if (i === 0) {
            html += `<th class="p-1 m-auto"><button type="button" class="btn btn-light btn-weekday" disabled>${weekDays[j]}</button></th>`
          } else if (day > 0 && day <= days) {
            html += `<td class="p-1 m-auto"><button type="button" class="btn btn-day ${day === d.getDate() ? 'btn-primary' : 'btn-light'}" data-date="${d.getFullYear()}-${d.getMonth() + 1}-${day}">${day}</button></td>`
          } else {
            html += '<td class="p-1 m-auto"><button type="button" class="btn btn-light btn-weekday" disabled></button></td>'
          }
          if (day === days) {
            finish = true
          }
        }
        html += '</tr>'
        if (i === 0) {
          html += '</thead>'
        }
        if (finish) {
          break
        }
      }
      html += '</tbody></table>'
      calender.style.left = `${input.offsetLeft}px`
      calender.innerHTML = html
      calender.classList.remove('d-none')
      calender.querySelectorAll('.nav-month').forEach((elem: any) => {
        elem.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          if (elem.textContent === '<') {
            renderCalender(new Date(d.getFullYear(), d.getMonth() - 1, d.getDate()))
          } else {
            renderCalender(new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()))
          }
        })
      })

      calender.querySelectorAll('.year-item').forEach((elem: any) => {
        elem.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          renderCalender(new Date(elem.dataset.year, d.getMonth(), d.getDate()))
        })
      })

      calender.querySelectorAll('.month-item').forEach((elem: any) => {
        elem.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          renderCalender(new Date(d.getFullYear(), elem.dataset.month, d.getDate()))
        })
      })

      calender.querySelectorAll('.btn-day').forEach((elem: any) => {
        elem.addEventListener('click', (e: Event) => {
          e.stopPropagation()
          input.value = elem.dataset.date
          input.dispatchEvent(new Event('change'))
          calender.classList.add('d-none')
          calender.innerHTML = ''
          showCalender = false
        })
      })
    }

    if (!input.value) {
      input.value = toDateString(Date.now())
    }

    input.addEventListener('click', () => {
      showCalender = true
      renderCalender(new Date(input.value))
    })

    calender.addEventListener('click', (e) => {
      e.stopPropagation()
    })
    document.addEventListener('click', () => {
      if (showCalender) {
        showCalender = false
        return
      }
      calender.classList.add('d-none')
      calender.innerHTML = ''
    })
  }

  function bsDateRange(id: string, callback: (startTs: number, endTs: number) => void, config?: DateRangeConfig) {
    const dateRange = document.getElementById(id) as HTMLElement | null
    if (!dateRange) {
      console.warn(`bsDateRange element not found: ${id}`)
      return
    }
    dateRange.classList.add('input-group', 'input-group-sm')
    let html = `<span class="input-group-text">从</span>
    <input id="${id}-start" class="form-control form-control-sm" type="text" placeholder=".form-control-sm" readonly>
    <div id="${id}-start-calender" class="calender text-center d-none"></div>
    <span class="input-group-text">到</span>
    <input id="${id}-end" class="form-control form-control-sm" type="text" placeholder=".form-control-sm" readonly>
    <div id="${id}-end-calender" class="calender text-center d-none"></div>
    <div class="dropdown">
      <button id="${id}-range" class="btn btn-sm btn-outline-info dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
        日期范围
      </button>
      <ul class="dropdown-menu">`

    const nextConfig = config || {}
    if (!nextConfig.ranges || nextConfig.ranges.length === 0) {
      nextConfig.ranges = [
        ['year2Now', '年初至今'],
        ['lastYear2Now', '去年至今'],
        ['d-7', '最近7天'],
        ['m-1', '最近1月'],
        ['m-3', '最近3月'],
        ['m-6', '最近6月'],
        ['y-1', '最近1年'],
        ['y-2', '最近2年'],
        ['y-3', '最近3年'],
        ['y-5', '最近5年'],
        ['y-7', '最近7年'],
        ['y-10', '最近10年'],
        ['y-15', '最近15年'],
        ['y-20', '最近20年'],
        ['y-25', '最近25年'],
        ['y-30', '最近30年'],
      ]
    }

    for (const range of nextConfig.ranges) {
      html += `<li><a class="range-item dropdown-item" data-range="${range[0]}" href="#">${range[1]}</a></li>`
    }
    html += '</ul></div>'
    dateRange.innerHTML = html
    const startInput = document.getElementById(`${id}-start`) as HTMLInputElement
    const endInput = document.getElementById(`${id}-end`) as HTMLInputElement
    const range = document.getElementById(`${id}-range`) as HTMLInputElement
    dateRange.querySelectorAll('.range-item').forEach((elem: any) => {
      elem.addEventListener('click', () => {
        range.textContent = elem.textContent
        rangeSelectChange(elem.dataset.range, elem.textContent)
      })
    })

    let rangeSelected = false
    const rangeSelectChange = (dv: string, text: string) => {
      const ed = new Date()
      let sd: Date
      if (dv === 'year2Now') {
        sd = new Date(ed.getFullYear(), 0, 1)
      } else if (dv === 'lastYear2Now') {
        sd = new Date(ed.getFullYear() - 1, 0, 1)
      } else if (dv === 'custom') {
        return
      } else {
        const arr = dv.split('-')
        const offset = parseInt(arr[1])
        switch (arr[0]) {
          case 'd':
            sd = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate() - offset)
            break
          case 'm':
            sd = new Date(ed.getFullYear(), ed.getMonth() - offset, ed.getDate())
            break
          case 'y':
            sd = new Date(ed.getFullYear() - offset, ed.getMonth(), ed.getDate())
            break
          default:
            console.log('wrong date format', arr[0])
            return
        }
      }

      startInput.value = toDateString(sd)
      endInput.value = toDateString(ed)
      range.textContent = text
      rangeSelected = true
      startInput.dispatchEvent(new Event('change'))
    }

    ;[startInput, endInput].forEach((input) => {
      bsInputCalenderInit(input)
      input.addEventListener('change', () => {
        let urlKey = 'from'
        if (input === endInput) {
          urlKey = 'to'
        }
        replaceUrlParam(urlKey, new Date(input.value).getTime().toString())
        if (!rangeSelected) {
          range.textContent = '自定义'
        } else {
          rangeSelected = false
        }
        callback(new Date(startInput.value).getTime(), new Date(endInput.value).getTime())
      })
    })

    const fromTs = parseDateRangeTs(getUrlParam('from'))
    if (fromTs) {
      const toTs = parseDateRangeTs(getUrlParam('to')) || Date.now()
      startInput.value = toDateString(fromTs)
      endInput.value = toDateString(toTs)
      range.textContent = '自定义'
      callback(fromTs, toTs)
      return
    }

    const rangeIdx = new Date().getMonth() < 7 ? 1 : 0
    rangeSelectChange(nextConfig.ranges[rangeIdx][0], nextConfig.ranges[rangeIdx][1])
  }

  function dateRangeInit() {
    bsDateRange('dateRange', renderLineChart)
  }

  return {
    changeDateRangeStart,
    dateRangeInit,
  }
}
