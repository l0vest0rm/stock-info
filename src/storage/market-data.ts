import type { Bindings, FinancialStatement, FundNavRow, KlineBar, StatementType } from "../types";

const KLINE_HISTORY_START = "1990-01-01";

type KlineSnapshot = {
  code: string;
  fq: string;
  source: string;
  updatedAt: number;
  startDate: string | null;
  endDate: string | null;
  rows: KlineBar[];
};

type FundNavSnapshot = {
  code: string;
  source: string;
  updatedAt: number;
  startDate: string | null;
  endDate: string | null;
  rows: FundNavRow[];
};

type FinancialStatementsSnapshot = {
  code: string;
  statementType: StatementType;
  source: string;
  updatedAt: number;
  reportDates: string[];
  rows: FinancialStatement[];
};

function klineSnapshotKey(code: string, fq: string): string {
  return `kline/${fq}/${code}.json`;
}

function fundNavSnapshotKey(code: string): string {
  return `fund-nav/${code}.json`;
}

function financialStatementsSnapshotKey(code: string, statementType: StatementType): string {
  return `financial-statements/${statementType}/${code}.json`;
}

export function fullKlineHistoryStartDate(): string {
  return KLINE_HISTORY_START;
}

export async function getKlineSnapshot(
  env: Pick<Bindings, "MARKET_DATA_BUCKET">,
  code: string,
  fq: string
): Promise<KlineSnapshot | null> {
  const object = await env.MARKET_DATA_BUCKET.get(klineSnapshotKey(code, fq));
  if (!object) {
    return null;
  }
  return (await object.json()) as KlineSnapshot;
}

export async function putKlineSnapshot(
  env: Pick<Bindings, "MARKET_DATA_BUCKET">,
  code: string,
  fq: string,
  rows: KlineBar[]
): Promise<void> {
  const snapshot: KlineSnapshot = {
    code,
    fq,
    source: rows[0]?.source ?? "eastmoney",
    updatedAt: rows[0]?.updatedAt ?? Date.now(),
    startDate: rows[0]?.date ?? null,
    endDate: rows.at(-1)?.date ?? null,
    rows,
  };
  await env.MARKET_DATA_BUCKET.put(klineSnapshotKey(code, fq), JSON.stringify(snapshot), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
  });
}

export function sliceKlineRows(rows: KlineBar[], from: string, to: string): KlineBar[] {
  return rows.filter((row) => row.date >= from && row.date <= to);
}

export async function getFundNavSnapshot(
  env: Pick<Bindings, "MARKET_DATA_BUCKET">,
  code: string
): Promise<FundNavSnapshot | null> {
  const object = await env.MARKET_DATA_BUCKET.get(fundNavSnapshotKey(code));
  if (!object) {
    return null;
  }
  return (await object.json()) as FundNavSnapshot;
}

export async function putFundNavSnapshot(
  env: Pick<Bindings, "MARKET_DATA_BUCKET">,
  code: string,
  rows: FundNavRow[]
): Promise<void> {
  const snapshot: FundNavSnapshot = {
    code,
    source: "eastmoney",
    updatedAt: rows[0]?.updatedAt ?? Date.now(),
    startDate: rows[0]?.date ?? null,
    endDate: rows.at(-1)?.date ?? null,
    rows,
  };
  await env.MARKET_DATA_BUCKET.put(fundNavSnapshotKey(code), JSON.stringify(snapshot), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
  });
}

export function sliceFundNavRows(rows: FundNavRow[], from: string, to: string): FundNavRow[] {
  return rows.filter((row) => row.date >= from && row.date <= to);
}

export async function getFinancialStatementsSnapshot(
  env: Pick<Bindings, "MARKET_DATA_BUCKET">,
  code: string,
  statementType: StatementType
): Promise<FinancialStatementsSnapshot | null> {
  const object = await env.MARKET_DATA_BUCKET.get(financialStatementsSnapshotKey(code, statementType));
  if (!object) {
    return null;
  }
  return (await object.json()) as FinancialStatementsSnapshot;
}

export async function putFinancialStatementsSnapshot(
  env: Pick<Bindings, "MARKET_DATA_BUCKET">,
  code: string,
  statementType: StatementType,
  rows: FinancialStatement[]
): Promise<void> {
  const snapshot: FinancialStatementsSnapshot = {
    code,
    statementType,
    source: rows[0]?.source ?? "eastmoney",
    updatedAt: rows[0]?.updatedAt ?? Date.now(),
    reportDates: rows.map((row) => row.reportDate),
    rows,
  };
  await env.MARKET_DATA_BUCKET.put(financialStatementsSnapshotKey(code, statementType), JSON.stringify(snapshot), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
  });
}

export function snapshotCoversRange(
  snapshot: Pick<KlineSnapshot | FundNavSnapshot, "startDate" | "endDate">,
  from: string,
  to: string
): boolean {
  return Boolean(snapshot.startDate && snapshot.endDate && snapshot.startDate <= from && snapshot.endDate >= to);
}

export function latestUpdatedAt(rows: Array<KlineBar | FundNavRow>): number | undefined {
  return rows.at(-1)?.updatedAt;
}
