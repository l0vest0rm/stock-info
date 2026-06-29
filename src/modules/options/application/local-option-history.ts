import { fetchNasdaqUSOptionChain } from "../../../adapters/eastmoney";
import type { ExternalHttpOptions } from "../../../shared/http";

const HISTORY_DIR = "data/options-history";

export type LocalOptionHistoryContract = {
  symbol: string;
  expiration: string;
  type: "call" | "put";
  strike: number;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  volume: number;
  openInterest: number;
};

export type LocalOptionHistorySnapshot = {
  snapshotAt: string;
  underlyingPrice: number;
  contracts: LocalOptionHistoryContract[];
};

export type LocalOptionHistoryDocument = {
  version: 1;
  code: string;
  source: "nasdaq";
  snapshots: LocalOptionHistorySnapshot[];
};

export type LocalOptionHistoryFileInfo = {
  code: string;
  snapshotCount: number;
  latestSnapshotAt: string;
};

type FsPromisesLike = {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string, encoding: string) => Promise<string>;
  writeFile: (path: string, data: string, encoding?: string) => Promise<void>;
};

function localFs(): FsPromisesLike | null {
  const processObject = (globalThis as { process?: { getBuiltinModule?: (name: string) => any } }).process;
  return processObject?.getBuiltinModule?.("node:fs/promises") ?? null;
}

function normalizedUsCode(raw: string): string {
  const code = String(raw || "").trim().toUpperCase();
  if (!code) {
    return "";
  }
  return code.endsWith(".US") ? code : `${code}.US`;
}

function historyFilePath(code: string): string {
  return `${HISTORY_DIR}/${code.replace(/[^A-Z0-9._-]/gi, "_")}.json`;
}

function emptyHistory(code: string): LocalOptionHistoryDocument {
  return {
    version: 1,
    code,
    source: "nasdaq",
    snapshots: [],
  };
}

function normalizeNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeContract(raw: any): LocalOptionHistoryContract | null {
  const expiration = String(raw?.expiration || "").trim();
  const symbol = String(raw?.symbol || "").trim();
  const type = raw?.type === "put" ? "put" : (raw?.type === "call" ? "call" : "");
  const strike = normalizeNumber(raw?.strike);
  if (!expiration || !symbol || !type || strike <= 0) {
    return null;
  }
  const bid = normalizeNumber(raw?.bid);
  const ask = normalizeNumber(raw?.ask);
  const last = normalizeNumber(raw?.last);
  const mid = normalizeNumber(raw?.mid) || (bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask || last);
  return {
    symbol,
    expiration,
    type,
    strike,
    bid,
    ask,
    last,
    mid,
    volume: Math.trunc(normalizeNumber(raw?.volume)),
    openInterest: Math.trunc(normalizeNumber(raw?.openInterest)),
  };
}

function normalizeSnapshot(raw: any): LocalOptionHistorySnapshot | null {
  const snapshotAt = String(raw?.snapshotAt || "").trim();
  if (!snapshotAt) {
    return null;
  }
  const contracts = Array.isArray(raw?.contracts)
    ? raw.contracts.map(normalizeContract).filter(Boolean) as LocalOptionHistoryContract[]
    : [];
  return {
    snapshotAt,
    underlyingPrice: normalizeNumber(raw?.underlyingPrice),
    contracts,
  };
}

function normalizeHistoryDocument(code: string, raw: any): LocalOptionHistoryDocument {
  const normalizedCode = normalizedUsCode(raw?.code || code);
  const snapshots = Array.isArray(raw?.snapshots)
    ? raw.snapshots.map(normalizeSnapshot).filter(Boolean) as LocalOptionHistorySnapshot[]
    : [];
  snapshots.sort((a, b) => a.snapshotAt.localeCompare(b.snapshotAt));
  return {
    version: 1,
    code: normalizedCode,
    source: "nasdaq",
    snapshots,
  };
}

