/**
 * Valuation band vintages and the difference between two of them.
 *
 * A "band change" is easy to display and easy to misread.  The same visible
 * change — `PE(TTM) 8–18 → 10–22` — can mean three completely different things:
 *
 * - the company filed a new report and its denominator moved (real news);
 * - we edited `DEFAULT_RANGES` and every company's range moved (our change, not
 *   the company's, and reporting it as company news would be a fabrication);
 * - the quote provider went away and the yield bands lost their implied column
 *   (a data-source outage, not a valuation change at all).
 *
 * So this module never reports a bare "changed" flag.  Every difference carries
 * an `attribution`, and a difference that we cannot attribute is reported as
 * `unattributed` rather than guessed.
 *
 * Scope rules, same as `valuation-bands.ts`:
 * - no price, no target price, no instruction ever enters a snapshot;
 * - a band that stopped being computable is reported as such, never back-filled
 *   with the previous range to look continuous.
 */

import type { ValuationBand, ValuationBandReadModel, ValuationBandStatus } from "../../finance/domain/valuation-bands.ts";

/** The part of a band that is stable enough to compare across vintages. */
export type BandSnapshotEntry = {
  key: string;
  status: ValuationBandStatus;
  role: ValuationBand["role"];
  range: { low: number; high: number } | null;
  unit: ValuationBand["unit"];
  /**
   * Denominator basis, its report date and the value used.
   *
   * The date separates "the company reported again" from "we changed the
   * multiple": a new filing moves the date, a model edit never does.  The value
   * matters for the same year when a figure is restated, and it is a statement
   * number, never a quote.
   */
  denominator: { basis: string; reportDate: string; value: number } | null;
  /** Keys that blocked the band, used to recognise a price-source outage. */
  missingInputs: string[];
};

export type CompanyBandSnapshot = {
  companyId: string;
  /** The reference line used for the bands; the watchlist may list several. */
  code: string;
  archetype: string;
  asOf: ValuationBandReadModel["asOf"];
  bands: BandSnapshotEntry[];
};

export type BandSnapshot = {
  /** Date the snapshot was captured, `YYYY-MM-DD`. */
  asOf: string;
  /** ISO timestamp of the capture, for ordering two vintages on the same day. */
  capturedAt: string;
  companies: CompanyBandSnapshot[];
};

/**
 * Why a band moved.
 *
 * `model` and `filing` must never be collapsed: one is a change in our
 * assumptions, the other is a change in the company.
 */
export type BandChangeAttribution =
  | "filing"
  | "model"
  | "price_source"
  | "unattributed";

export type BandChangeKind =
  | "became_available"
  | "became_unavailable"
  | "became_forbidden"
  | "range_changed"
  | "role_changed"
  | "archetype_changed"
  | "denominator_changed"
  | "appeared"
  | "disappeared";

export type BandChange = {
  companyId: string;
  code: string;
  band: string;
  kind: BandChangeKind;
  attribution: BandChangeAttribution;
  from: string;
  to: string;
  /** One line a reader can act on; states the cause, not just the delta. */
  note: string;
};

export type BandSnapshotDiff = {
  from: string;
  to: string;
  changes: BandChange[];
  /** Companies present in both vintages and actually compared. */
  compared: number;
  /** Companies whose bands did not move at all. */
  unchanged: string[];
  /** Companies only present in one of the two vintages. */
  added: string[];
  removed: string[];
};

/** The band keys this repository never treats as comparable across vintages. */
const NON_COMPARABLE_STATUSES = new Set<ValuationBandStatus>(["forbidden_for_archetype"]);

export function snapshotFromReadModel(
  readModel: ValuationBandReadModel,
  companyId: string,
): CompanyBandSnapshot {
  return {
    companyId,
    code: readModel.code,
    archetype: readModel.archetype,
    asOf: readModel.asOf,
    bands: readModel.bands.map((band) => ({
      key: band.key,
      status: band.status,
      role: band.role,
      // `implied` is deliberately dropped: it is derived from a quote, and a
      // snapshot that carried it would put a price into a committed file.
      range: band.range ? { low: band.range.low, high: band.range.high } : null,
      unit: band.unit,
      denominator: band.denominator
        ? { basis: band.denominator.basis, reportDate: band.denominator.reportDate, value: band.denominator.value }
        : null,
      missingInputs: band.missingInputs,
    })),
  };
}

