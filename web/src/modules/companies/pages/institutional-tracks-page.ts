import { computed, createApp, defineComponent, h, onMounted, ref } from 'vue'
import trackOverridesConfig from '../../../config/institutional-track-overrides.json'
import trackRulesConfig from '../../../config/institutional-track-rules.json'
import trackSnapshotConfig from '../../../config/institutional-track-snapshot.json'

type TrackRule = {
  primaryTrack: string
  secondaryTrack: string
  keywords?: string[]
  industries?: string[]
}

type StockSource = {
  SECUCODE: string
  SECURITY_NAME_ABBR: string
  ALLCORP_NUM: number
  INDUSTRY?: string
  BOARD_NAME?: string
  CONCEPT?: string[]
  MAX_TRADE_DATE?: string
}

type TrackOverride = {
  primaryTrack?: string
  secondaryTrack?: string
  note?: string
}

type TrackRow = {
  rank: number
  code: string
  name: string
  institutionCount: number
  industry: string
  concepts: string[]
  primaryTrack: string
  secondaryTrack: string
  note: string
  ruleLabel: string
  tradeDate: string
}

const STORAGE_KEY = 'institutional-track-overrides-v1'
const rules = trackRulesConfig as TrackRule[]
const bundledOverrides = trackOverridesConfig as Record<string, TrackOverride>
const snapshot = trackSnapshotConfig as {
  dataDate: string
  rows: Array<{ rank: number, code: string, name: string, institutionCount: number, industry: string, concepts: string[] }>
}

function includesAny(haystack: string, needles: string[] | undefined): boolean {
  return Boolean(needles?.some((needle) => haystack.includes(needle)))
}

function deriveTrack(stock: StockSource): Pick<TrackRow, 'primaryTrack' | 'secondaryTrack' | 'note' | 'ruleLabel'> {
  const industry = String(stock.INDUSTRY || stock.BOARD_NAME || '未分类')
  const concepts = Array.isArray(stock.CONCEPT) ? stock.CONCEPT.map(String) : []
  const searchable = [stock.SECURITY_NAME_ABBR, industry, ...concepts].join('|')
  const rule = rules.find((item) => (
    includesAny(industry, item.industries) || includesAny(searchable, item.keywords)
  ))
  if (!rule) {
    return {
      primaryTrack: '其他',
      secondaryTrack: industry,
      note: `以东财行业“${industry}”暂归其他，建议人工复核。`,
      ruleLabel: '行业兜底',
    }
  }
  const ruleLabel = rule.keywords?.find((keyword) => searchable.includes(keyword))
    || rule.industries?.find((keyword) => industry.includes(keyword))
    || industry
  return {
    primaryTrack: rule.primaryTrack,
    secondaryTrack: rule.secondaryTrack,
    note: `东财行业“${industry}”，因“${ruleLabel}”归入该赛道。`,
    ruleLabel,
  }
}

function loadLocalOverrides(): Record<string, TrackOverride> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeOverrides(value: unknown): Record<string, TrackOverride> {
  const candidate = value && typeof value === 'object' && 'overrides' in value
    ? (value as { overrides?: unknown }).overrides
    : value
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('JSON 必须是以股票代码为键的对象，或包含 overrides 对象')
  }
  const normalized: Record<string, TrackOverride> = {}
  for (const [code, raw] of Object.entries(candidate)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }
    const item = raw as TrackOverride
    normalized[code] = {
      primaryTrack: String(item.primaryTrack || '').trim(),
      secondaryTrack: String(item.secondaryTrack || '').trim(),
      note: String(item.note || '').trim(),
    }
  }
  return normalized
}

const pageStyle = `
.institutional-tracks-page { color: #23313f; }
.institutional-tracks-hero { background: linear-gradient(135deg, #0b3b2e, #155e75); border-radius: 1rem; color: #fff; padding: 1.4rem; }
.institutional-tracks-hero p { color: rgba(255,255,255,.78); }
.institutional-tracks-summary { display: flex; flex-wrap: wrap; gap: .45rem; }
.institutional-tracks-summary button { border: 1px solid #c9d7df; border-radius: 999px; background: #fff; color: #334155; padding: .3rem .7rem; }
.institutional-tracks-summary button.active { background: #0f766e; border-color: #0f766e; color: #fff; }
.institutional-tracks-table { font-size: .86rem; min-width: 1280px; }
.institutional-tracks-table th { white-space: nowrap; }
.institutional-tracks-table input { border: 1px solid transparent; border-radius: .3rem; min-width: 9rem; padding: .25rem .35rem; width: 100%; }
.institutional-tracks-table input:focus { border-color: #0d9488; box-shadow: 0 0 0 .15rem rgba(13,148,136,.14); outline: none; }
.institutional-tracks-concepts { color: #64748b; max-width: 25rem; }
.institutional-tracks-sticky { position: sticky; left: 0; z-index: 1; background: #fff; }
`

