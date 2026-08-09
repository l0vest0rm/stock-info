function runId() {
  return String(process.env.LOCAL_SUPERVISOR_RUN_ID || `standalone-${process.pid}`);
}

export function localRuntimeLog(role, event, details = {}) {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    role,
    pid: process.pid,
    run_id: runId(),
    job_id: null,
    attempt: null,
    duration_ms: null,
    error: null,
    ...details,
    event,
  })}\n`);
}

export function localRuntimeError(role, event, error, details = {}) {
  localRuntimeLog(role, event, {
    ...details,
    error: error instanceof Error ? error.message : String(error),
  });
}
