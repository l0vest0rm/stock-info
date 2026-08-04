import { Hono } from "hono";
import { getSecurity } from "../../security/application/search-securities";
import { loadKline } from "../../market/application/load-kline";
import { D1SituationRepository } from "../../situation/application/situation-repository";
import { isSupportedCompanyCode, normalizeSecurityCode } from "../../../shared/codes";
import { fail, ok } from "../../../shared/http";
import type { AppEnv, KlineBar } from "../../../types";
import { buildResearchDecision } from "../domain/research-decision";
import { buildResearchRiskProfile } from "../domain/research-risk-profile";
import { buildDerivedObservation, buildForecastConsolidation, buildResearchCompletion, type ResearchRequirement, type SourceFact } from "../domain/research-foundation";

export const researchRoutes = new Hono<AppEnv>();

researchRoutes.get("/research/company/:code", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const now = Date.now();
  const from = `${new Date(now - 3 * 366 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`;
  const repository = new D1SituationRepository(c.env.DB);
  const [security, kline, events, impacts, signals, candidates, snapshot, sources, documentStats] = await Promise.all([
    getSecurity(c.env.DB, code),
    loadKline(c.env, code, "day", "forward", from, new Date(now).toISOString().slice(0, 10)),
    repository.listEvents({ asOf: now, targetCode: code, limit: 100 }),
    repository.listImpacts({ asOf: now, targetType: "company", targetIds: [code] }),
    repository.listSignals({ asOf: now, subjectType: "company", subjectId: code, limit: 20 }),
    repository.listCandidates("local", now, { targetIds: [code] }),
    repository.latestSnapshot("company", code, now),
    repository.listSources(),
    knowledgeDocumentStats(c.env.DB, code),
  ]);
  const rows = (kline.rows as KlineBar[]).filter((item) => "close" in item);
  const evidence = events.flatMap((event) => event.evidence.map((item) => ({
    evidenceId: item.evidenceId, title: item.title, url: item.url, publishedAt: item.publishedAt,
    sourceId: item.sourceId, grade: item.evidenceGrade, eventStatus: event.status, eventId: event.eventId,
  })));
  const decision = buildResearchDecision({
    klineRows: rows.map((item) => ({ close: item.close, peTtm: item.peTtm, pb: item.pb })),
    evidenceCount: evidence.length,
    confirmedEvidenceCount: evidence.filter((item) => item.grade === "official_confirmed" || item.grade === "multi_source_confirmed").length,
    conflictingEvidenceCount: evidence.filter((item) => item.grade === "conflicting").length,
    activeCandidateCount: candidates.length,
    pressureImpactCount: impacts.filter((item) => item.direction === "pressure").length,
    supportImpactCount: impacts.filter((item) => item.direction === "support").length,
  });
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const riskProfile = buildResearchRiskProfile({
    peTtm: decision.metrics.peTtm,
    pb: decision.metrics.pb,
    pePercentile: decision.metrics.pePercentile,
    pbPercentile: decision.metrics.pbPercentile,
    drawdown90d: decision.metrics.drawdown90d,
    evidence,
    impacts: impacts.map((impact) => {
      const event = impact.eventId ? eventById.get(impact.eventId) : null;
      return { ...impact, title: event?.title ?? null, references: (event?.evidence ?? []).map((item) => ({ evidenceId: item.evidenceId, title: item.title, url: item.url, publishedAt: item.publishedAt, grade: item.evidenceGrade })) };
    }),
    sources,
    documentCount: documentStats.total,
  });
  const foundation = buildCompanyResearchFoundation({ code, now, security, rows, evidence, decision });
  return ok(c, {
    generatedAt: now,
    code,
    name: security?.name ?? code,
    decision,
    riskProfile,
    foundation,
    evidence: evidence.slice(0, 20),
    situation: { snapshot, signals, impacts, candidates },
    documents: documentStats,
    dataHealth: {
      kline: { source: kline.source, rows: rows.length, latestDate: rows.at(-1)?.date ?? null, updatedAt: rows.at(-1)?.updatedAt ?? null },
      situationSources: sources.map((item) => ({ sourceId: item.sourceId, name: item.name, state: item.state, lastSuccessAt: item.lastSuccessAt, lastError: item.lastError })),
      limitations: [
        "研究状态不构成买卖建议，也不会自动下单。",
        "个股实时资金流、完整财务质量因子和个人组合约束尚未统一接入时，相关门槛会保持待补。",
      ],
    },
  });
});