const InstitutionalTracksPage = defineComponent({
  name: 'InstitutionalTracksPage',
  setup() {
    const rows = ref<TrackRow[]>([])
    const loading = ref(true)
    const error = ref('')
    const query = ref('')
    const primaryFilter = ref('')
    const secondaryFilter = ref('')
    const overrides = ref<Record<string, TrackOverride>>({ ...bundledOverrides, ...loadLocalOverrides() })
    const fileInput = ref<HTMLInputElement | null>(null)

    const persistOverrides = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides.value))

    const visibleRows = computed(() => {
      const keyword = query.value.trim().toLowerCase()
      return rows.value.filter((row) => {
        if (primaryFilter.value && row.primaryTrack !== primaryFilter.value) return false
        if (secondaryFilter.value && row.secondaryTrack !== secondaryFilter.value) return false
        if (!keyword) return true
        return [row.code, row.name, row.industry, row.primaryTrack, row.secondaryTrack, row.note, ...row.concepts]
          .join('|').toLowerCase().includes(keyword)
      })
    })

    const primaryCounts = computed(() => {
      const countMap = new Map<string, number>()
      rows.value.forEach((row) => countMap.set(row.primaryTrack, (countMap.get(row.primaryTrack) || 0) + 1))
      return [...countMap.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    })

    const secondaryOptions = computed(() => {
      const values = rows.value
        .filter((row) => !primaryFilter.value || row.primaryTrack === primaryFilter.value)
        .map((row) => row.secondaryTrack)
        .filter(Boolean)
      return [...new Set(values)].sort((left, right) => left.localeCompare(right))
    })

    function selectPrimary(track: string) {
      primaryFilter.value = track
      if (secondaryFilter.value && !secondaryOptions.value.includes(secondaryFilter.value)) {
        secondaryFilter.value = ''
      }
    }

    function applyOverride(row: TrackRow, key: keyof TrackOverride, value: string) {
      row[key] = value
      overrides.value[row.code] = { ...(overrides.value[row.code] || {}), [key]: value }
      overrides.value = { ...overrides.value }
      persistOverrides()
    }

    function applyOverridesToRows() {
      rows.value.forEach((row) => {
        const item = overrides.value[row.code]
        if (!item) return
        if (item.primaryTrack) row.primaryTrack = item.primaryTrack
        if (item.secondaryTrack) row.secondaryTrack = item.secondaryTrack
        if (item.note) row.note = item.note
      })
    }

    function loadRows() {
      loading.value = true
      error.value = ''
      try {
        const list: StockSource[] = snapshot.rows.map((item) => ({
          SECUCODE: item.code,
          SECURITY_NAME_ABBR: item.name,
          ALLCORP_NUM: item.institutionCount,
          INDUSTRY: item.industry,
          CONCEPT: item.concepts,
          MAX_TRADE_DATE: snapshot.dataDate,
        }))
        if (list.length !== 300) throw new Error(`快照应为 300 只，实际 ${list.length} 只`)
        if (list.some((item, index) => index > 0 && Number(item.ALLCORP_NUM) > Number(list[index - 1].ALLCORP_NUM))) {
          throw new Error('快照未按机构持股家数降序排列')
        }
        rows.value = list.map((stock, index) => {
          const derived = deriveTrack(stock)
          return {
            rank: index + 1,
            code: String(stock.SECUCODE),
            name: String(stock.SECURITY_NAME_ABBR || ''),
            institutionCount: Number(stock.ALLCORP_NUM || 0),
            industry: String(stock.INDUSTRY || stock.BOARD_NAME || '未分类'),
            concepts: Array.isArray(stock.CONCEPT) ? stock.CONCEPT.map(String) : [],
            tradeDate: String(stock.MAX_TRADE_DATE || ''),
            ...derived,
          }
        })
        applyOverridesToRows()
      } catch (caught) {
        error.value = caught instanceof Error ? caught.message : String(caught)
      } finally {
        loading.value = false
      }
    }

    function exportOverrides() {
      const content = JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        dataDate: rows.value[0]?.tradeDate || '',
        overrides: overrides.value,
      }, null, 2)
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
      anchor.download = `institutional-track-overrides-${rows.value[0]?.tradeDate || 'latest'}.json`
      anchor.click()
      URL.revokeObjectURL(anchor.href)
    }

    async function importOverrides(event: Event) {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        overrides.value = normalizeOverrides(JSON.parse(await file.text()))
        persistOverrides()
        loadRows()
      } catch (caught) {
        error.value = `导入失败：${caught instanceof Error ? caught.message : String(caught)}`
      } finally {
        if (fileInput.value) fileInput.value.value = ''
      }
    }

    function resetOverrides() {
      if (!window.confirm('确认清除浏览器中的全部赛道修改并恢复规则分析？')) return
      overrides.value = { ...bundledOverrides }
      persistOverrides()
      loadRows()
    }

    onMounted(loadRows)

    return () => h('div', { class: 'container-fluid my-3 institutional-tracks-page' }, [
      h('style', pageStyle),
      h('section', { class: 'institutional-tracks-hero mb-3' }, [
        h('div', { class: 'd-flex flex-wrap justify-content-between gap-3 align-items-end' }, [
          h('div', [
            h('h1', { class: 'h3 mb-2' }, '机构持股 Top300 赛道分析'),
            h('p', { class: 'mb-0' }, `按 ALLCORP_NUM 降序；榜单日期 ${rows.value[0]?.tradeDate || '加载中'}。赛道由行业与概念规则初判，支持逐项人工修订。`),
          ]),
          h('div', { class: 'd-flex flex-wrap gap-2' }, [
            h('button', { class: 'btn btn-light btn-sm', onClick: exportOverrides, disabled: !rows.value.length }, '导出修改 JSON'),
            h('button', { class: 'btn btn-outline-light btn-sm', onClick: () => fileInput.value?.click() }, '导入 JSON'),
            h('button', { class: 'btn btn-outline-light btn-sm', onClick: resetOverrides }, '恢复规则分析'),
            h('input', { ref: fileInput, type: 'file', accept: 'application/json,.json', class: 'd-none', onChange: importOverrides }),
          ]),
        ]),
      ]),
      error.value ? h('div', { class: 'alert alert-danger' }, error.value) : null,
      h('div', { class: 'row g-2 mb-3 align-items-center' }, [
        h('div', { class: 'col-12 col-lg-4' }, [
          h('input', {
            class: 'form-control form-control-sm',
            value: query.value,
            placeholder: '搜索股票、行业、概念或赛道',
            onInput: (event: Event) => { query.value = (event.target as HTMLInputElement).value },
          }),
        ]),
        h('div', { class: 'col-12 col-lg-4' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: primaryFilter.value,
            onChange: (event: Event) => selectPrimary((event.target as HTMLSelectElement).value),
          }, [
            h('option', { value: '' }, `全部一级赛道（${rows.value.length}）`),
            ...primaryCounts.value.map(([track, count]) => h('option', { value: track }, `${track}（${count}）`)),
          ]),
        ]),
        h('div', { class: 'col-12 col-lg-4' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: secondaryFilter.value,
            onChange: (event: Event) => { secondaryFilter.value = (event.target as HTMLSelectElement).value },
          }, [
            h('option', { value: '' }, '全部二级赛道'),
            ...secondaryOptions.value.map((track) => h('option', { value: track }, track)),
          ]),
        ]),
      ]),
      loading.value
        ? h('div', { class: 'text-center text-muted py-5' }, '正在加载 Top300 并匹配赛道…')
        : h('div', { class: 'table-responsive border rounded' }, [
          h('table', { class: 'table table-sm table-hover align-middle mb-0 institutional-tracks-table' }, [
            h('thead', { class: 'table-light' }, [h('tr', [
              h('th', '排名'), h('th', '股票'), h('th', '机构家数'), h('th', '东财行业'), h('th', '概念证据'),
              h('th', '一级赛道（可编辑）'), h('th', '二级赛道（可编辑）'), h('th', '逐股分析（可编辑）'),
            ])]),
            h('tbody', visibleRows.value.map((row) => h('tr', { key: row.code }, [
              h('td', row.rank),
              h('td', { class: 'institutional-tracks-sticky' }, [
                h('a', { href: `company.html?code=${encodeURIComponent(row.code)}`, target: '_blank' }, row.name),
                h('div', { class: 'text-muted small' }, row.code),
              ]),
              h('td', { class: 'fw-semibold' }, row.institutionCount.toLocaleString()),
              h('td', row.industry),
              h('td', { class: 'institutional-tracks-concepts' }, row.concepts.join('、') || '—'),
              h('td', [h('input', {
                value: row.primaryTrack,
                title: `初始匹配：${row.ruleLabel}`,
                onChange: (event: Event) => applyOverride(row, 'primaryTrack', (event.target as HTMLInputElement).value.trim()),
              })]),
              h('td', [h('input', {
                value: row.secondaryTrack,
                onChange: (event: Event) => applyOverride(row, 'secondaryTrack', (event.target as HTMLInputElement).value.trim()),
              })]),
              h('td', [h('input', {
                value: row.note,
                style: 'min-width: 22rem;',
                onChange: (event: Event) => applyOverride(row, 'note', (event.target as HTMLInputElement).value.trim()),
              })]),
            ]))),
          ]),
        ]),
      h('p', { class: 'small text-muted mt-2' }, `当前显示 ${visibleRows.value.length} / ${rows.value.length}。同机构家数的边界股票按东财原始返回顺序截取；赛道归类是研究标签，不构成投资建议。`),
    ])
  },
})

const root = document.getElementById('institutional-tracks-vue-root')
if (root) createApp(InstitutionalTracksPage).mount(root)
