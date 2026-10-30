// Offline CLI orchestration only. All financial/domain calculations run in Rust.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
let executable;
function binary() {
  if (executable) return executable;
  if (process.env.STOCK_INFO_ANALYSIS_BINARY) executable = resolve(process.env.STOCK_INFO_ANALYSIS_BINARY);
  else {
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', resolve(root, 'backend/Cargo.toml')], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    executable = resolve(metadata.target_directory, 'debug/stock-info-local');
  }
  if (!existsSync(executable)) throw new Error('Native offline analysis binary is missing; run npm run build:rust first');
  return executable;
}
export function rustAnalysis(input) {
  return JSON.parse(execFileSync(binary(), ['--analysis-json'], {
    cwd: root, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
  }));
}
export const screenValuationCandidate = input => rustAnalysis({ op: 'screen', input });
export const buildPointInTimePeSeries = (statements, marketCaps, options = {}) => rustAnalysis({ op: 'point-in-time', statements, marketCaps, options });
export const snapshotFromReadModel = (readModel, companyId) => rustAnalysis({ op: 'snapshot', readModel, companyId });
export const diffBandSnapshots = (previous, current) => rustAnalysis({ op: 'diff', previous, current });
export const sortedUsableValues = (values, seriesKey) => rustAnalysis({ op: 'usable-values', values, seriesKey });
export const measureBandCoverage = (band, range, sorted) => rustAnalysis({ op: 'band-coverage', band, range, sorted });
// Names/labels are a wire contract, not a parallel implementation of the math.
export const BAND_MULTIPLE_FIELDS = { pe_ttm: { seriesKey: 'peTtm', label: 'PE(TTM)' }, pb: { seriesKey: 'pb', label: 'PB' }, ps_ttm: { seriesKey: 'ps', label: 'PS' } };
export const MIN_MEANINGFUL_COVERAGE = 0.25;

export const quantileOfSorted = (sorted, q) => rustAnalysis({ op: 'quantile', sorted, q });
export const usableMultipleValues = (values, seriesKey) => rustAnalysis({ op: 'filter-values', values, seriesKey });
export const summarizeMultipleDistribution = (values, seriesKey) => rustAnalysis({ op: 'distribution', values, seriesKey });
export const bandExcludesMostHistory = coverage => rustAnalysis({ op: 'excludes-history', coverage });
export function callRustSelftest(name, ...args) {
  const normalized = args.map(arg => typeof arg === 'function'
    ? { __callbackValues: (args[0] ?? []).map(row => arg(row) ?? null) } : arg);
  return rustAnalysis({ op: 'selftest', function: name, args: normalized });
}