researchRoutes.get("/research/industry", async (c) => {
  const industry = String(c.req.query("industry") ?? "").trim();
  if (!industry || industry.length > 80) return fail(c, 400, "industry is required");
  const now = Date.now();
  const repository = new D1SituationRepository(c.env.DB);
  const [impacts, snapshot, sources, macroEvents] = await Promise.all([
    repository.listImpacts({ asOf: now, targetType: "industry", targetIds: [industry] }),
    repository.latestSnapshot("industry", industry, now),
    repository.listSources(),
    c.env.DB.prepare("select event_id as eventId, title, scheduled_at as scheduledAt, importance, source_url as sourceUrl from macro_events where scheduled_at>=? order by scheduled_at asc limit 12").bind(now).all(),
  ]);
  const events = (await Promise.all(impacts.filter((item) => item.eventId).map((item) => repository.getEvent(item.eventId!, now)))).filter(Boolean);
  const evidence = events.flatMap((event) => event!.evidence.map((item) => ({ evidenceId: item.evidenceId, title: item.title, url: item.url, publishedAt: item.publishedAt, sourceId: item.sourceId, grade: item.evidenceGrade, eventStatus: event!.status })));
  const support = impacts.filter((item) => item.direction === "support").length;
  const pressure = impacts.filter((item) => item.direction === "pressure").length;
  return ok(c, {
    generatedAt: now, industry, snapshot, impacts, evidence: evidence.slice(0, 30),
    assessment: {
      state: !snapshot && evidence.length === 0 ? "资料待补" : evidence.some((item) => item.grade === "conflicting") || pressure > support ? "证伪复核" : "持续研究",
      summary: !snapshot && evidence.length === 0 ? "当前没有可审计的行业快照或精确关联证据。" : `支持影响 ${support} 条，压力影响 ${pressure} 条；行业结论以证据和快照为准。`,
      nextSteps: ["补齐行业到公司的暴露映射。", "核对真实中观数据、行业资金流与原始出处。", "将冲突证据保留在档案中，不以摘要覆盖。"],
    },
    sources: sources.map((item) => ({ sourceId: item.sourceId, name: item.name, state: item.state, lastSuccessAt: item.lastSuccessAt, lastError: item.lastError })),
    upcomingMacroEvents: macroEvents.results ?? [],
  });
});

async function knowledgeDocumentStats(db: D1Database, code: string) {
  const row = await db.prepare(`select count(*) as total, sum(case when source_type='research_report' then 1 else 0 end) as reports, max(sort_time) as latestSortTime
    from knowledge_docs where target_code_normalized=?`).bind(code).first<{ total: number; reports: number; latestSortTime: string | null }>();
  return { total: Number(row?.total ?? 0), reports: Number(row?.reports ?? 0), latestSortTime: row?.latestSortTime ?? null };
}

