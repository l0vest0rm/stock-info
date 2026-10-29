import { defineComponent, h, ref, watch, onBeforeUnmount, type PropType } from 'vue'

type FeedItem = { doc_id: string; title: string; url: string | null; source_name: string | null; published_at: string | null;
  tagging_status: string; records: Array<{ entity: string; entity_key: string | null; statement: string; informationType: string; period: string | null }> }
/** Read the existing evidence pipeline; never schedule extraction or infer trading actions from headlines. */
export const ObservationInformationPanel = defineComponent({
  props: { codes: { type: Array as PropType<string[]>, required: true } },
  setup(props) {
    const items = ref<FeedItem[]>([]), busy = ref(false), error = ref(''), readAt = ref(''), hasNext = ref(false)
    let controller: AbortController | undefined
    async function load() {
      controller?.abort(); const active = new AbortController(); controller = active
      busy.value = true; error.value = ''; items.value = []; readAt.value = ''
      try {
        const query = new URLSearchParams({ company: props.codes.join(','), limit: '10' })
        const response = await fetch('/api/knowledge/feed?' + query, { cache: 'no-store', signal: AbortSignal.any([active.signal, AbortSignal.timeout(30000)]) })
        const body = await response.json()
        if (!response.ok || body.code !== 200 || !Array.isArray(body.data?.list)) throw new Error(body.msg || '资料读取失败')
        if (active.signal.aborted) return
        items.value = body.data.list; hasNext.value = body.data.has_next; readAt.value = new Date().toLocaleString()
      } catch (e) { if (!active.signal.aborted) error.value = e instanceof Error ? e.message : String(e) }
      finally { if (!active.signal.aborted) busy.value = false }
    }
    watch(() => props.codes.join(','), load, { immediate: true }); onBeforeUnmount(() => controller?.abort())
    function source(url: string | null) { try { const parsed = new URL(url ?? ''); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null } catch { return null } }
    return () => h('section', { class: 'ivu-focus-policy', 'aria-label': '动态资料与论点核验' }, [
      h('h3', '动态资料 → 核验事实 → 更新论点'),
      h('p', '读取现有资讯管线中已关联本公司的资料，不是每天重抓全部来源。新闻/公告提供待核实事实，机构观点和预测不等于已实现业绩；请将关键来源和反证填入下方研究论点。'),
      h('button', { type: 'button', class: 'ivu-open', disabled: busy.value, onClick: load }, busy.value ? '正在读取资料…' : '刷新已入库资料'),
      readAt.value ? h('p', `读取时间：${readAt.value}。读取时间不是来源发布日期，也不证明全市场覆盖完整。`) : null,
      error.value ? h('p', { role: 'alert' }, '资料读取失败：' + error.value) : null,
      !busy.value && !error.value && !items.value.length ? h('p', '当前未找到按实体标签关联的入库资料；不代表公司没有新闻。未处理、未关联或未覆盖来源仍是监测缺口。') : null,
      ...items.value.map(item => h('article', { key: item.doc_id }, [
        h('h4', source(item.url) ? h('a', { href: source(item.url)!, target: '_blank', rel: 'noopener noreferrer' }, item.title) : item.title),
        h('p', `${item.source_name ?? '来源待核对'} · 发布 ${item.published_at ?? '时间未知'} · 处理状态 ${item.tagging_status}（处理完成不等于事实核验）`),
        ...item.records.filter(r => props.codes.some(code => r.entity_key === 'company:' + code)).map(r => h('p', `来源提取（待核验） · ${r.entity} · ${r.informationType} · ${r.period ?? '期间未标明'}：${r.statement}`)),
      ])),
      hasNext.value ? h('p', '这里只展示最近10条关联资料，不代表完整事件历史。') : null,
    ])
  },
})
