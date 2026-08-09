# Investment-analysis LLM task unification - delivery checklist

Source plan: `docs/investment-analysis-llm-task-unification-plan.md`.

## Completion criteria

- A generic local LLM task/run/artifact ledger owns task identity, lease, attempts,
  provider slots, terminal state and recovery for every local LLM consumer.
- Investment-analysis and Web Search retain only their business projections; no
  per-table job lifecycle adapter, import bridge or double-write remains.
- Intermediate stream text is never persisted. Terminal artifacts, run history,
  explicit failure/cancellation evidence and recoverable lease state remain
  durable.
- Forecast consensus remains an externally sourced Web Search supplement; the
  internal forecast ledger remains business-owned.
- Local-only LLM execution remains gated by `LLM_RUNTIME=local`; production
  behavior remains unchanged.

## Delivery tracker

| ID | Deliverable | Status | Evidence / affected owners |
| --- | --- | --- | --- |
| T01 | Add a forward migration for generic task, run and terminal-artifact ledgers with attempt/lease fencing and provider slots. | Complete | `0107_generic_llm_task_protocol.sql`; schema opened in a temporary SQLite database. No destructive cleanup occurred. |
| T02 | Generalize the local task protocol and runtime reconciliation, heartbeat and requeue behavior. | Complete | Generic typed lifecycle, progress metadata, terminal artifacts and targeted stale-run requeue; stale-owner and cross-task isolation tests pass. |
| T03 | Migrate information-processing to the generic ledger while retaining its business projection. | Complete | Knowledge application/API/runner use generic task/run/artifact records; business-run fencing and a generic read endpoint added. |
| T04 | Migrate Web Search packages to the generic ledger while retaining package/evidence projections and external `forecast_consensus`. | Complete | Generic lifecycle plus package/source/evidence projections; duplicate, retry, terminal-failure and stale-lease D1 checks pass. |
| T05 | Migrate operating-analysis stages to the generic ledger and terminal artifacts/run history. | Complete | Generic lifecycle/progress and terminal report artifacts; projection keeps generic run ID and prior run history. |
| T06 | Remove periodic stage checkpoint persistence and the corresponding endpoint/config/UI rendering. | Complete | Checkpoint route/config/runner writes and saved intermediate-body UI removed; status, stage and elapsed display retained. |
| T07 | Keep local runtime startup, worker supervision, recovery/cleanup and operational audit aligned with the generic ledger. | Complete | Audit inventory and scoped expired-Web-Search recovery are generic-task aware; worker/supervisor need no process-model change. |
| T08 | Add or update focused tests for duplicate enqueue, lease expiry/restart, terminal projection, failure and no intermediate persistence. | Complete | Research suite: 254 tests plus 3 stage-plan tests; information-processing suite: 8 tests; focused D1 lifecycle checks pass. |
| T09 | Run one unified static, build, migration/runtime, API and page-smoke validation pass; record exact results. | Blocked by pre-existing local data and concurrent edits | See validation record: static/research checks pass; investment read-model fixture and unrelated company-route type errors prevent the remaining steps. |
| T10 | Review the final diff, mark every item complete only with evidence, and document any intentionally deferred destructive cleanup. | Complete | No rows were deleted or rebuilt. Restoring the missing local read-model fixture requires explicit authorization. |

## Validation record

Completed before the first blocker:

- `git diff --check` — pass.
- `npm run typecheck` — pass before a separate concurrent edit introduced two
  missing generated-prompt exports in `src/modules/company/api/company.routes.ts`.
- `npm run test:research` — pass: 254 tests plus 3 operating stage-plan tests.
- `npm run test:investment-analysis` — the page-shell check passed after the
  existing `打开 ChatGPT 会话` entry contract was restored, then stopped because
  `300308.SZ` has no stored filing facts in the local read model.

Local evidence shows the service is healthy, but all relevant auto-filing tables
are empty and the local migration ledger currently ends at `0106`; migration `0107`
does not delete or alter those tables. This is a pre-existing fixture/data
precondition, not a regression from the generic task migration. Per the source
plan, local-row cleanup/rebuild requires backup and explicit confirmation, so no
data mutation was performed. The remaining unified checks (`test:investment-analysis-cli`,
`build:local`, standard startup/health, and page smoke) must be rerun after that
fixture is restored and the unrelated generated-prompt exports are reconciled.

Production migration/deploy remains out of scope until separately authorized; this
task changes and proves only the local Node runtime.