async function ensureHistoryDir(fs: FsPromisesLike): Promise<void> {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

export async function listLocalOptionHistoryFiles(): Promise<LocalOptionHistoryFileInfo[]> {
  const fs = localFs();
  if (!fs) {
    return [];
  }
  try {
    const names = await fs.readdir(HISTORY_DIR);
    const files = names.filter((name) => name.endsWith(".json")).sort();
    const items: LocalOptionHistoryFileInfo[] = [];
    for (const fileName of files) {
      const code = normalizedUsCode(fileName.replace(/\.json$/i, ""));
      const history = await readLocalOptionHistory(code);
      items.push({
        code: history.code,
        snapshotCount: history.snapshots.length,
        latestSnapshotAt: history.snapshots.at(-1)?.snapshotAt || "",
      });
    }
    return items.sort((a, b) => a.code.localeCompare(b.code));
  } catch {
    return [];
  }
}

export async function readLocalOptionHistory(rawCode: string): Promise<LocalOptionHistoryDocument> {
  const fs = localFs();
  const code = normalizedUsCode(rawCode);
  if (!fs || !code) {
    return emptyHistory(code);
  }
  try {
    const body = await fs.readFile(historyFilePath(code), "utf8");
    return normalizeHistoryDocument(code, JSON.parse(body));
  } catch {
    return emptyHistory(code);
  }
}

export async function collectLocalOptionHistorySnapshot(
  db: D1Database,
  rawCode: string,
  httpOptions?: ExternalHttpOptions,
): Promise<{
  history: LocalOptionHistoryDocument;
  snapshot: LocalOptionHistorySnapshot;
}> {
  const fs = localFs();
  const code = normalizedUsCode(rawCode);
  if (!fs) {
    throw new Error("local file access is unavailable");
  }
  if (!code.endsWith(".US")) {
    throw new Error("US options only supports .US code");
  }
  const chain = await fetchNasdaqUSOptionChain(db, code, httpOptions);
  const snapshot: LocalOptionHistorySnapshot = {
    snapshotAt: new Date().toISOString(),
    underlyingPrice: normalizeNumber(chain.currentPrice),
    contracts: chain.expirations.flatMap((expiration) => [
      ...expiration.calls.map((contract) => ({
        symbol: contract.symbol,
        expiration: expiration.date,
        type: "call" as const,
        strike: normalizeNumber(contract.strike),
        bid: normalizeNumber(contract.bid),
        ask: normalizeNumber(contract.ask),
        last: normalizeNumber(contract.last),
        mid: normalizeNumber(contract.price) || (normalizeNumber(contract.bid) > 0 && normalizeNumber(contract.ask) > 0
          ? (normalizeNumber(contract.bid) + normalizeNumber(contract.ask)) / 2
          : normalizeNumber(contract.bid) || normalizeNumber(contract.ask) || normalizeNumber(contract.last)),
        volume: Math.trunc(normalizeNumber(contract.volume)),
        openInterest: Math.trunc(normalizeNumber(contract.openInterest)),
      })),
      ...expiration.puts.map((contract) => ({
        symbol: contract.symbol,
        expiration: expiration.date,
        type: "put" as const,
        strike: normalizeNumber(contract.strike),
        bid: normalizeNumber(contract.bid),
        ask: normalizeNumber(contract.ask),
        last: normalizeNumber(contract.last),
        mid: normalizeNumber(contract.price) || (normalizeNumber(contract.bid) > 0 && normalizeNumber(contract.ask) > 0
          ? (normalizeNumber(contract.bid) + normalizeNumber(contract.ask)) / 2
          : normalizeNumber(contract.bid) || normalizeNumber(contract.ask) || normalizeNumber(contract.last)),
        volume: Math.trunc(normalizeNumber(contract.volume)),
        openInterest: Math.trunc(normalizeNumber(contract.openInterest)),
      })),
    ]),
  };
  const history = await readLocalOptionHistory(code);
  const nextHistory = normalizeHistoryDocument(code, {
    ...history,
    snapshots: [...history.snapshots, snapshot],
  });
  await ensureHistoryDir(fs);
  await fs.writeFile(historyFilePath(code), `${JSON.stringify(nextHistory, null, 2)}\n`, "utf8");
  return { history: nextHistory, snapshot };
}
