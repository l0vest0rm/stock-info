import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ValuationDashboard } from '../../../../../shared/valuation-dashboard'

/** Read/poll only on mount. A user nudge is bounded by the server; this page
 * neither enumerates tasks nor owns refresh completion. Closing it is safe. */
export function useValuationDashboard(api: (path: string, method?: string) => Promise<unknown>, signal: AbortSignal) {
  const screenMeta = ref<ValuationDashboard | null>(null)
  const screenLoading = ref(true)
  const screenError = ref('')
  let inFlight = false
  let timer: ReturnType<typeof setInterval> | undefined
  const screenRows = computed(() => new Map(screenMeta.value?.rows.map(r => [r.code.toUpperCase(), r]) ?? []))
  const refreshing = computed(() => screenMeta.value?.stale ?? false)
  const completed = computed(() => (screenMeta.value?.companies ?? 0) - (screenMeta.value?.pending.length ?? 0))
  const rowState = computed(() => Object.fromEntries((screenMeta.value?.targets ?? []).map(code =>
    [code, screenMeta.value?.pending.includes(code) ? '等待服务端更新 · 旧结果仅供参考' : '缓存有效'])))
  const refreshErrors = computed(() => screenMeta.value?.rows.filter(r =>
    r.blockReasons.some(reason => ['request_failed', 'quote_fetch_failed', 'financial_refresh_failed'].includes(reason))).length ?? 0)

  async function loadScreen(nudge = false) {
    if (inFlight || signal.aborted) return
    inFlight = true
    if (nudge) screenLoading.value = true
    try {
      const data = await api('/api/research/valuation-screen' + (nudge ? '/refresh' : ''), nudge ? 'POST' : 'GET') as ValuationDashboard
      if (data.schemaVersion !== 5 || !Array.isArray(data.pending)) throw new Error('估值接口版本不匹配，请刷新页面')
      screenMeta.value = data
      screenError.value = ''
    } catch (error) {
      if (!signal.aborted) screenError.value = error instanceof Error ? error.message : String(error)
    } finally { inFlight = false; screenLoading.value = false }
  }
  onMounted(() => { timer = setInterval(() => { void loadScreen() }, 15_000) })
  onBeforeUnmount(() => { clearInterval(timer) })
  return { screenMeta, screenRows, screenLoading, screenError, refreshing, completed, rowState, refreshErrors, loadScreen }
}
