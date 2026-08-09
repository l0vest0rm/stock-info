import { Hono } from "hono";
import { D1MacroRepository } from "../../macro/application/macro-repository";
import { fail, ok } from "../../../shared/http";
import { isLocalDevelopmentRuntime } from "../../../shared/request";
import type { AppEnv } from "../../../types";
import { isRecord, validEvidenceInput, validOwnerKey } from "../domain/model";
import { D1SituationRepository } from "../application/situation-repository";
import { ingestEvidence, refreshOwnerCandidates, summarizeSituation } from "../application/situation-service";
import { syncSituationData } from "../application/sync-situation-data";

export const situationRoutes = new Hono<AppEnv>();
const marketNames: Record<string, string> = { us: "美股", cn: "A股", hk: "港股", kr: "韩国" };

situationRoutes.get("/situations/today", async (c) => {
  const asOf = parseAsOf(c.req.query("asOf")); if (asOf === null) return fail(c, 400, "invalid asOf");
  const owner = ownerKey(c.req.query("owner")); if (!owner) return fail(c, 400, "invalid owner");
  const repository = new D1SituationRepository(c.env.DB);
  const [sources, events, candidates, macroSources, macroEvents] = await Promise.all([
    repository.listSources(), repository.listEvents({ asOf, limit: 30 }), repository.listCandidates(owner, asOf),
    new D1MacroRepository(c.env.DB).listSourceHealth(), new D1MacroRepository(c.env.DB).listEvents({ from: asOf, to: asOf + 7 * 86_400_000 }),
  ]);
  const markets = await marketViews(repository, macroSources, asOf);
  const summary = summarizeSituation({ candidates, events, sources: [...sources, ...macroSources.map((item) => ({ state: item.state }))], asOf });
  return ok(c, {
    generatedAt: new Date().toISOString(), asOf, summary, markets,
    changes: events, actionCandidates: candidates, futureRisks: [...macroEvents, ...events.filter((item) => item.importance === "high")].slice(0, 12),
    dataHealth: { situation: sources, macro: macroSources },
  });
});

situationRoutes.get("/situations/status", async (c) => {
  const repository = new D1SituationRepository(c.env.DB);
  const [sources, macro] = await Promise.all([repository.listSources(), new D1MacroRepository(c.env.DB).listSourceHealth()]);
  return ok(c, { generatedAt: new Date().toISOString(), sources, macroSources: macro, state: sources.some((item) => item.state === "failed") ? "degraded" : "ready" });
});

situationRoutes.get("/situations/markets", async (c) => {
  const asOf = parseAsOf(c.req.query("asOf")); if (asOf === null) return fail(c, 400, "invalid asOf");
  const macro = await new D1MacroRepository(c.env.DB).listSourceHealth();
  return ok(c, { asOf, markets: await marketViews(new D1SituationRepository(c.env.DB), macro, asOf) });
});

situationRoutes.get("/situations/industries", async (c) => {
  const asOf = parseAsOf(c.req.query("asOf")); if (asOf === null) return fail(c, 400, "invalid asOf");
  const repository = new D1SituationRepository(c.env.DB);
  const impacts = await repository.listImpacts({ asOf, targetType: "industry" });
  const industries = await Promise.all(impacts.map(async (impact) => ({ ...impact, event: impact.eventId ? await repository.getEvent(impact.eventId, asOf) : null })));
  return ok(c, { asOf, industries });
});

situationRoutes.get("/situations/holdings", async (c) => {
  const asOf = parseAsOf(c.req.query("asOf")); if (asOf === null) return fail(c, 400, "invalid asOf");
  const owner = ownerKey(c.req.query("owner")); if (!owner) return fail(c, 400, "invalid owner");
  const codes = csv(c.req.query("codes"));
  const repository = new D1SituationRepository(c.env.DB);
  const [profiles, impacts, candidates] = await Promise.all([
    repository.listHoldingProfiles(owner, codes), repository.listImpacts({ asOf, targetType: "company", targetIds: codes }), repository.listCandidates(owner, asOf, { targetIds: codes }),
  ]);
  const byCode = new Map(profiles.map((item) => [item.code, item]));
  const holdings = await Promise.all(codes.map(async (code) => {
    const codeImpacts = impacts.filter((item) => item.targetId === code);
    const event = codeImpacts[0]?.eventId ? await repository.getEvent(codeImpacts[0].eventId, asOf) : null;
    const candidate = candidates.find((item) => item.targetId === code) ?? null;
    return { code, profile: byCode.get(code)?.profile ?? null, configured: byCode.has(code), impactState: codeImpacts[0]?.direction ?? "unknown", impact: event?.title ?? "尚无可关联的已验证影响", event, action: candidate?.actionType ?? "review", candidate, evidence: event?.evidence ?? [] };
  }));
  return ok(c, { asOf, holdings });
});

situationRoutes.get("/situations/opportunities", async (c) => {
  const asOf = parseAsOf(c.req.query("asOf")); if (asOf === null) return fail(c, 400, "invalid asOf");
  const owner = ownerKey(c.req.query("owner")); if (!owner) return fail(c, 400, "invalid owner");
  const repository = new D1SituationRepository(c.env.DB);
  const candidates = await repository.listCandidates(owner, asOf, { actionTypes: ["research", "establish"] });
  return ok(c, { asOf, industries: candidates.filter((item) => item.targetType === "industry"), companies: candidates.filter((item) => item.targetType === "company") });
});

