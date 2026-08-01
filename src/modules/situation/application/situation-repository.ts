import type { EvidenceGrade, SituationCandidate, SituationEvent, SituationEvidence, SituationImpact, SituationSignal } from "../domain/model";

export class D1SituationRepository {
  constructor(private readonly db: D1Database) {}

  async upsertSource(input: { sourceId: string; name: string; kind: string; config?: Record<string, unknown>; state?: string; error?: string | null; now: number }): Promise<void> {
    await this.db.prepare(`insert into situation_sources
      (source_id, name, kind, config_json, health_state, last_attempt_at, last_success_at, consecutive_failures, last_error, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(source_id) do update set name=excluded.name, kind=excluded.kind, config_json=excluded.config_json,
      health_state=excluded.health_state, last_attempt_at=excluded.last_attempt_at,
      last_success_at=case when excluded.health_state='healthy' then excluded.last_success_at else situation_sources.last_success_at end,
      consecutive_failures=case when excluded.health_state='failed' then situation_sources.consecutive_failures + 1 else 0 end,
      last_error=excluded.last_error, updated_at=excluded.updated_at`)
      .bind(input.sourceId, input.name, input.kind, JSON.stringify(input.config ?? {}), input.state ?? "healthy", input.now,
        input.state === "healthy" ? input.now : null, input.state === "failed" ? 1 : 0, input.error ?? null, input.now).run();
  }

  async listSources(): Promise<Array<{ sourceId: string; name: string; kind: string; state: string; lastSuccessAt: number | null; lastError: string | null; updatedAt: number }>> {
    const rows = await this.db.prepare(`select source_id as sourceId, name, kind, health_state as state,
      last_success_at as lastSuccessAt, last_error as lastError, updated_at as updatedAt from situation_sources order by source_id`).all<any>();
    return rows.results ?? [];
  }

