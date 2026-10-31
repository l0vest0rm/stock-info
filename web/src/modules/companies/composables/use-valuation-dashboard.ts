import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ValuationDashboard } from '../../../../../shared/valuation-dashboard'

/** Foreground, one bounded batch per open or explicit click; no polling. */
export function useValuationDashboard(api: (path: string, method?: string) => Promise<unknown>, signal: AbortSignal) {
  const screenMeta = ref<ValuationDashboard | null>(null)
  const screenLoading = ref(false)
  const screenError = ref('')
  let inFlight = false
  let opened = false
  const screenRows = computed(() => new Map(screenMeta.value?.rows.map(r => [r.code.toUpperCase(), r]) ?? []))
  const refreshing = computed(() => screenMeta.value?.stale ?? false)
  const completed = computed(() => (screenMeta.value?.companies ?? 0) - (screenMeta.value?.pending.length ?? 0))
  const rowState = computed(() => Object.fromEntries((screenMeta.value?.targets ?? []).map(code =>
    [code, screenMeta.value?.pending.includes(code) ? '待按需更新 · 旧结果仅供参考' : '缓存有效'])))
  const refreshErrors = computed(() => screenMeta.value?.rows.filter(r =>
    r.blockReasons.some(reason => ['request_failed', 'quote_fetch_failed', 'financial_refresh_failed'].includes(reason))).length ?? 0)

  async function loadScreen(nudge = false) {
    if (inFlight || signal.aborted || document.visibilityState !== 'visible') return
    opened = true
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
  const firstVisibleOpen = () => { if (!opened) void loadScreen(true) }
  onMounted(() => { document.addEventListener('visibilitychange', firstVisibleOpen) })
  onBeforeUnmount(() => { document.removeEventListener('visibilitychange', firstVisibleOpen) })
  return { screenMeta, screenRows, screenLoading, screenError, refreshing, completed, rowState, refreshErrors, loadScreen }
}