situationRoutes.get("/situations/evidence/:id", async (c) => { const evidence = await new D1SituationRepository(c.env.DB).getEvidence(c.req.param("id")); return evidence ? ok(c, { evidence }) : fail(c, 404, "evidence not found"); });
situationRoutes.get("/situations/events/:id", async (c) => { const event = await new D1SituationRepository(c.env.DB).getEvent(c.req.param("id"), parseAsOf(c.req.query("asOf")) ?? Date.now()); return event ? ok(c, { event }) : fail(c, 404, "event not found"); });
situationRoutes.get("/situations/snapshots/:id", async (c) => { const snapshot = await new D1SituationRepository(c.env.DB).getSnapshot(c.req.param("id")); return snapshot ? ok(c, { snapshot }) : fail(c, 404, "snapshot not found"); });

situationRoutes.post("/situations/candidates/:id/disposition", async (c) => {
  if (!isLocalDevelopmentRuntime(c.env)) return fail(c, 404, "candidate disposition is only available in local development until an authenticated owner model exists");
  const body = await c.req.json().catch(() => null); const disposition = isRecord(body) ? String(body.disposition ?? "") : "";
  if (!(["confirmed", "ignored", "deferred", "researching"].includes(disposition))) return fail(c, 400, "invalid disposition");
  const owner = ownerKey(isRecord(body) ? String(body.ownerKey ?? "local") : "local"); if (!owner) return fail(c, 400, "invalid owner");
  const repository = new D1SituationRepository(c.env.DB); const candidate = await repository.getCandidate(c.req.param("id"));
  if (!candidate || candidate.ownerKey !== owner) return fail(c, 404, "candidate not found");
  const now = Date.now(); await repository.addDisposition({ dispositionId: `disposition:${crypto.randomUUID()}`, candidateId: candidate.candidateId, ownerKey: owner, disposition, note: isRecord(body) && typeof body.note === "string" ? body.note.slice(0, 1000) : null, now });
  return ok(c, await repository.getCandidate(candidate.candidateId));
});

situationRoutes.put("/situations/portfolio-rules", async (c) => writeLocal(c, async (repository, body, owner, now) => { if (!isRecord(body.rules)) return fail(c, 400, "rules must be an object"); await repository.putPortfolioRules(owner, body.rules, now); return ok(c, { ownerKey: owner, rules: await repository.getPortfolioRules(owner) }); }));
situationRoutes.get("/situations/portfolio-rules", async (c) => { const owner = ownerKey(c.req.query("owner")); if (!owner) return fail(c, 400, "invalid owner"); return ok(c, { ownerKey: owner, rules: await new D1SituationRepository(c.env.DB).getPortfolioRules(owner) }); });
situationRoutes.put("/situations/holdings/:code", async (c) => writeLocal(c, async (repository, body, owner, now) => { if (!isRecord(body.profile)) return fail(c, 400, "profile must be an object"); const code = normalizeCode(c.req.param("code")); if (!code) return fail(c, 400, "invalid code"); await repository.putHoldingProfile(owner, code, body.profile, now); return ok(c, { code, profile: body.profile }); }));

situationRoutes.post("/situations/evidence", async (c) => writeLocal(c, async (repository, body, _owner, now) => { if (!validEvidenceInput(body)) return fail(c, 400, "invalid evidence payload"); const result = await ingestEvidence(repository, body, now); const holdings = await repository.listHoldingProfiles("local"); await refreshOwnerCandidates(repository, "local", holdings.map((item) => item.code), now); return ok(c, result); }));
situationRoutes.post("/situations/sync", async (c) => { if (!isLocalDevelopmentRuntime(c.env)) return fail(c, 404, "situation sync endpoint is only available in local development"); return ok(c, await syncSituationData(c.env)); });

async function writeLocal(c: any, fn: (repository: D1SituationRepository, body: Record<string, unknown>, owner: string, now: number) => Promise<Response>): Promise<Response> {
  if (!isLocalDevelopmentRuntime(c.env)) return fail(c, 404, "situation configuration is only available in local development until an authenticated owner model exists");
  const body = await c.req.json().catch(() => null); if (!isRecord(body)) return fail(c, 400, "invalid request body"); const owner = ownerKey(String(body.ownerKey ?? "local")); if (!owner) return fail(c, 400, "invalid owner"); return fn(new D1SituationRepository(c.env.DB), body, owner, Date.now());
}
async function marketViews(repository: D1SituationRepository, macroSources: Array<{ state: string }>, asOf: number) {
  const macroHealthy = macroSources.filter((item) => item.state === "healthy").length; const macroConfidence = macroSources.length ? macroHealthy / macroSources.length : 0;
  return Promise.all(Object.entries(marketNames).map(async ([market, name]) => { const snapshot = await repository.latestSnapshot("market", market, asOf); return snapshot ? { market, name, ...snapshot } : { market, name, state: macroConfidence ? "证据待整合" : "数据不足", score: null, confidence: macroConfidence, summary: "宏观数据健康度已纳入；等待事件与市场信号形成可审计态势快照。" }; }));
}
function csv(value: string | undefined): string[] { return [...new Set((value ?? "").split(",").map(normalizeCode).filter(Boolean))]; }
function normalizeCode(value: string): string { const code = value.trim().toUpperCase(); return /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK|[A-Z.]{1,12}\.US)$/.test(code) ? code : ""; }
function ownerKey(value: string | undefined): string | null { const owner = (value ?? "local").trim(); return validOwnerKey(owner) ? owner : null; }
function parseAsOf(value: string | undefined): number | null { if (!value) return Date.now(); const numeric = Number(value); const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
