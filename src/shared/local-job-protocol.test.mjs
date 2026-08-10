import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalD1Database } from "../../data/local/runtime/bindings.mjs";
import {
  claimNextGenericLlmQueueTaskRun,
  completeGenericLlmRun,
  compareGenericLlmQueueOrder,
  createGenericLlmTask,
  evaluateGenericLlmDependencies,
  genericArtifactCompatibilityMatches,
  normalizeGenericLlmExecutionMode,
  normalizeGenericLlmPriority,
  normalizeGenericLlmIdArray,
  reserveGenericEngineeringSlot,
  writeGenericLlmRunArtifact,
} from "./local-job-protocol.ts";

test("generic artifact lineage IDs default safely when omitted", () => {
  assert.deepEqual(normalizeGenericLlmIdArray(undefined, "sourceIds"), []);
  assert.deepEqual(normalizeGenericLlmIdArray(["source:b", "source:a"], "sourceIds"), ["source:b", "source:a"]);
});

test("generic artifact lineage IDs reject empty, positional and duplicate values", () => {
  assert.throws(() => normalizeGenericLlmIdArray([""], "sourceIds"), /invalid ID/);
  assert.throws(() => normalizeGenericLlmIdArray(["3"], "sourceIds"), /invalid ID/);
  assert.throws(() => normalizeGenericLlmIdArray(["source:a", "source:a"], "sourceIds"), /duplicate ID/);
  assert.throws(() => normalizeGenericLlmIdArray(["source a"], "sourceIds"), /invalid ID/);
});

test("recovery reuses only exact compatible terminal artifacts", () => {
  const expected = { stageVersion: "company-facts.v1", inputFingerprint: "fp:new", upstreamArtifactIds: ["llm-artifact:s0"], projectionVersion: "research-artifact-projection.v1" };
  const complete = { status: "complete", ...expected };
  assert.equal(genericArtifactCompatibilityMatches(complete, expected), true);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, status: "failed" }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, inputFingerprint: "fp:changed" }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, upstreamArtifactIds: ["llm-artifact:other"] }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, projectionVersion: "legacy" }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, status: "not_applicable" }, expected), true);
});

test("generic scheduler validates priority and defaults execution mode", () => {
  assert.equal(normalizeGenericLlmPriority(undefined), 500);
  assert.equal(normalizeGenericLlmPriority(0), 0);
  assert.equal(normalizeGenericLlmPriority(1000), 1000);
  assert.throws(() => normalizeGenericLlmPriority(-1), /0 to 1000/);
  assert.throws(() => normalizeGenericLlmPriority(1001), /0 to 1000/);
  assert.throws(() => normalizeGenericLlmPriority(1.5), /integer/);
  assert.equal(normalizeGenericLlmExecutionMode(undefined), "model");
  assert.equal(normalizeGenericLlmExecutionMode("engineering"), "engineering");
  assert.throws(() => normalizeGenericLlmExecutionMode("remote"), /model or engineering/);
});

test("generic scheduler orders higher priority first and equal priorities FIFO", () => {
  const first = { taskId: "llm-task:1", priority: 500, queueSequence: 12, createdAt: 2 };
  const earlierPriority = { taskId: "llm-task:2", priority: 700, queueSequence: 99, createdAt: 1 };
  const laterFifo = { taskId: "llm-task:3", priority: 500, queueSequence: 13, createdAt: 1 };
  assert.ok(compareGenericLlmQueueOrder(earlierPriority, first) < 0);
  assert.ok(compareGenericLlmQueueOrder(first, laterFifo) < 0);
});

test("generic scheduler dependency evaluation distinguishes ready, waiting, and blocked", () => {
  assert.equal(evaluateGenericLlmDependencies([]).state, "ready");
  assert.deepEqual(evaluateGenericLlmDependencies([{ dependsOnTaskId: "a", status: "running" }]), {
    state: "waiting", pendingTaskIds: ["a"], failedTaskIds: [], dependencyTaskIds: ["a"],
  });
  assert.deepEqual(evaluateGenericLlmDependencies([
    { dependsOnTaskId: "a", status: "completed" },
    { dependsOnTaskId: "b", status: "blocked" },
  ]), {
    state: "blocked", pendingTaskIds: [], failedTaskIds: ["b"], dependencyTaskIds: ["a", "b"],
  });
});

test("engineering reservation is a provider-ledger no-op", async () => {
  assert.equal(await reserveGenericEngineeringSlot(), true);
});