const PRICE_ONLY_MISSING = /市值|价格|行情/;

/**
 * True when every blocking input is a quote.
 *
 * A band that needs a quote to be `available` (the yield bands) drops out when
 * the provider fails, and that is not a valuation change.  Treating it as one
 * would make a data outage look like a signal.
 */
function blockedOnlyByQuote(entry: BandSnapshotEntry): boolean {
  return entry.missingInputs.length > 0 && entry.missingInputs.every((item) => PRICE_ONLY_MISSING.test(item));
}

export function diffBandSnapshots(previous: BandSnapshot, current: BandSnapshot): BandSnapshotDiff {
  const changes: BandChange[] = [];
  const unchanged: string[] = [];
  const before = new Map(previous.companies.map((company) => [company.companyId, company]));
  const after = new Map(current.companies.map((company) => [company.companyId, company]));

  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  let compared = 0;

  for (const [companyId, now] of after) {
    const then = before.get(companyId);
    if (!then) continue;
    compared += 1;
    const companyChanges = diffCompany(then, now);
    if (companyChanges.length === 0) unchanged.push(companyId);
    changes.push(...companyChanges);
  }

  return { from: previous.asOf, to: current.asOf, changes, compared, unchanged, added, removed };
}

function diffCompany(then: CompanyBandSnapshot, now: CompanyBandSnapshot): BandChange[] {
  const changes: BandChange[] = [];
  const base = { companyId: now.companyId, code: now.code };

  // Archetype decides the whole method set, so a change here explains every
  // other difference below and must be reported first rather than left implicit.
  if (then.archetype !== now.archetype) {
    changes.push({
      ...base,
      band: "archetype",
      kind: "archetype_changed",
      attribution: "model",
      from: then.archetype,
      to: now.archetype,
      note: `原型从 ${then.archetype} 变为 ${now.archetype}：可用方法集随之改变，这一条是分类口径变化，不是公司经营变化。`,
    });
  }

  const before = new Map(then.bands.map((band) => [band.key, band]));
  const after = new Map(now.bands.map((band) => [band.key, band]));

  for (const [key, nowBand] of after) {
    const thenBand = before.get(key);
    if (!thenBand) {
      changes.push({
        ...base,
        band: key,
        kind: "appeared",
        attribution: "model",
        from: "—",
        to: describe(nowBand),
        note: `${key} 是新出现的方法：原型或输入要求变了，不是公司新增了这个口径。`,
      });
      continue;
    }
    changes.push(...diffBand(base, thenBand, nowBand));
  }
  for (const [key, thenBand] of before) {
    if (after.has(key)) continue;
    changes.push({
      ...base,
      band: key,
      kind: "disappeared",
      attribution: "model",
      from: describe(thenBand),
      to: "—",
      note: `${key} 不再输出：方法集变了。缺失不等于该公司不再适用，需回看原型。`,
    });
  }
  return changes;
}

