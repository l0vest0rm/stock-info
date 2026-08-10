# Generic local LLM dispatcher rollout

New generic tasks are claimed by `/api/llm-tasks/claim-next`, ordered by durable priority/FIFO sequence, and dispatched by `scripts/generic-llm-dispatcher.mjs`. The database provider ledger is the model concurrency gate (five slots); handler configuration is retained only for compatibility adapters and polling cadence.

Each task carries a `handler_key`. The registry maps the five producer families (company report discovery, information processing, Web Search packages, legacy operating analysis, and low-dependency operating analysis) to an adapter. An unknown key is terminally failed through the fenced generic run API so its provider lease is released and the error remains visible.

The old task-specific HTTP completion endpoints remain in place while existing runs drain. They are adapters, not a second queue: new background work must enter the generic task ledger and must not use a task-type-filtered claim. Low-dependency child-stage materialization remains a later phase; this rollout only schedules the parent task.

## Raw/model adapters

Request-bound extraction and the standalone `process-knowledge-once` and
`fund-quarterly-research` CLIs use the `generic_raw_model` handler. Its task
metadata contains only the provider-neutral model request (provider, model,
options, instructions, and input); credentials and request abort signals never
enter the durable row. The raw runner streams provider deltas into append-only
`partial` artifacts and writes one `complete` artifact before terminalizing the
run. `src/shared/llm-client.ts` and `scripts/lib/generic-llm-client.mjs` poll
that state, so a caller can reconnect and recover partial text without
cancelling queued/running work. Company-report SSE forwards those persisted
deltas as `delta` events while retaining its existing progress/partial/result
events. Priority defaults to 500 and is validated at the scheduler boundary;
the global provider lease is the only model concurrency cap.
