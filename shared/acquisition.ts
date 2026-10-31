/** Native local acquisition status. No sessions or raw provider errors. */
export interface AcquisitionTask {
  id: number
  name: string
  status: 'active' | 'paused' | 'disabled'
  flow: string | null
  interval: string | null
  target_count: number
  record_count: number
  next_run_at: string | null
  last_run_at: string | null
  last_success_at: string | null
  latest_run: {
    status: string
    started_at: string | null
    finished_at: string | null
    issue: string | null
    new_records: number | null
  } | null
}
export interface AcquisitionStatus {
  checked_at: string
  scheduler_enabled: boolean
  tasks: AcquisitionTask[]
}

/** PUT /api/local/acquisitions/:id/interval; integer minutes, 1..10080. */
export interface AcquisitionIntervalUpdate { interval_minutes: number }