function diffBand(
  base: { companyId: string; code: string },
  thenBand: BandSnapshotEntry,
  nowBand: BandSnapshotEntry,
): BandChange[] {
  const changes: BandChange[] = [];
  const add = (kind: BandChangeKind, attribution: BandChangeAttribution, from: string, to: string, note: string) =>
    changes.push({ ...base, band: nowBand.key, kind, attribution, from, to, note });

  // 1. Availability.  The cause is read off the inputs, never assumed.
  if (thenBand.status !== nowBand.status) {
    const nowQuoteOnly = blockedOnlyByQuote(nowBand);
    const filingMoved = thenBand.denominator?.reportDate !== nowBand.denominator?.reportDate;
    const attribution: BandChangeAttribution = NON_COMPARABLE_STATUSES.has(nowBand.status)
      ? "model"
      : nowQuoteOnly
        ? "price_source"
        : filingMoved
          ? "filing"
          : "unattributed";
    const kind: BandChangeKind = nowBand.status === "available"
      ? "became_available"
      : nowBand.status === "forbidden_for_archetype"
        ? "became_forbidden"
        : "became_unavailable";
    add(kind, attribution, thenBand.status, nowBand.status, statusNote(kind, attribution, nowBand));
  }

  // 2. Denominator.  A new report period moves the anchor even when the range
  //    and status are unchanged, and that is the most common real change: the
  //    band now rests on different numbers.  Missing it would make "the company
  //    filed again" invisible whenever the multiples happened to stay put.
  const thenDenominator = thenBand.denominator;
  const nowDenominator = nowBand.denominator;
  if (
    (thenDenominator === null) !== (nowDenominator === null) ||
    (thenDenominator !== null && nowDenominator !== null &&
      (thenDenominator.basis !== nowDenominator.basis ||
        thenDenominator.reportDate !== nowDenominator.reportDate ||
        thenDenominator.value !== nowDenominator.value))
  ) {
    const filedAgain = Boolean(
      thenDenominator?.reportDate && nowDenominator?.reportDate &&
      nowDenominator.reportDate > thenDenominator.reportDate,
    );
    const basisChanged = Boolean(thenDenominator && nowDenominator && thenDenominator.basis !== nowDenominator.basis);
    const attribution: BandChangeAttribution = basisChanged ? "model" : filedAgain ? "filing" : "unattributed";
    add("denominator_changed", attribution, describeDenominator(thenDenominator), describeDenominator(nowDenominator),
      basisChanged
        ? `${nowBand.key} 的分母口径从 ${thenDenominator?.basis} 改为 ${nowDenominator?.basis}：口径变更，跨版本不可直接比较。`
        : filedAgain
          ? `${nowBand.key} 的分母已换到 ${nowDenominator?.reportDate} 报告期：公司披露了新一期报告，倍数不变但锚点变了。`
          : `${nowBand.key} 的分母数值变化（可能是同一报告期的追溯调整），需人工确认为何变化。`);
  }

  // 3. Multiple range.  `DEFAULT_RANGES` is ours, so a range move is always a
  //    model change; saying otherwise would present our edit as market news.
  const thenRange = thenBand.range;
  const nowRange = nowBand.range;
  const rangeMoved =
    (thenRange === null) !== (nowRange === null) ||
    (thenRange !== null && nowRange !== null && (thenRange.low !== nowRange.low || thenRange.high !== nowRange.high));
  if (rangeMoved && thenBand.status === "available" && nowBand.status === "available") {
    add("range_changed", "model", describeRange(thenBand), describeRange(nowBand),
      `${nowBand.key} 的区间倍数变了：这是估值模型默认值的调整（模型变更），不是公司基本面变化。`);
  }

  // 4. Role.  `primary → auxiliary` moves the weight of a conclusion, so it is
  //    reported even when the numbers are identical.
  if (thenBand.role !== nowBand.role) {
    add("role_changed", "filing", thenBand.role, nowBand.role,
      `${nowBand.key} 从 ${thenBand.role} 变为 ${nowBand.role}：由输入结构决定（如折旧/EBIT 过高时 EV/EBITDA 自动降级）。`);
  }

  return changes;
}

function statusNote(kind: BandChangeKind, attribution: BandChangeAttribution, band: BandSnapshotEntry): string {
  switch (kind) {
    case "became_forbidden":
      return `该方法被原型 ${band.key} 禁用：这是口径规则，不是数据不足。`;
    case "became_available":
      return attribution === "filing"
        ? "新一期报告让分母成立：区间复位，需按新报告期复核。"
        : "输入补齐后区间重新成立；先确认补齐的是财报数据还是行情。";
    default:
      break;
  }
  if (attribution === "price_source") {
    return "只有行情类输入缺失：这是行情源不可用，不是估值变化。";
  }
  if (attribution === "filing") {
    return "新一期报告改变了分母，区间不再成立；按同一口径核对后再用。";
  }
  return "区间不再成立，但快照无法归因（既非行情缺失也非报告期变化），需人工核对。";
}

function describe(entry: BandSnapshotEntry): string {
  if (entry.status !== "available") return entry.status;
  return `${describeRange(entry)}（${entry.role}）`;
}

function describeRange(entry: BandSnapshotEntry): string {
  if (!entry.range) return "—";
  return `${entry.range.low}–${entry.range.high}${entry.unit === "percent" ? "%" : "x"}`;
}

function describeDenominator(denominator: BandSnapshotEntry["denominator"]): string {
  if (!denominator) return "—";
  // Amounts are in statement currency and can be large; the diff is about which
  // anchor was used, so the date and basis carry the meaning and the number is
  // rounded to a readable magnitude.
  return `${denominator.basis}@${denominator.reportDate}（${formatAmount(denominator.value)}）`;
}

function formatAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)} 万`;
  return value.toFixed(2);
}
