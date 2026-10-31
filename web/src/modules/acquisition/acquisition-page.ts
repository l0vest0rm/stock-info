import { createApp, defineComponent, h, ref, onMounted, onUnmounted } from 'vue'
import type { AcquisitionStatus, AcquisitionTask, AcquisitionIntervalUpdate } from '../../../../shared/acquisition'

createApp(defineComponent({
  setup() {
const data = ref<AcquisitionStatus | null>(null)
const error = ref('')
const loading = ref(false)
const drafts = ref<Record<number, string>>({})
const saving = ref<Record<number, boolean>>({})
const saved = ref<Record<number, string>>({})
function minutes(task: AcquisitionTask): string {
  const match = /^(\d+)([smhd])$/.exec(task.interval || '30m')
  return match ? String(Number(match[1]) * ({ s: 1 / 60, m: 1, h: 60, d: 1440 }[match[2]] || 1)) : '30'
}
async function saveInterval(task: AcquisitionTask) {
  const value = Number(drafts.value[task.id] ?? minutes(task))
  if (!Number.isInteger(value) || value < 1 || value > 10080) {
    saved.value[task.id] = '请输入 1–10080 的整数分钟'; return
  }
  saving.value[task.id] = true
  saved.value[task.id] = ''
  try {
    const body: AcquisitionIntervalUpdate = { interval_minutes: value }
    const response = await fetch(`/api/local/acquisitions/${task.id}/interval`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    task.interval = `${value}m`
    saved.value[task.id] = '已保存；自动生效'
    await refresh()
  } catch (e) { saved.value[task.id] = `保存失败：${e instanceof Error ? e.message : '未知错误'}` }
  finally { saving.value[task.id] = false }
}
let timer: ReturnType<typeof setInterval> | undefined
const controller = new AbortController()
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
const labels: Record<string, string> = { active: '已启用', paused: '已暂停', disabled: '已禁用', success: '成功', failed: '失败', interrupted: '进度已保存，待续跑', running: '运行记录未结束' }
async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    const response = await fetch('/api/local/acquisitions', { cache: 'no-store', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (payload.code !== 200) throw new Error('状态接口返回错误')
    data.value = payload.data
    error.value = ''
  } catch (e) { if (!controller.signal.aborted) error.value = `读取失败，当前显示可能已过期：${e instanceof Error ? e.message : '未知错误'}` }
  finally { loading.value = false }
}
onMounted(() => { void refresh(); timer = setInterval(() => { if (!document.hidden) void refresh() }, 15000) })
onUnmounted(() => { clearInterval(timer); controller.abort() })
    const note = (text: string) => h('div', { class: 'small text-muted' }, text)
    const td = (children: ReturnType<typeof h> | string | number | (ReturnType<typeof h> | string)[]) => h('td', children)
    return () => h('section', [
      h('header', { class: 'd-flex justify-content-between align-items-center gap-3 mb-4' }, [
        h('div', [h('h1', { class: 'h3' }, '采集任务'), note('本机运行状态 · 时间为北京时间 · 每 15 秒只读刷新')]),
        h('button', { class: 'btn btn-outline-primary', disabled: loading.value, onClick: refresh }, loading.value ? '读取中…' : '刷新状态'),
      ]),
      error.value ? h('div', { role: 'alert', class: 'alert alert-danger' }, error.value) : null,
      data.value ? h('div', [
        h('div', { class: `alert ${data.value.scheduler_enabled ? 'alert-info' : 'alert-warning'}` }, [
          `定时采集${data.value.scheduler_enabled ? '已开启' : '已关闭（LOCAL_SCHEDULER=0）'} · ${data.value.tasks.length} 个任务 · 状态读取于 ${time(data.value.checked_at)}`,
          h('div', { class: 'small mt-1' }, '启用不等于采集正常；请看最后结果、最后成功时间及入库数量。修改周期会自动生效；默认 30 分钟。页面刷新不会触发采集、模型处理或发布。'),
        ]),
        !data.value.tasks.length ? h('p', { class: 'alert alert-secondary' }, '尚未注册采集任务。请使用本地 --acquisition put 配置任务及目标。') :
          h('div', { class: 'table-responsive border rounded bg-white' }, [h('table', { class: 'table table-hover align-middle mb-0' }, [
            h('thead', { class: 'table-light' }, [h('tr', ['任务 / 流程', '调度状态 / 周期', '最后结果', '最后开始', '最后结束', '最后成功', '入库', '问题'].map(v => h('th', v)))]),
            h('tbody', data.value.tasks.map(task => h('tr', { key: task.id }, [
              td([h('strong', task.name), note(`${task.flow || '未绑定流程'} · ${task.target_count} 个目标`)]),
              td([labels[task.status] || task.status, note(`当前 ${task.interval || '30m'}`),
                h('div', { class: 'd-flex gap-1 mt-1' }, [
                  h('input', { type: 'number', min: 1, max: 10080, step: 1, class: 'form-control form-control-sm', style: 'width:95px',
                    'aria-label': `${task.name} 采集间隔（分钟）`, value: drafts.value[task.id] ?? minutes(task),
                    onInput: (event: Event) => { drafts.value[task.id] = (event.target as HTMLInputElement).value; saved.value[task.id] = '' },
                  }),
                  h('button', { class: 'btn btn-sm btn-outline-primary', disabled: saving.value[task.id], onClick: () => saveInterval(task), 'aria-label': `保存 ${task.name} 间隔` }, saving.value[task.id] ? '保存中…' : '保存'),
                ]), note('分钟（默认 30）'),
                h('div', { role: 'status', class: 'small' }, saved.value[task.id] || ''),
                note(task.status !== 'active' ? '已暂停调度' : task.next_run_at ? `下次到期 ${time(task.next_run_at)}` : '首次执行待调度'),
              ]),
              td(h('span', { class: `badge ${task.latest_run?.status === 'success' ? 'bg-success' : task.latest_run?.status === 'failed' ? 'bg-danger' : 'bg-secondary'}` }, task.latest_run ? labels[task.latest_run.status] || task.latest_run.status : '尚未运行')),
              td(time(task.latest_run?.started_at ?? null)), td(time(task.latest_run?.finished_at ?? null)), td(time(task.last_success_at)),
              td([String(task.record_count), note(`本次新增 ${task.latest_run?.new_records ?? '—'}`)]),
              h('td', { class: 'small', style: 'min-width:180px;max-width:280px' }, task.target_count === 0 ? '未选择采集目标；不会执行' : task.latest_run?.issue || '—'),
            ]))),
          ])]),
        h('p', { class: 'small text-muted mt-3' }, '成功但新增为 0 可能是已去重，不代表有新资讯。未结束的运行记录可能来自中断，不能单独证明进程仍在工作。周期按上次尝试开始时间计算，重启不重置；到期任务受并发限制可能延后执行，错过多个周期仅补一轮。采集入库不代表已进入资讯流或完成事实核验。'),
      ]) : null,
    ])
  },
})).mount('#acquisition-root')