function buildCompanyResearchFoundation(input: {
  code: string;
  now: number;
  security: { name: string; currency?: string | null; exchangeName?: string | null } | null;
  rows: KlineBar[];
  evidence: Array<{ evidenceId: string; sourceId: string; title: string; url: string; publishedAt: number; grade: string; eventStatus: string }>;
  decision: ReturnType<typeof buildResearchDecision>;
}) {
  const latest = input.rows.at(-1);
  const sourceFacts: SourceFact[] = [];
  const marketAsOf = validTime(latest?.updatedAt) ? latest.updatedAt : input.now;
  if (finite(latest?.close)) sourceFacts.push({ id: "market-close", label: "最近日线收盘价", value: latest.close, asOf: marketAsOf, sourceIds: [`kline:${latest.source}`] });
  if (finite(latest?.peTtm)) sourceFacts.push({ id: "market-pe-ttm", label: "最近 TTM PE", value: latest.peTtm, asOf: marketAsOf, sourceIds: [`kline:${latest.source}`] });
  if (finite(latest?.pb)) sourceFacts.push({ id: "market-pb", label: "最近 PB", value: latest.pb, asOf: marketAsOf, sourceIds: [`kline:${latest.source}`] });
  const requirements: ResearchRequirement[] = [
    {
      id: "listed-security-identity", label: "上市证券身份与市场口径", requiredAt: "basic",
      status: input.security ? "available" : "partial", blocking: true,
      effect: "未确认具体证券时，不能把价格、币种、股本或股东权利与经营公司混用。",
      nextStep: "补充证券市场、币种、股份类别与股东权利的来源记录。",
    },
    {
      id: "operating-company-identity", label: "经营公司与证券的映射", requiredAt: "standard",
      status: "missing", blocking: true,
      effect: "无法确认多地上市或不同股份类别是否共用同一经营分析。",
      nextStep: "建立经营公司实体，并记录该证券与经营公司的权益关系。",
    },
    {
      id: "source-bound-evidence", label: "公司级来源证据", requiredAt: "basic",
      status: input.evidence.length ? "available" : "missing", blocking: true,
      effect: "没有可访问的公司级来源时，命题、风险和催化剂都不能被核验。",
      nextStep: "关联公告、法定披露、研报或其他原始来源，并保留日期、等级与链接。",
      sourceIds: [...new Set(input.evidence.map((item) => item.sourceId))],
    },
    {
      id: "market-history", label: "行情与历史估值观察", requiredAt: "basic",
      status: input.rows.length >= 30 ? "available" : input.rows.length ? "partial" : "missing", blocking: true,
      effect: "没有足够日线时，历史估值位置和价格波动仅能保持待补。",
      nextStep: "补齐 Xueqiu 日线覆盖；不使用其他股票 K 线来源替代。",
    },
    {
      id: "financial-statement-periods", label: "标准化财务期间与口径", requiredAt: "standard",
      status: "missing", blocking: true,
      effect: "缺少财务三表、期间、币种和会计口径时，增长、现金流、杠杆和每股价值不可得。",
      nextStep: "接入已标准化的财报记录，并保留来源、期间、币种与调整项。",
    },
    {
      id: "forecast-source-records", label: "可比第三方预测样本", requiredAt: "standard",
      status: "missing", blocking: true,
      effect: "无法形成来源可追溯的预测汇总、情景校准或前瞻估值。",
      nextStep: "录入带机构、版本、期间、币种、会计口径和原始值的预测来源。",
    },
    {
      id: "valuation-scenarios", label: "经营假设到证券估值的情景桥", requiredAt: "standard",
      status: "missing", blocking: true,
      effect: "历史 PE/PB 位置不能替代按证券、股本和币种计算的价值区间。",
      nextStep: "按估值原型补齐悲观、基准、乐观的经营假设、股本与估值输入。",
    },
    {
      id: "industry-company-exposure", label: "行业到公司的可验证暴露", requiredAt: "deep",
      status: "missing", blocking: true,
      effect: "不能将行业观点自动当作公司收入、利润或估值影响。",
      nextStep: "建立主营赛道、分部、客户、产品与经营变量的暴露映射。",
    },
  ];
  const derivedObservations = [
    buildDerivedObservation({
      id: "pe-history-percentile", label: "TTM PE 历史分位", formula: "有效历史 PE 样本中小于等于最新 PE 的样本数 / 有效样本数", unit: "%", asOf: marketAsOf,
      value: input.decision.metrics.pePercentile, sourceFacts: finite(latest?.peTtm) ? [{ id: "market-pe-ttm", label: "最近 TTM PE", value: latest.peTtm, asOf: marketAsOf, sourceIds: [`kline:${latest.source}`] }] : [], adjustments: ["仅使用正且有限的历史 PE 样本；不替代未来盈利或估值情景。"],
    }),
    buildDerivedObservation({
      id: "pb-history-percentile", label: "PB 历史分位", formula: "有效历史 PB 样本中小于等于最新 PB 的样本数 / 有效样本数", unit: "%", asOf: marketAsOf,
      value: input.decision.metrics.pbPercentile, sourceFacts: finite(latest?.pb) ? [{ id: "market-pb", label: "最近 PB", value: latest.pb, asOf: marketAsOf, sourceIds: [`kline:${latest.source}`] }] : [], adjustments: ["仅使用正且有限的历史 PB 样本；不替代未来盈利或估值情景。"],
    }),
  ];
  return {
    ruleVersion: "research-foundation.v1",
    object: { securityCode: input.code, securityName: input.security?.name ?? input.code, exchangeName: input.security?.exchangeName ?? null, currency: input.security?.currency ?? null, operatingCompanyId: null },
    completions: {
      basic: buildResearchCompletion({ coverageLevel: "basic", requirements }),
      standard: buildResearchCompletion({ coverageLevel: "standard", requirements }),
      deep: buildResearchCompletion({ coverageLevel: "deep", requirements }),
    },
    sourceFacts,
    derivedObservations,
    forecast: buildForecastConsolidation({ asOf: input.now, companyId: input.code, metric: "unconfigured", fiscalPeriod: "unconfigured", accountingBasis: "unconfigured", currency: input.security?.currency ?? "unconfigured", unit: "unconfigured", forecasts: [] }),
  };
}

function finite(value: number | null | undefined): value is number { return typeof value === "number" && Number.isFinite(value); }
function validTime(value: number | null | undefined): value is number { return finite(value) && value > 0; }
