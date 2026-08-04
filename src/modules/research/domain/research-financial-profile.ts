export const researchFinancialEntityTypes = ["non_financial", "bank", "insurer", "broker", "financial_other"] as const;
export type ResearchFinancialEntityType = typeof researchFinancialEntityTypes[number];
export type ResearchFinancialQualityEntityType = "non_financial" | "financial" | "unknown";
export const researchFinancialProfileAuthorities = ["issuer_disclosure", "exchange_filing", "regulator_or_court", "audit_report"] as const;
export type ResearchFinancialProfileAuthority = typeof researchFinancialProfileAuthorities[number];

export type ResearchFinancialProfileRecord = {
  financialProfileId: string;
  companyId: string;
  sourceSecurityCode: string;
  entityType: ResearchFinancialEntityType;
  asOf: string;
  sourceAuthority: ResearchFinancialProfileAuthority;
  sourceUrl: string;
  sourceTitle: string;
  sourceNote: string;
  recordedBy: string;
  recordedAt: number;
  createdAt: number;
};

export type ResolvedResearchFinancialProfile = {
  availability: "empty" | "available" | "unavailable";
  status: "unknown" | "confirmed" | "conflicting";
  entityType: ResearchFinancialEntityType | null;
  qualityEntityType: ResearchFinancialQualityEntityType;
  asOf: string | null;
  reason: string;
  records: ResearchFinancialProfileRecord[];
};

export function assertResearchFinancialProfileRecord(record: ResearchFinancialProfileRecord): void {
  required(record.financialProfileId, "financialProfileId"); required(record.companyId, "companyId"); required(record.sourceSecurityCode, "sourceSecurityCode");
  if (!researchFinancialEntityTypes.includes(record.entityType)) throw new Error("entityType is invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.asOf)) throw new Error("asOf must be YYYY-MM-DD");
  if (!researchFinancialProfileAuthorities.includes(record.sourceAuthority)) throw new Error("sourceAuthority is invalid");
  const url = required(record.sourceUrl, "sourceUrl");
  if (!/^https:\/\//i.test(url)) throw new Error("sourceUrl must use https");
  required(record.sourceTitle, "sourceTitle"); required(record.sourceNote, "sourceNote"); required(record.recordedBy, "recordedBy");
  if (!Number.isFinite(record.recordedAt) || !Number.isFinite(record.createdAt)) throw new Error("profile timestamps must be finite");
}

/** Only the latest effective date resolves the current classification.  Two
 * independently sourced types at that date are a visible conflict, never a
 * tie-break based on name, ticker, or source preference. */
export function resolveResearchFinancialProfile(records: ResearchFinancialProfileRecord[]): ResolvedResearchFinancialProfile {
  if (!records.length) return { availability: "empty", status: "unknown", entityType: null, qualityEntityType: "unknown", asOf: null, reason: "尚无带来源的经营实体类型；不会按证券代码或名称猜测并套用非金融指标。", records: [] };
  const latestAsOf = records.reduce((latest, record) => record.asOf > latest ? record.asOf : latest, records[0].asOf);
  const effective = records.filter((record) => record.asOf === latestAsOf);
  const types = [...new Set(effective.map((record) => record.entityType))];
  if (types.length !== 1) return { availability: "available", status: "conflicting", entityType: null, qualityEntityType: "unknown", asOf: latestAsOf, reason: `截至 ${latestAsOf} 存在互相冲突的实体类型：${types.join("、")}；通用非金融指标已阻断。`, records };
  const entityType = types[0];
  return { availability: "available", status: "confirmed", entityType, qualityEntityType: entityType === "non_financial" ? "non_financial" : "financial", asOf: latestAsOf, reason: entityType === "non_financial" ? "已由来源绑定记录确认非金融实体；通用指标仍需各自输入可比。" : "已由来源绑定记录确认金融实体；通用 FCF、营运资本、现金转换和 ROIC 指标明确不适用，专业监管指标仍待单独接入。", records };
}

function required(value: string, label: string): string { if (!value.trim()) throw new Error(`${label} is required`); return value.trim(); }