  async putEvidence(evidence: SituationEvidence): Promise<{ evidence: SituationEvidence; created: boolean }> {
    const existing = await this.db.prepare(`select ${evidenceFields()} from situation_evidence
      where source_id = ? and ((? is not null and external_id = ?) or content_hash = ?) limit 1`)
      .bind(evidence.sourceId, evidence.externalId || null, evidence.externalId || null, await hashEvidence(evidence.sourceId, evidence.url, evidence.title, evidence.excerpt || "")).first<any>();
    if (existing) return { evidence: mapEvidence(existing), created: false };
    const contentHash = await hashEvidence(evidence.sourceId, evidence.url, evidence.title, evidence.excerpt || "");
    await this.db.prepare(`insert into situation_evidence
      (evidence_id, source_id, external_id, url, title, excerpt, published_at, fetched_at, content_hash, raw_r2_key,
       entities_json, metadata_json, evidence_grade, status, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(evidence.evidenceId, evidence.sourceId, evidence.externalId || null, evidence.url, evidence.title, evidence.excerpt || null,
        evidence.publishedAt, evidence.fetchedAt, contentHash, null, JSON.stringify(evidence.entities), JSON.stringify(evidence.metadata),
        evidence.evidenceGrade, evidence.status, evidence.createdAt).run();
    return { evidence, created: true };
  }

  async getEvidence(evidenceId: string): Promise<SituationEvidence | null> {
    const row = await this.db.prepare(`select ${evidenceFields()} from situation_evidence where evidence_id = ?`).bind(evidenceId).first<any>();
    return row ? mapEvidence(row) : null;
  }

  async listEvidence(options: { asOf: number; limit?: number; eventId?: string } ): Promise<SituationEvidence[]> {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const sql = options.eventId
      ? `select ${evidenceFields("e")} from situation_evidence e join situation_event_evidence link on link.evidence_id=e.evidence_id where link.event_id=? and e.published_at<=? and e.fetched_at<=? order by e.published_at desc limit ?`
      : `select ${evidenceFields()} from situation_evidence where published_at<=? and fetched_at<=? order by published_at desc limit ?`;
    const bindings = options.eventId ? [options.eventId, options.asOf, options.asOf, limit] : [options.asOf, options.asOf, limit];
    const rows = await this.db.prepare(sql).bind(...bindings).all<any>();
    return (rows.results ?? []).map(mapEvidence);
  }

  async upsertEvent(event: Omit<SituationEvent, "evidence">): Promise<SituationEvent> {
    await this.db.prepare(`insert into situation_events
      (event_id, canonical_key, title, occurred_at, region, event_type, status, importance, summary, first_seen_at, last_seen_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(canonical_key) do update set title=excluded.title, status=excluded.status, importance=excluded.importance,
      summary=excluded.summary, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`)
      .bind(event.eventId, event.canonicalKey, event.title, event.occurredAt, event.region, event.eventType, event.status,
        event.importance, event.summary, event.firstSeenAt, event.lastSeenAt, event.createdAt, event.updatedAt).run();
    return (await this.getEventByKey(event.canonicalKey))!;
  }

  async getEvent(eventId: string, asOf = Date.now()): Promise<SituationEvent | null> {
    const row = await this.db.prepare(`select * from situation_events where event_id=? and first_seen_at<=?`).bind(eventId, asOf).first<any>();
    return row ? this.withEventEvidence(mapEvent(row), asOf) : null;
  }

  async listEvents(options: { asOf: number; limit?: number; targetCode?: string } ): Promise<SituationEvent[]> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const rows = await this.db.prepare(`select * from situation_events where first_seen_at<=? and last_seen_at<=? order by last_seen_at desc limit ?`).bind(options.asOf, options.asOf, limit).all<any>();
    const events = await Promise.all((rows.results ?? []).map((row: any) => this.withEventEvidence(mapEvent(row), options.asOf)));
    return options.targetCode ? events.filter((event) => event.evidence.some((item) => item.entities.includes(options.targetCode!))) : events;
  }

  async linkEventEvidence(eventId: string, evidenceId: string, role: "primary" | "corroborating" | "conflicting", confidence: number, now: number): Promise<void> {
    await this.db.prepare(`insert into situation_event_evidence (event_id, evidence_id, role, confidence, created_at) values (?, ?, ?, ?, ?)
      on conflict(event_id, evidence_id) do update set role=excluded.role, confidence=excluded.confidence`)
      .bind(eventId, evidenceId, role, Math.max(0, Math.min(1, confidence)), now).run();
  }

  async putImpact(impact: SituationImpact): Promise<void> {
    await this.db.prepare(`insert into situation_impacts
      (impact_id, event_id, signal_id, target_type, target_id, direction, transmission, confidence, rationale_json, expires_at, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(impact_id) do update set direction=excluded.direction, confidence=excluded.confidence, rationale_json=excluded.rationale_json, expires_at=excluded.expires_at`)
      .bind(impact.impactId, impact.eventId, impact.signalId, impact.targetType, impact.targetId, impact.direction, impact.transmission,
        impact.confidence, JSON.stringify(impact.rationale), impact.expiresAt, impact.createdAt).run();
  }

  async putSignal(signal: SituationSignal): Promise<void> {
    await this.db.prepare(`insert into situation_signals
      (signal_id, subject_type, subject_id, rule_id, rule_version, state, score, confidence, observed_at, expires_at, input_json, explanation_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(signal_id) do update set state=excluded.state, score=excluded.score, confidence=excluded.confidence,
      expires_at=excluded.expires_at, input_json=excluded.input_json, explanation_json=excluded.explanation_json`)
      .bind(signal.signalId, signal.subjectType, signal.subjectId, signal.ruleId, signal.ruleVersion, signal.state, signal.score,
        signal.confidence, signal.observedAt, signal.expiresAt, JSON.stringify(signal.input), JSON.stringify(signal.explanation), signal.createdAt).run();
  }

  async listSignals(options: { asOf: number; subjectType?: SituationSignal["subjectType"]; subjectId?: string; limit?: number } ): Promise<SituationSignal[]> {
    const clauses = ["observed_at<=?", "(expires_at is null or expires_at>?)"];
    const bindings: unknown[] = [options.asOf, options.asOf];
    if (options.subjectType) { clauses.push("subject_type=?"); bindings.push(options.subjectType); }
    if (options.subjectId) { clauses.push("subject_id=?"); bindings.push(options.subjectId); }
    bindings.push(Math.min(200, Math.max(1, options.limit ?? 100)));
    const rows = await this.db.prepare(`select signal_id as signalId, subject_type as subjectType, subject_id as subjectId, rule_id as ruleId,
      rule_version as ruleVersion, state, score, confidence, observed_at as observedAt, expires_at as expiresAt,
      input_json as inputJson, explanation_json as explanationJson, created_at as createdAt from situation_signals
      where ${clauses.join(" and ")} order by observed_at desc limit ?`).bind(...bindings).all<any>();
    return (rows.results ?? []).map((row: any) => ({ ...row, input: parseObject(row.inputJson), explanation: parseObject(row.explanationJson) }));
  }

  async listImpacts(options: { asOf: number; targetType?: string; targetIds?: string[]; eventId?: string }): Promise<SituationImpact[]> {
    const clauses = ["created_at <= ?", "(expires_at is null or expires_at > ?)"];
    const bindings: unknown[] = [options.asOf, options.asOf];
    if (options.targetType) { clauses.push("target_type=?"); bindings.push(options.targetType); }
    if (options.targetIds?.length) { clauses.push(`target_id in (${options.targetIds.map(() => "?").join(",")})`); bindings.push(...options.targetIds); }
    if (options.eventId) { clauses.push("event_id=?"); bindings.push(options.eventId); }
    const rows = await this.db.prepare(`select impact_id as impactId, event_id as eventId, signal_id as signalId, target_type as targetType, target_id as targetId,
      direction, transmission, confidence, rationale_json as rationaleJson, expires_at as expiresAt, created_at as createdAt from situation_impacts where ${clauses.join(" and ")} order by created_at desc`).bind(...bindings).all<any>();
    return (rows.results ?? []).map((row: any) => ({ ...row, rationale: parseObject(row.rationaleJson) }));
  }

  async putCandidate(candidate: SituationCandidate): Promise<void> {
    await this.db.prepare(`insert into situation_action_candidates
      (candidate_id, owner_key, as_of, action_type, target_type, target_id, priority, status, prerequisites_json, proposed_plan_json,
       invalidations_json, evidence_json, rule_version, expires_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(candidate_id) do update set priority=excluded.priority, status=excluded.status, prerequisites_json=excluded.prerequisites_json,
      proposed_plan_json=excluded.proposed_plan_json, invalidations_json=excluded.invalidations_json, evidence_json=excluded.evidence_json,
      expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
      .bind(candidate.candidateId, candidate.ownerKey, candidate.asOf, candidate.actionType, candidate.targetType, candidate.targetId, candidate.priority,
        candidate.status, JSON.stringify(candidate.prerequisites), JSON.stringify(candidate.proposedPlan), JSON.stringify(candidate.invalidations),
        JSON.stringify(candidate.evidence), candidate.ruleVersion, candidate.expiresAt, candidate.createdAt, candidate.updatedAt).run();
  }

  async putSnapshot(input: { snapshotId: string; asOf: number; scopeType: "market" | "industry" | "company" | "portfolio" | "global"; scopeId: string; state: string; confidence: number; summary: Record<string, unknown>; ruleVersion: string; createdAt: number }): Promise<void> {
    await this.db.prepare(`insert into situation_snapshots
      (snapshot_id, as_of, scope_type, scope_id, state, confidence, summary_json, rule_version, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(as_of, scope_type, scope_id, rule_version) do update set state=excluded.state, confidence=excluded.confidence, summary_json=excluded.summary_json, created_at=excluded.created_at`)
      .bind(input.snapshotId, input.asOf, input.scopeType, input.scopeId, input.state, input.confidence, JSON.stringify(input.summary), input.ruleVersion, input.createdAt).run();
  }

  async latestSnapshot(scopeType: string, scopeId: string, asOf: number): Promise<{ snapshotId: string; asOf: number; scopeType: string; scopeId: string; state: string; confidence: number; summary: Record<string, unknown>; ruleVersion: string; createdAt: number } | null> {
    const row = await this.db.prepare(`select snapshot_id as snapshotId, as_of as asOf, scope_type as scopeType, scope_id as scopeId, state, confidence, summary_json as summaryJson, rule_version as ruleVersion, created_at as createdAt from situation_snapshots where scope_type=? and scope_id=? and as_of<=? order by as_of desc limit 1`).bind(scopeType, scopeId, asOf).first<any>();
    return row ? { ...row, summary: parseObject(row.summaryJson) } : null;
  }

  async getSnapshot(snapshotId: string): Promise<{ snapshotId: string; asOf: number; scopeType: string; scopeId: string; state: string; confidence: number; summary: Record<string, unknown>; ruleVersion: string; createdAt: number } | null> {
    const row = await this.db.prepare(`select snapshot_id as snapshotId, as_of as asOf, scope_type as scopeType, scope_id as scopeId,
      state, confidence, summary_json as summaryJson, rule_version as ruleVersion, created_at as createdAt from situation_snapshots where snapshot_id=?`).bind(snapshotId).first<any>();
    return row ? { ...row, summary: parseObject(row.summaryJson) } : null;
  }

  async listCandidates(ownerKey: string, asOf: number, options: { targetIds?: string[]; actionTypes?: string[] } = {}): Promise<SituationCandidate[]> {
    const clauses = ["c.owner_key=?", "c.status in ('open', 'blocked')", "c.as_of<=?", "(c.expires_at is null or c.expires_at>?)"];
    const bindings: unknown[] = [ownerKey, asOf, asOf];
    if (options.targetIds?.length) { clauses.push(`c.target_id in (${options.targetIds.map(() => "?").join(",")})`); bindings.push(...options.targetIds); }
    if (options.actionTypes?.length) { clauses.push(`c.action_type in (${options.actionTypes.map(() => "?").join(",")})`); bindings.push(...options.actionTypes); }
    const rows = await this.db.prepare(`select c.*, d.disposition as latestDisposition, d.note as latestNote, d.created_at as latestDispositionAt
      from situation_action_candidates c left join situation_candidate_dispositions d on d.disposition_id=(select disposition_id from situation_candidate_dispositions x where x.candidate_id=c.candidate_id order by created_at desc limit 1)
      where ${clauses.join(" and ")} order by c.priority desc, c.as_of desc`).bind(...bindings).all<any>();
    return (rows.results ?? []).map(mapCandidate);
  }

  async getCandidate(candidateId: string): Promise<SituationCandidate | null> {
    const row = await this.db.prepare(`select c.*, d.disposition as latestDisposition, d.note as latestNote, d.created_at as latestDispositionAt
      from situation_action_candidates c left join situation_candidate_dispositions d on d.disposition_id=(select disposition_id from situation_candidate_dispositions x where x.candidate_id=c.candidate_id order by created_at desc limit 1) where c.candidate_id=?`).bind(candidateId).first<any>();
    return row ? mapCandidate(row) : null;
  }

  async resolveProfileCandidates(ownerKey: string, code: string, activeCandidateIds: string[], ruleVersionPrefix: string, now: number): Promise<void> {
    const clauses = ["owner_key=?", "target_type='company'", "target_id=?", "status in ('open', 'blocked')", "rule_version like ?"];
    const bindings: unknown[] = [ownerKey, code, `${ruleVersionPrefix}%`];
    if (activeCandidateIds.length) { clauses.push(`candidate_id not in (${activeCandidateIds.map(() => "?").join(",")})`); bindings.push(...activeCandidateIds); }
    await this.db.prepare(`update situation_action_candidates set status='resolved', updated_at=? where ${clauses.join(" and ")}`).bind(now, ...bindings).run();
  }

  async addDisposition(input: { dispositionId: string; candidateId: string; ownerKey: string; disposition: string; note: string | null; now: number }): Promise<void> {
    await this.db.prepare(`insert into situation_candidate_dispositions (disposition_id, candidate_id, owner_key, disposition, note, created_at) values (?, ?, ?, ?, ?, ?)`)
      .bind(input.dispositionId, input.candidateId, input.ownerKey, input.disposition, input.note, input.now).run();
  }

  async putPortfolioRules(ownerKey: string, rules: Record<string, unknown>, now: number): Promise<void> {
    await this.db.prepare(`insert into situation_portfolio_rules (owner_key, rules_json, updated_at) values (?, ?, ?)
      on conflict(owner_key) do update set rules_json=excluded.rules_json, updated_at=excluded.updated_at`).bind(ownerKey, JSON.stringify(rules), now).run();
  }
  async getPortfolioRules(ownerKey: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare(`select rules_json as rulesJson from situation_portfolio_rules where owner_key=?`).bind(ownerKey).first<any>(); return row ? parseObject(row.rulesJson) : null;
  }
  async putHoldingProfile(ownerKey: string, code: string, profile: Record<string, unknown>, now: number): Promise<void> {
    await this.db.prepare(`insert into situation_holding_profiles (owner_key, code, profile_json, updated_at) values (?, ?, ?, ?)
      on conflict(owner_key, code) do update set profile_json=excluded.profile_json, updated_at=excluded.updated_at`).bind(ownerKey, code, JSON.stringify(profile), now).run();
  }
  async listHoldingProfiles(ownerKey: string, codes?: string[]): Promise<Array<{ code: string; profile: Record<string, unknown>; updatedAt: number }>> {
    const clauses = ["owner_key=?"]; const bindings: unknown[] = [ownerKey];
    if (codes?.length) { clauses.push(`code in (${codes.map(() => "?").join(",")})`); bindings.push(...codes); }
    const rows = await this.db.prepare(`select code, profile_json as profileJson, updated_at as updatedAt from situation_holding_profiles where ${clauses.join(" and ")} order by code`).bind(...bindings).all<any>();
    return (rows.results ?? []).map((row: any) => ({ code: row.code, profile: parseObject(row.profileJson), updatedAt: row.updatedAt }));
  }

  private async getEventByKey(key: string): Promise<SituationEvent | null> { const row = await this.db.prepare("select * from situation_events where canonical_key=?").bind(key).first<any>(); return row ? this.withEventEvidence(mapEvent(row), Date.now()) : null; }
  private async withEventEvidence(event: Omit<SituationEvent, "evidence">, asOf: number): Promise<SituationEvent> { return { ...event, evidence: await this.listEvidence({ asOf, eventId: event.eventId, limit: 50 }) }; }
}

function evidenceFields(alias = ""): string { const p = alias ? `${alias}.` : ""; return `${p}evidence_id as evidenceId, ${p}source_id as sourceId, ${p}external_id as externalId, ${p}url, ${p}title, ${p}excerpt, ${p}published_at as publishedAt, ${p}fetched_at as fetchedAt, ${p}entities_json as entitiesJson, ${p}metadata_json as metadataJson, ${p}evidence_grade as evidenceGrade, ${p}status, ${p}created_at as createdAt`; }
function mapEvidence(row: any): SituationEvidence { return { evidenceId: row.evidenceId, sourceId: row.sourceId, externalId: row.externalId, url: row.url, title: row.title, excerpt: row.excerpt, publishedAt: row.publishedAt, fetchedAt: row.fetchedAt, entities: parseStringArray(row.entitiesJson), metadata: parseObject(row.metadataJson), evidenceGrade: row.evidenceGrade as EvidenceGrade, status: row.status, createdAt: row.createdAt }; }
function mapEvent(row: any): Omit<SituationEvent, "evidence"> { return { eventId: row.event_id, canonicalKey: row.canonical_key, title: row.title, occurredAt: row.occurred_at, region: row.region, eventType: row.event_type, status: row.status, importance: row.importance, summary: row.summary, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapCandidate(row: any): SituationCandidate { return { candidateId: row.candidate_id, ownerKey: row.owner_key, asOf: row.as_of, actionType: row.action_type, targetType: row.target_type, targetId: row.target_id, priority: row.priority, status: row.status, prerequisites: parseArray(row.prerequisites_json), proposedPlan: parseObject(row.proposed_plan_json), invalidations: parseArray(row.invalidations_json), evidence: parseArray(row.evidence_json), ruleVersion: row.rule_version, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at, latestDisposition: row.latestDisposition ? { disposition: row.latestDisposition, note: row.latestNote ?? null, createdAt: row.latestDispositionAt } : null }; }
function parseObject(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function parseArray(value: unknown): unknown[] { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function parseStringArray(value: unknown): string[] { return parseArray(value).filter((item): item is string => typeof item === "string"); }
async function hashEvidence(...parts: string[]): Promise<string> { const bytes = new TextEncoder().encode(parts.join("\n")); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
