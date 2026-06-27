type ThirteenFFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type ThirteenFRuntimeContext = {
  server: string
  fetchRequest: ThirteenFFetchRequest
}

export function createThirteenFInitializer(context: ThirteenFRuntimeContext) {
  const { server, fetchRequest } = context

  function emitThirteenFState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:13f-state', { detail: patch || {} }))
  }

  function setThirteenFStatus(message: string): void {
    emitThirteenFState({ status: message })
  }

  function init13f() {
    setThirteenFStatus('加载中...')
    void fetchRequest({
      url: `${server}/api/13f/manager/list`,
      cacheKey: '13f-manager-list',
      cacheTtl: 360000
    }).then((data: any) => {
      const rows = Array.isArray(data)
        ? data.map((row: any) => ({
          id: String(row?.[0] || ''),
          englishName: String(row?.[1] || ''),
          chineseName: String(row?.[2] || ''),
          scale: String(row?.[3] || ''),
        }))
        : []
      emitThirteenFState({
        rows,
        status: `已加载 ${rows.length} 家机构`,
      })
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '加载 13F 机构列表失败'
      setThirteenFStatus(message)
    })
  }

  return init13f
}