test("engineering artifact writes execute against the migrated SQLite schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stock-info-generic-artifact-"));
  try {
    const db = new LocalD1Database(join(dir, "fixture.sqlite"));
    await db.exec(`
      create table local_job_provider_slots (
        provider_id text primary key,
        active_count integer not null default 0,
        concurrency_limit integer not null,
        updated_at integer not null
      );
      insert into local_job_provider_slots (provider_id, active_count, concurrency_limit, updated_at)
        values ('openai', 0, 5, 0);
      create table local_job_provider_leases (
        provider_id text not null,
        job_id text not null,
        job_type text not null,
        attempt integer not null,
        lease_owner text not null,
        acquired_at integer not null,
        primary key (provider_id, job_id, attempt),
        unique (job_id, attempt)
      );
      create table research_web_search_package_jobs (
        job_id text, job_type text, status text, attempt integer, lease_owner text, lease_until integer
      );
      create table research_operating_analysis_jobs (
        job_id text, job_type text, status text, attempt integer, lease_owner text, lease_until integer
      );
      create table information_processing_jobs (
        job_id text, job_type text, status text, attempt integer, lease_owner text, lease_until integer
      );
    `);
    for (const filename of [
      "0107_generic_llm_task_protocol.sql",
      "0108_research_operating_analysis_artifact_contract.sql",
      "0110_generic_llm_scheduler_foundation.sql",
    ]) {
      await db.exec(await readFile(join(process.cwd(), "migrations", filename), "utf8"));
    }

    const now = Date.now();
    const created = await createGenericLlmTask(db, {
      taskId: "llm-task:generic-artifact-engineering",
      taskType: "fixture_engineering",
      targetType: "fixture",
      targetId: "generic-artifact-engineering",
      idempotencyKey: "generic-artifact-engineering",
      promptVersion: "fixture.v1",
      handlerKey: "fixture_engineering",
      executionMode: "engineering",
      model: "engineering",
      now,
    });
    assert.equal(created.created, true);
    const claim = await claimNextGenericLlmQueueTaskRun(db, "fixture-engineering-runner", { now: now + 1 });
    assert.ok(claim);
    const artifact = await writeGenericLlmRunArtifact(db, {
      runId: claim.run.runId,
      taskId: claim.task.taskId,
      attempt: claim.run.attempt,
      leaseOwner: claim.run.leaseOwner,
      stepKey: "engineering_baseline",
      stageVersion: "engineering-baseline.v1",
      inputFingerprint: "fixture:fingerprint",
      outputType: "json",
      status: "complete",
      output: { status: "complete", schemaVersion: "engineering-baseline.v1" },
      projectionVersion: "research-artifact-projection.v1",
      completedAt: now + 2,
    });
    assert.equal(artifact.status, "complete");
    assert.equal(artifact.stepKey, "engineering_baseline");
    const row = await db.prepare("select count(*) as count, output_type as outputType, status from llm_run_artifacts where run_id=? and step_key=?")
      .bind(claim.run.runId, "engineering_baseline").first();
    assert.deepEqual({ count: Number(row.count), outputType: row.outputType, status: row.status }, { count: 1, outputType: "json", status: "complete" });
    const completed = await completeGenericLlmRun(db, {
      runId: claim.run.runId,
      taskId: claim.task.taskId,
      attempt: claim.run.attempt,
      leaseOwner: claim.run.leaseOwner,
      status: "completed",
      completedAt: now + 3,
    });
    assert.equal(completed.task.status, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact recovery migration preserves stable IDs through run links", async () => {
  const migration = await readFile(new URL("../../migrations/0108_research_operating_analysis_artifact_contract.sql", import.meta.url), "utf8");
  assert.match(migration, /alter table llm_runs add column lineage_run_id/);
  assert.match(migration, /create table if not exists llm_run_artifact_links/);
  assert.match(migration, /primary key \(run_id, step_key\)/);
  assert.match(migration, /foreign key \(artifact_id\) references llm_run_artifacts/);
});

test("generic scheduler migration defines ordered modes, dependency edges, and workflow links", async () => {
  const migration = await readFile(new URL("../../migrations/0110_generic_llm_scheduler_foundation.sql", import.meta.url), "utf8");
  assert.match(migration, /add column priority integer not null default 500/);
  assert.match(migration, /add column queue_sequence integer not null default 0/);
  assert.match(migration, /add column execution_mode text not null default 'model'/);
  assert.match(migration, /update llm_tasks\s+set ready_at=created_at/);
  assert.match(migration, /create unique index if not exists idx_llm_tasks_queue_sequence/);
  assert.match(migration, /create table if not exists llm_task_dependencies/);
  assert.match(migration, /required_status text not null default 'completed'/);
  assert.match(migration, /create table if not exists llm_workflow_artifact_links/);
  assert.match(migration, /foreign key \(child_task_id\) references llm_tasks/);
});

test("global dispatcher is the only new model claim path and uses the shared cap", async () => {
  const protocol = await readFile(new URL("./local-job-protocol.ts", import.meta.url), "utf8");
  assert.match(protocol, /export async function claimNextGenericLlmTaskRun/);
  assert.match(protocol, /executionMode: options\.executionMode \|\| "model"/);
  assert.match(protocol, /GENERIC_LLM_GLOBAL_MODEL_CONCURRENCY\)/);
  assert.match(protocol, /order by priority desc, queue_sequence asc/);
  assert.doesNotMatch(protocol.slice(protocol.indexOf("export async function claimNextGenericLlmTaskRun"), protocol.indexOf("async function claimGenericLlmTaskRunInternal")), /taskType=\?/);
});
